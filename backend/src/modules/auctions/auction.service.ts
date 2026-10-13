import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { getDb, type DB } from '../../database/db.js';
import type { AuctionStatus, Role } from '../../database/types.js';
import { AppError, forbidden } from '../../utils/errors.js';
import { formatMoney } from '../../utils/money.js';
import { logger } from '../../utils/logger.js';
import { CacheKeys, CacheTTL } from '../../cache/keys.js';
import { cacheGetJson, cacheSetJson, cached, currentListGeneration, invalidateAuction, setAuctionSnapshot } from '../../cache/cache.js';
import { recordAudit } from '../../services/audit.js';
import { enqueueEvent } from '../../services/outbox.js';
import { notify, notifyMany } from '../../services/notifications.js';
import { wakeOutboxDispatcher } from '../../workers/outboxDispatcher.js';
import { assertTransition, canSellerCancel, isTerminal, statusOnPublish } from './stateMachine.js';
import { liveState, loadAuctionDetail, lockAuction, summaryQuery, toSummary, type AuctionDetail, type AuctionSummary } from './auction.repository.js';
import type { BrowseQuery, CreateAuctionBody, UpdateAuctionBody } from './auction.schemas.js';

export interface Actor {
  id: number;
  role: Role;
}

const MIN_DURATION_MS = 60_000; // 1 minute — short enough for live demos
const MAX_DURATION_MS = 30 * 86_400_000; // 30 days

async function dbNow(db: DB): Promise<Date> {
  const { rows } = await sql<{ now: Date }>`SELECT UTC_TIMESTAMP(3) AS now`.execute(db);
  return rows[0]!.now;
}

function validateWindow(start: Date, end: Date, now: Date, { allowPastStart }: { allowPastStart: boolean }) {
  if (end.getTime() - start.getTime() < MIN_DURATION_MS) {
    throw new AppError('VALIDATION_ERROR', 'Auction must run for at least 1 minute', [{ path: 'endTime', message: 'End time must be at least 1 minute after start time' }]);
  }
  if (end.getTime() - start.getTime() > MAX_DURATION_MS) {
    throw new AppError('VALIDATION_ERROR', 'Auction can run for at most 30 days', [{ path: 'endTime', message: 'Maximum duration is 30 days' }]);
  }
  if (end.getTime() <= now.getTime() + MIN_DURATION_MS) {
    throw new AppError('VALIDATION_ERROR', 'End time must be at least 1 minute in the future', [{ path: 'endTime', message: 'End time is too soon' }]);
  }
  if (!allowPastStart && start.getTime() < now.getTime() - 5 * 60_000) {
    throw new AppError('VALIDATION_ERROR', 'Start time cannot be in the past', [{ path: 'startTime', message: 'Start time is in the past' }]);
  }
}

async function assertCategory(db: DB, categoryId: number) {
  const c = await db.selectFrom('categories').select('id').where('id', '=', categoryId).executeTakeFirst();
  if (!c) throw new AppError('VALIDATION_ERROR', 'Unknown category', [{ path: 'categoryId', message: 'Category does not exist' }]);
}

/** Only images uploaded through our own endpoint (or bundled seed art) may be attached. */
function assertImageUrls(urls: string[]) {
  for (const u of urls) {
    if (!/^\/(uploads|static\/seed)\/[A-Za-z0-9._-]+$/.test(u)) {
      throw new AppError('VALIDATION_ERROR', 'Invalid image URL', [{ path: 'imageUrls', message: `Not an uploaded image: ${u}` }]);
    }
  }
}

async function replaceImages(trx: DB, auctionId: number, urls: string[], title: string) {
  await trx.deleteFrom('auction_images').where('auction_id', '=', auctionId).execute();
  if (urls.length) {
    await trx
      .insertInto('auction_images')
      .values(urls.map((url, i) => ({ auction_id: auctionId, image_url: url, alt_text: `${title} — image ${i + 1}`, display_order: i })))
      .execute();
  }
}

