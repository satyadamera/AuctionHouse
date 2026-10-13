/**
 * Auction lifecycle worker: SCHEDULED → ACTIVE, "ending soon" alerts, ACTIVE → COMPLETED.
 *
 * Design rules
 * - The browser countdown never closes an auction. Only this worker (or a bid's lazy activation)
 *   changes lifecycle state, always on the server and always with the database clock.
 * - Every transition locks the auction row with the SAME `SELECT … FOR UPDATE` the bid path uses,
 *   then re-checks the condition. So a bid and a close for one auction are strictly serialised:
 *     • close first  → the bid then sees status COMPLETED and is rejected;
 *     • bid first    → the close then sees the new highest bidder and declares them the winner
 *                      (or, with anti-sniping, sees the extended end_time and does nothing yet).
 * - Transitions are idempotent: re-running on an already-completed auction is a no-op. That makes it
 *   safe to run several workers (multiple API instances) and to restart at any time — on boot the
 *   first tick closes everything that ended while the server was down.
 * - A late worker cannot let a bid in after end_time: the bid path checks `now < end_time` itself.
 */
import { sql } from 'kysely';
import { env } from '../config/env.js';
import { getDb, type DB } from '../database/db.js';
import { logger } from '../utils/logger.js';
import { formatMoney } from '../utils/money.js';
import { invalidateAuction } from '../cache/cache.js';
import { enqueueEvent } from '../services/outbox.js';
import { formatInr, notify, notifyMany } from '../services/notifications.js';
import { recordAudit } from '../services/audit.js';
import { liveState, lockAuction, publicName } from '../modules/auctions/auction.repository.js';
import { wakeOutboxDispatcher } from './outboxDispatcher.js';

const BATCH = 50;

async function dueIds(query: ReturnType<typeof sql<{ id: number }>>): Promise<number[]> {
  const { rows } = await query.execute(getDb());
  return rows.map((r) => r.id);
}

/** Activates one scheduled auction if (and only if) its start time has passed. */
export async function activateAuction(auctionId: number): Promise<boolean> {
  const db = getDb();
  const changed = await db.transaction().execute(async (trx) => {
    const a = await lockAuction(trx, auctionId);
    if (!a || a.status !== 'SCHEDULED' || a.start_time > a.db_now) return null; // already handled / not yet due
    if (a.end_time <= a.db_now) {
      // Both start and end passed while we were down: it never ran, close it straight away.
      return { version: -1 };
    }
    const version = a.version + 1;
    await trx.updateTable('auctions').set({ status: 'ACTIVE', version }).where('id', '=', a.id).execute();
    await enqueueEvent(trx, {
      type: 'auction:started',
      auctionId: a.id,
      version,
      occurredAt: a.db_now,
      data: { state: liveState({ ...a, status: 'ACTIVE' }, null) },
    });
    await recordAudit(trx, { actorId: null, action: 'AUCTION_STARTED', entityType: 'auction', entityId: a.id });
    return { version };
  });
  if (!changed) return false;
  if (changed.version === -1) return closeAuction(auctionId);
  logger.info({ auctionId, version: changed.version }, 'auction started');
  await invalidateAuction(auctionId, changed.version);
  wakeOutboxDispatcher();
  return true;
}

/**
 * Closes one auction if (and only if) it is still ACTIVE/SCHEDULED and its end time has passed.
 * Determines the winner from the locked row and persists everything in one transaction.
 */