// ─── Write side ────────────────────────────────────────────────────────────────────────────────

export async function createAuction(actor: Actor, body: CreateAuctionBody): Promise<AuctionDetail> {
  const db = getDb();
  await assertCategory(db, body.categoryId);
  assertImageUrls(body.imageUrls);
  const now = await dbNow(db);
  if (body.publish) validateWindow(body.startTime, body.endTime, now, { allowPastStart: false });
  else if (body.endTime <= body.startTime) {
    throw new AppError('VALIDATION_ERROR', 'End time must be after start time', [{ path: 'endTime', message: 'End time must be after start time' }]);
  }

  const id = await db.transaction().execute(async (trx) => {
    const res = await trx
      .insertInto('auctions')
      .values({
        seller_id: actor.id,
        category_id: body.categoryId,
        title: body.title,
        description: body.description,
        starting_price: formatMoney(body.startingPrice),
        minimum_bid_increment: formatMoney(body.minimumBidIncrement),
        start_time: body.startTime,
        end_time: body.endTime,
        original_end_time: body.endTime,
        status: 'DRAFT',
      })
      .executeTakeFirstOrThrow();
    const auctionId = Number(res.insertId);
    await replaceImages(trx, auctionId, body.imageUrls, body.title);
    await recordAudit(trx, { actorId: actor.id, action: 'AUCTION_CREATED', entityType: 'auction', entityId: auctionId, metadata: { title: body.title } });
    return auctionId;
  });

  if (body.publish) return publishAuction(actor, id);
  return (await loadAuctionDetail(db, id))!;
}

export async function updateAuction(actor: Actor, auctionId: number, body: UpdateAuctionBody): Promise<AuctionDetail> {
  const db = getDb();
  if (body.categoryId) await assertCategory(db, body.categoryId);
  if (body.imageUrls) assertImageUrls(body.imageUrls);

  const version = await db.transaction().execute(async (trx) => {
    const a = await lockAuction(trx, auctionId);
    if (!a) throw new AppError('AUCTION_NOT_FOUND', 'Auction not found');
    // IDOR protection: ownership is checked against the row, not trusted from the request.
    if (a.seller_id !== actor.id && actor.role !== 'ADMIN') throw forbidden('You can only edit your own auctions');
    if (a.status !== 'DRAFT' && a.status !== 'SCHEDULED') {
      throw new AppError('INVALID_STATE_TRANSITION', 'Only draft or scheduled auctions can be edited');
    }
    const start = body.startTime ?? a.start_time;
    const end = body.endTime ?? a.end_time;
    if (a.status === 'SCHEDULED') validateWindow(start, end, a.db_now, { allowPastStart: false });
    else if (end <= start) throw new AppError('VALIDATION_ERROR', 'End time must be after start time');

    const v = a.version + 1;
    await trx
      .updateTable('auctions')
      .set({
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.categoryId !== undefined ? { category_id: body.categoryId } : {}),
        ...(body.startingPrice !== undefined ? { starting_price: formatMoney(body.startingPrice) } : {}),
        ...(body.minimumBidIncrement !== undefined ? { minimum_bid_increment: formatMoney(body.minimumBidIncrement) } : {}),
        ...(body.startTime !== undefined ? { start_time: body.startTime } : {}),
        ...(body.endTime !== undefined ? { end_time: body.endTime, original_end_time: body.endTime } : {}),
        version: v,
      })
      .where('id', '=', auctionId)
      .execute();
    if (body.imageUrls) await replaceImages(trx, auctionId, body.imageUrls, body.title ?? a.title);
    await recordAudit(trx, { actorId: actor.id, action: 'AUCTION_UPDATED', entityType: 'auction', entityId: auctionId, metadata: { fields: Object.keys(body) } });
    return v;
  });
  await invalidateAuction(auctionId, version);
  return (await loadAuctionDetail(db, auctionId))!;
}

/**
 * DRAFT → SCHEDULED (start in the future) or DRAFT → ACTIVE (start now/past).
 * Listings are auto-approved on publish (moderation_status=APPROVED); admins can reject them later.
 */
export async function publishAuction(actor: Actor, auctionId: number): Promise<AuctionDetail> {
  const db = getDb();
  const version = await db.transaction().execute(async (trx) => {
    const a = await lockAuction(trx, auctionId);
    if (!a) throw new AppError('AUCTION_NOT_FOUND', 'Auction not found');
    if (a.seller_id !== actor.id && actor.role !== 'ADMIN') throw forbidden('You can only publish your own auctions');
    const imageCount = await trx.selectFrom('auction_images').select((eb) => eb.fn.countAll<number>().as('n')).where('auction_id', '=', a.id).executeTakeFirstOrThrow();
    if (Number(imageCount.n) === 0) throw new AppError('VALIDATION_ERROR', 'Add at least one image before publishing');

    validateWindow(a.start_time, a.end_time, a.db_now, { allowPastStart: true });
    const next = statusOnPublish(a.start_time, a.db_now);
    assertTransition(a.status, next);
    const v = a.version + 1;
    await trx
      .updateTable('auctions')
      .set({ status: next, moderation_status: 'APPROVED', version: v })
      .where('id', '=', a.id)
      .execute();
    if (next === 'ACTIVE') {
      await enqueueEvent(trx, { type: 'auction:started', auctionId: a.id, version: v, occurredAt: a.db_now, data: { state: liveState({ ...a, status: 'ACTIVE' }, null) } });
    }
    await notify(
      trx,
      {
        userId: a.seller_id,
        type: 'LISTING_APPROVED',
        title: next === 'ACTIVE' ? 'Your listing is live' : 'Your listing is scheduled',
        message: next === 'ACTIVE' ? `“${a.title}” is now accepting bids.` : `“${a.title}” will open for bidding at its start time.`,
        auctionId: a.id,
      },
      a.db_now,
    );
    await recordAudit(trx, { actorId: actor.id, action: 'AUCTION_PUBLISHED', entityType: 'auction', entityId: a.id, metadata: { status: next } });
    return v;
  });
  await invalidateAuction(auctionId, version);
  wakeOutboxDispatcher();
  return (await loadAuctionDetail(db, auctionId))!;
}

/**
 * Cancels an auction under the row lock, so it cannot interleave with a bid or the closing worker.
 * `asRejection` is the admin moderation path (notifies LISTING_REJECTED instead of a plain cancel).
 */