export async function closeAuction(auctionId: number): Promise<boolean> {
  const db = getDb();
  const result = await db.transaction().execute(async (trx) => {
    // Same lock as placeBid(): an in-flight bid for this auction finishes (commit) before we read.
    const a = await lockAuction(trx, auctionId);
    if (!a) return null;
    if (a.status !== 'ACTIVE' && a.status !== 'SCHEDULED') return null; // already closed/cancelled — idempotent no-op
    if (a.end_time > a.db_now) return null; // not due (e.g. anti-sniping extended it while we waited for the lock)

    // Cross-check the denormalised summary against the bids table. They are maintained together
    // under this lock so they must agree; a mismatch would indicate a bug, and the bids table wins.
    const top = await trx
      .selectFrom('bids')
      .select(['bidder_id', 'amount'])
      .where('auction_id', '=', a.id)
      .orderBy('amount', 'desc')
      .orderBy('id', 'asc')
      .limit(1)
      .executeTakeFirst();
    let winnerId = a.current_highest_bidder_id;
    let finalPrice = a.current_highest_bid;
    if ((top?.bidder_id ?? null) !== winnerId || (top && finalPrice && formatMoney(top.amount) !== formatMoney(finalPrice))) {
      logger.error({ auctionId, summary: { winnerId, finalPrice }, top }, 'auction summary disagrees with bids table');
      winnerId = top?.bidder_id ?? null;
      finalPrice = top?.amount ?? null;
    }

    const version = a.version + 1;
    await trx
      .updateTable('auctions')
      .set({
        status: 'COMPLETED',
        winner_id: winnerId,
        final_price: finalPrice,
        // Also repair the summary if the cross-check above found a disagreement.
        current_highest_bid: finalPrice,
        current_highest_bidder_id: winnerId,
        completed_at: a.db_now,
        version,
      })
      .where('id', '=', a.id)
      .execute();

    const winner = winnerId ? await trx.selectFrom('users').select(['id', 'name']).where('id', '=', winnerId).executeTakeFirst() : undefined;
    const winnerPublic = winner ? { id: winner.id, name: publicName(winner.name) } : null;
    const state = liveState({ ...a, status: 'COMPLETED' }, winnerPublic);

    await enqueueEvent(trx, {
      type: 'auction:ended',
      auctionId: a.id,
      version,
      occurredAt: a.db_now,
      data: { state, winner: winnerPublic, finalPrice: finalPrice ? formatMoney(finalPrice) : null },
    });

    if (winnerId && finalPrice) {
      await notify(trx, { userId: winnerId, type: 'AUCTION_WON', title: 'You won!', message: `You won “${a.title}” for ${formatInr(finalPrice)}.`, auctionId: a.id }, a.db_now);
      await notify(trx, { userId: a.seller_id, type: 'AUCTION_SOLD', title: 'Your item sold', message: `“${a.title}” sold for ${formatInr(finalPrice)}.`, auctionId: a.id }, a.db_now);
      const losers = await trx
        .selectFrom('bids')
        .select('bidder_id')
        .distinct()
        .where('auction_id', '=', a.id)
        .where('bidder_id', '!=', winnerId)
        .execute();
      await notifyMany(
        trx,
        losers.map((l) => l.bidder_id),
        { type: 'AUCTION_LOST', title: 'Auction ended', message: `“${a.title}” ended. The winning bid was ${formatInr(finalPrice)}.`, auctionId: a.id },
        a.db_now,
      );
    } else {
      await notify(trx, { userId: a.seller_id, type: 'AUCTION_ENDED_NO_BIDS', title: 'Auction ended without bids', message: `“${a.title}” ended with no bids.`, auctionId: a.id }, a.db_now);
    }
    await recordAudit(trx, {
      actorId: null,
      action: 'AUCTION_COMPLETED',
      entityType: 'auction',
      entityId: a.id,
      metadata: { winnerId, finalPrice, bidCount: a.bid_count },
    });
    return { version, winnerId };
  });
  if (!result) return false;
  logger.info({ auctionId, winnerId: result.winnerId, version: result.version }, 'auction completed');
  await invalidateAuction(auctionId, result.version);
  wakeOutboxDispatcher();
  return true;
}