export async function cancelAuction(actor: Actor, auctionId: number, reason: string, opts: { asRejection?: boolean } = {}): Promise<AuctionDetail> {
  const db = getDb();
  const version = await db.transaction().execute(async (trx) => {
    const a = await lockAuction(trx, auctionId);
    if (!a) throw new AppError('AUCTION_NOT_FOUND', 'Auction not found');
    const isAdmin = actor.role === 'ADMIN';
    if (!isAdmin) {
      if (a.seller_id !== actor.id) throw forbidden('You can only cancel your own auctions');
      if (!canSellerCancel(a.status, a.bid_count)) {
        throw new AppError('INVALID_STATE_TRANSITION', isTerminal(a.status) ? `Auction is already ${a.status.toLowerCase()}` : 'Live auctions with bids can only be cancelled by an administrator');
      }
    }
    assertTransition(a.status, 'CANCELLED');
    const v = a.version + 1;
    await trx
      .updateTable('auctions')
      .set({ status: 'CANCELLED', cancel_reason: reason, version: v, ...(opts.asRejection ? { moderation_status: 'REJECTED' as const } : {}) })
      .where('id', '=', a.id)
      .execute();
    await enqueueEvent(trx, { type: 'auction:cancelled', auctionId: a.id, version: v, occurredAt: a.db_now, data: { state: liveState({ ...a, status: 'CANCELLED' }, null), reason } });

    const audience = await sql<{ user_id: number }>`
      SELECT user_id FROM watchlist WHERE auction_id = ${a.id}
      UNION SELECT DISTINCT bidder_id AS user_id FROM bids WHERE auction_id = ${a.id}`.execute(trx);
    await notifyMany(
      trx,
      audience.rows.map((r) => r.user_id).filter((id) => id !== a.seller_id),
      { type: 'AUCTION_CANCELLED', title: 'Auction cancelled', message: `“${a.title}” was cancelled: ${reason}`, auctionId: a.id },
      a.db_now,
    );
    if (isAdmin && a.seller_id !== actor.id) {
      await notify(
        trx,
        {
          userId: a.seller_id,
          type: opts.asRejection ? 'LISTING_REJECTED' : 'AUCTION_CANCELLED',
          title: opts.asRejection ? 'Listing rejected' : 'Auction cancelled by an administrator',
          message: `“${a.title}”: ${reason}`,
          auctionId: a.id,
        },
        a.db_now,
      );
    }
    await recordAudit(trx, {
      actorId: actor.id,
      action: opts.asRejection ? 'LISTING_REJECTED' : isAdmin ? 'ADMIN_AUCTION_CANCELLED' : 'AUCTION_CANCELLED',
      entityType: 'auction',
      entityId: a.id,
      metadata: { reason, previousStatus: a.status, bidCount: a.bid_count },
    });
    return v;
  });
  logger.info({ auctionId, actorId: actor.id, reason }, 'auction cancelled');
  await invalidateAuction(auctionId, version);
  wakeOutboxDispatcher();
  return (await loadAuctionDetail(db, auctionId))!;
}

export async function setFeatured(actor: Actor, auctionId: number, isFeatured: boolean) {
  const db = getDb();
  const version = await db.transaction().execute(async (trx) => {
    const a = await lockAuction(trx, auctionId);
    if (!a) throw new AppError('AUCTION_NOT_FOUND', 'Auction not found');
    const v = a.version + 1;
    await trx.updateTable('auctions').set({ is_featured: isFeatured, version: v }).where('id', '=', auctionId).execute();
    await recordAudit(trx, { actorId: actor.id, action: isFeatured ? 'AUCTION_FEATURED' : 'AUCTION_UNFEATURED', entityType: 'auction', entityId: auctionId });
    return v;
  });
  await invalidateAuction(auctionId, version);
  return (await loadAuctionDetail(db, auctionId))!;
}

// ─── Read side (cache-aside) ───────────────────────────────────────────────────────────────────

/**
 * Auction detail with versioned cache-aside.
 * Drafts are never cached (they are private), and only the seller/admin may see them.
 */
export async function getAuctionDetail(auctionId: number, viewer?: Actor): Promise<AuctionDetail> {
  const key = CacheKeys.auctionDetail(auctionId);
  let detail = await cacheGetJson<AuctionDetail>(key, 'auction');
  if (!detail) {
    detail = await loadAuctionDetail(getDb(), auctionId);
    if (!detail) throw new AppError('AUCTION_NOT_FOUND', 'Auction not found');
    if (detail.status !== 'DRAFT') await setAuctionSnapshot(auctionId, detail);
  }
  if (detail.status === 'DRAFT' && viewer?.id !== detail.seller.id && viewer?.role !== 'ADMIN') {
    throw new AppError('AUCTION_NOT_FOUND', 'Auction not found'); // 404, not 403: do not reveal drafts exist
  }
  return detail;
}

/** Same visibility rules, straight from MySQL. Used only by the benchmark's cache-bypass mode. */
export async function getAuctionDetailUncached(auctionId: number, viewer?: Actor): Promise<AuctionDetail> {
  const detail = await loadAuctionDetail(getDb(), auctionId);
  if (!detail || (detail.status === 'DRAFT' && viewer?.id !== detail.seller.id && viewer?.role !== 'ADMIN')) {
    throw new AppError('AUCTION_NOT_FOUND', 'Auction not found');
  }
  return detail;
}

const SORTS = {
  ending_soon: [sql`a.status = 'ACTIVE' DESC`, sql`a.end_time ASC`],
  newest: [sql`a.created_at DESC`],
  price_asc: [sql`COALESCE(a.current_highest_bid, a.starting_price) ASC`],
  price_desc: [sql`COALESCE(a.current_highest_bid, a.starting_price) DESC`],
  most_bids: [sql`a.bid_count DESC`],
} as const;

/** Escapes LIKE wildcards so a search for "100%" matches literally. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

export async function browseAuctions(q: BrowseQuery): Promise<{ items: AuctionSummary[]; total: number }> {
  const statuses: AuctionStatus[] = q.status === 'ALL' ? ['ACTIVE', 'SCHEDULED', 'COMPLETED'] : [q.status];
  const load = async () => {
    const db = getDb();
    let base = summaryQuery(db).where('a.status', 'in', statuses);
    if (q.category) base = base.where('c.slug', '=', q.category);
    if (q.q) base = base.where('a.title', 'like', `%${likeEscape(q.q)}%`);
    if (q.minPrice !== undefined) base = base.where(sql`COALESCE(a.current_highest_bid, a.starting_price)`, '>=', formatMoney(q.minPrice));
    if (q.maxPrice !== undefined) base = base.where(sql`COALESCE(a.current_highest_bid, a.starting_price)`, '<=', formatMoney(q.maxPrice));
    if (q.featured) base = base.where('a.is_featured', '=', 1);
    if (q.sellerId) base = base.where('a.seller_id', '=', q.sellerId);

    const countRow = await base
      .clearSelect()
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow();
    let page = base;
    for (const o of SORTS[q.sort]) page = page.orderBy(o);
    const rows = await page.orderBy('a.id', 'desc').limit(q.pageSize).offset((q.page - 1) * q.pageSize).execute();
    return { items: rows.map(toSummary), total: Number(countRow.n) };
  };

  // Browse results are cached briefly under a key that embeds the list "generation". Any change that
  // could affect listings bumps the generation, orphaning every cached page at once (no key scans).
  const gen = await currentListGeneration();
  if (gen < 0) return load();
  const hash = createHash('sha1').update(JSON.stringify(q)).digest('hex').slice(0, 16);
  const key = CacheKeys.browse(gen, hash);
  const hit = await cacheGetJson<{ items: AuctionSummary[]; total: number }>(key, 'browse');
  if (hit) return hit;
  const fresh = await load();
  await cacheSetJson(key, fresh, CacheTTL.browse, 'browse');
  return fresh;
}

export function featuredAuctions(): Promise<AuctionSummary[]> {
  return cached(CacheKeys.featured(), CacheTTL.featured, 'featured', async () => {
    const rows = await summaryQuery(getDb())
      .where('a.status', 'in', ['ACTIVE', 'SCHEDULED'])
      .where('a.is_featured', '=', 1)
      .orderBy(sql`a.status = 'ACTIVE' DESC`)
      .orderBy('a.end_time', 'asc')
      .limit(8)
      .execute();
    return rows.map(toSummary);
  });
}

export function publicStats() {
  return cached(CacheKeys.publicStats(), CacheTTL.publicStats, 'stats', async () => {
    const { rows } = await sql<{ live: number; bids_today: number; completed: number; collectors: number }>`
      SELECT (SELECT COUNT(*) FROM auctions WHERE status = 'ACTIVE') AS live,
             (SELECT COUNT(*) FROM bids WHERE created_at >= UTC_TIMESTAMP(3) - INTERVAL 1 DAY) AS bids_today,
             (SELECT COUNT(*) FROM auctions WHERE status = 'COMPLETED') AS completed,
             (SELECT COUNT(*) FROM users WHERE status = 'ACTIVE') AS collectors`.execute(getDb());
    const r = rows[0]!;
    return { liveAuctions: Number(r.live), bidsLast24h: Number(r.bids_today), completedAuctions: Number(r.completed), members: Number(r.collectors) };
  });
}