/** Sends a one-time "ending soon" alert to watchers and bidders. Does not change auction state. */
export async function notifyEndingSoon(auctionId: number): Promise<boolean> {
  const db = getDb();
  const sent = await db.transaction().execute(async (trx) => {
    const a = await lockAuction(trx, auctionId);
    if (!a || a.status !== 'ACTIVE' || a.ending_soon_notified_at) return false;
    const secondsRemaining = Math.max(0, Math.round((a.end_time.getTime() - a.db_now.getTime()) / 1000));
    if (secondsRemaining <= 0 || secondsRemaining > env.ENDING_SOON_SECONDS) return false;
    await trx.updateTable('auctions').set({ ending_soon_notified_at: a.db_now }).where('id', '=', a.id).execute();
    const audience = await sql<{ user_id: number }>`
      SELECT user_id FROM watchlist WHERE auction_id = ${a.id}
      UNION
      SELECT DISTINCT bidder_id AS user_id FROM bids WHERE auction_id = ${a.id}`.execute(trx);
    const minutes = Math.round(secondsRemaining / 60);
    const when = secondsRemaining < 60 ? 'in under a minute' : `in about ${minutes} minute${minutes === 1 ? '' : 's'}`;
    await notifyMany(
      trx as unknown as DB,
      audience.rows.map((r) => r.user_id).filter((id) => id !== a.seller_id),
      { type: 'AUCTION_ENDING_SOON', title: 'Ending soon', message: `“${a.title}” ends ${when}.`, auctionId: a.id },
      a.db_now,
    );
    // Not a state change, so no version bump: version stays the current one.
    await enqueueEvent(trx, {
      type: 'auction:ending_soon',
      auctionId: a.id,
      version: a.version,
      occurredAt: a.db_now,
      data: { endTime: a.end_time.toISOString(), secondsRemaining },
    });
    return true;
  });
  if (sent) wakeOutboxDispatcher();
  return sent;
}

/** One pass over everything that is due. Exported so tests and demos can drive it deterministically. */
export async function runLifecycleOnce(): Promise<{ started: number; endingSoon: number; completed: number }> {
  const out = { started: 0, endingSoon: 0, completed: 0 };
  // Candidate queries are plain (non-locking) indexed reads; each candidate is then locked and
  // re-checked individually, so a stale candidate list is harmless.
  for (const id of await dueIds(sql<{ id: number }>`
      SELECT id FROM auctions WHERE status = 'SCHEDULED' AND start_time <= UTC_TIMESTAMP(3) ORDER BY start_time LIMIT ${BATCH}`)) {
    if (await activateAuction(id)) out.started++;
  }
  for (const id of await dueIds(sql<{ id: number }>`
      SELECT id FROM auctions WHERE status = 'ACTIVE' AND end_time <= UTC_TIMESTAMP(3) ORDER BY end_time LIMIT ${BATCH}`)) {
    if (await closeAuction(id)) out.completed++;
  }
  for (const id of await dueIds(sql<{ id: number }>`
      SELECT id FROM auctions
       WHERE status = 'ACTIVE' AND ending_soon_notified_at IS NULL
         AND end_time > UTC_TIMESTAMP(3) AND end_time <= UTC_TIMESTAMP(3) + INTERVAL ${env.ENDING_SOON_SECONDS} SECOND
       ORDER BY end_time LIMIT ${BATCH}`)) {
    if (await notifyEndingSoon(id)) out.endingSoon++;
  }
  return out;
}

let timer: NodeJS.Timeout | undefined;
let stopped = true;
let busy: Promise<unknown> | undefined;

export function startLifecycleWorker() {
  stopped = false;
  const tick = async () => {
    try {
      busy = runLifecycleOnce();
      await busy;
    } catch (err) {
      logger.error({ err }, 'lifecycle tick failed');
    } finally {
      busy = undefined;
    }
    if (!stopped) timer = setTimeout(tick, env.LIFECYCLE_POLL_MS);
  };
  timer = setTimeout(tick, 0); // immediate first run handles anything that came due while down
  logger.info({ pollMs: env.LIFECYCLE_POLL_MS }, 'lifecycle worker started');
}

export async function stopLifecycleWorker() {
  stopped = true;
  if (timer) clearTimeout(timer);
  await busy?.catch(() => undefined);
}
