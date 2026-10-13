/**
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 *  Concurrency-safe bidding
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The race this prevents (a "lost update"): current highest is ₹10,000. Two requests arrive together.
 *
 *   Request A (₹10,500)                    Request B (₹11,000)
 *   read highest = 10,000                  read highest = 10,000
 *   10,500 ≥ 10,000 + 100 ✓                11,000 ≥ 10,000 + 100 ✓
 *                                          write highest = 11,000
 *   write highest = 10,500   ← lower bid overwrites the higher one; B's bid is silently lost
 *
 * The fix: both requests must read-and-write the auction row as one indivisible step. We get that
 * from MySQL: a transaction that starts with `SELECT … FOR UPDATE` on the auction row. The second
 * request blocks on that SELECT until the first commits, and then reads the NEW highest bid, so its
 * validation runs against the true current state.
 *
 * Exact order inside placeBid():
 *   0. (outside tx) validate amount format/precision/range — cheap, needs no lock
 *   1. BEGIN (READ COMMITTED)
 *   2. SELECT … FOR UPDATE the auction row (+ database clock)            ← serialisation point
 *   3. idempotency lookup for (bidder, clientRequestId)                   ← replay → return original
 *   4. business rules on the LOCKED state: exists, not own auction, status, time window, minimum bid
 *   5. INSERT bid
 *   6. UPDATE auction summary (highest bid, leader, count, version[, end_time]) guarded by version
 *   7. INSERT notifications + outbox events + audit row (same tx → atomic with the bid)
 *   8. COMMIT                                                             ← lock released here
 *   9. (after commit) invalidate Redis cache, wake the outbox dispatcher (→ Socket.IO)
 *
 * Nothing slow or external happens between 1 and 8: no Redis, no sockets, no HTTP. Lock hold time is
 * a handful of indexed single-row statements.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { sql } from 'kysely';
import { Decimal } from 'decimal.js';
import { env } from '../../config/env.js';
import { getDb, isDuplicateKey, mysqlErrno, RETRYABLE_MYSQL_ERRORS, type DB } from '../../database/db.js';
import { AppError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { formatMoney, minimumNextBid, parseAmount } from '../../utils/money.js';
import { invalidateAuction } from '../../cache/cache.js';
import { enqueueEvent } from '../../services/outbox.js';
import { formatInr, notify } from '../../services/notifications.js';
import { recordAudit } from '../../services/audit.js';
import { wakeOutboxDispatcher } from '../../workers/outboxDispatcher.js';
import { isWithinBiddingWindow } from '../auctions/stateMachine.js';
import { liveState, lockAuction, publicName, type LockedAuction } from '../auctions/auction.repository.js';
import type { AuctionLiveState, PublicBid } from '../../shared/events.js';

export interface PlaceBidInput {
  auctionId: number;
  bidderId: number;
  amount: string;
  clientRequestId: string;
}

export interface PlaceBidResult {
  bid: PublicBid;
  state: AuctionLiveState;
  version: number;
  /** true when this request was a retry of an already-accepted bid (no new bid was created). */
  replayed: boolean;
  extended: boolean;
}

/**
 * Test-only hooks for deterministic concurrency tests. `afterLock` runs while the row lock is held,
 * letting a test pause transaction A and prove that transaction B is blocked until A commits.
 * Ignored outside NODE_ENV=test.
 */
export const bidTestHooks: { afterLock?: (auctionId: number, bidderId: number) => Promise<void> } = {};

const MAX_ATTEMPTS = 3;

/**
 * Runs `fn` in a fresh transaction, retrying the WHOLE transaction on deadlock (1213) or lock-wait
 * timeout (1205). This is safe because MySQL has already rolled the failed attempt back, so a retry
 * starts from a clean slate and re-reads everything; the idempotency key guarantees a retry can never
 * insert a second bid. Backoff is exponential with jitter so colliding retries do not collide again.
 */
export async function withTransactionRetry<T>(db: DB, label: string, fn: (trx: DB) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await db
        .transaction()
        // READ COMMITTED: every statement sees the latest COMMITTED data. Combined with the row lock,
        // the idempotency lookup in step 3 sees a bid committed by a concurrent duplicate request
        // the instant that request releases the lock. (Locking reads are always "current" in InnoDB,
        // but plain SELECTs under REPEATABLE READ could otherwise reuse an older snapshot.)
        .setIsolationLevel('read committed')
        .execute((trx) => fn(trx as unknown as DB));
    } catch (err) {
      const errno = mysqlErrno(err);
      if (errno !== undefined && RETRYABLE_MYSQL_ERRORS.has(errno)) {
        if (attempt >= MAX_ATTEMPTS) {
          logger.error({ label, attempt, errno }, 'transaction retries exhausted');
          throw new AppError('CONFLICT_RETRY_EXHAUSTED', 'The auction is very busy right now — please try again');
        }
        const backoff = 15 * 2 ** attempt + Math.floor(Math.random() * 25);
        logger.warn({ label, attempt, errno, backoff }, 'retryable transaction conflict');
        await sleep(backoff);
        continue;
      }
      throw err;
    }
  }
}

/**
 * Places a bid.
 *
 * @param input.amount         Decimal string with ≤ 2 decimals (validated here, not trusted from UI).
 * @param input.clientRequestId Idempotency key. Same key + same auction + same amount → the original
 *                             result is returned (`replayed: true`). Same key with different
 *                             parameters → IDEMPOTENCY_KEY_REUSED.
 * @returns The accepted bid and the auction's live state AFTER it, at `version`.
 * @throws AppError with codes AUCTION_NOT_FOUND | SELF_BIDDING_NOT_ALLOWED | AUCTION_NOT_ACTIVE |
 *         AUCTION_NOT_STARTED | AUCTION_ENDED | BID_TOO_LOW | INVALID_BID_AMOUNT |
 *         IDEMPOTENCY_KEY_REUSED | CONFLICT_RETRY_EXHAUSTED
 *
 * Invariants guaranteed on commit:
 *   I1  auctions.current_highest_bid = MAX(bids.amount) for that auction
 *   I2  bids for an auction are strictly increasing in id order (each ≥ previous + increment)
 *   I3  auctions.bid_count = COUNT(bids)
 *   I4  no bid has created_at ≥ the auction's end_time, and none exists for a COMPLETED auction
 *       after its completion
 */
export async function placeBid(input: PlaceBidInput): Promise<PlaceBidResult> {
  // ── Step 0: input validation (no lock needed; depends only on the request) ──────────────────
  const parsed = parseAmount(input.amount);
  if (!parsed.ok) throw new AppError('INVALID_BID_AMOUNT', parsed.reason);
  const amount = parsed.value;
  const db = getDb();

  let result: PlaceBidResult;
  try {
    result = await withTransactionRetry(db, 'placeBid', (trx) => attemptBid(trx, input, amount));
  } catch (err) {
    // A concurrent duplicate that targeted a DIFFERENT auction is not serialised by our row lock;
    // the unique index (bidder_id, client_request_id) is the backstop. Resolve it like a replay.
    if (isDuplicateKey(err, 'uq_bids_bidder_request')) {
      return resolveDuplicate(db, input, amount);
    }
    if (err instanceof AppError) {
      logger.info({ auctionId: input.auctionId, bidderId: input.bidderId, amount: input.amount, code: err.code }, 'bid rejected');
    }
    throw err;
  }

  // ── Step 9: post-commit side effects. The bid is already durable; failures here never undo it. ──
  if (!result.replayed) {
    logger.info(
      { auctionId: input.auctionId, bidderId: input.bidderId, amount: result.bid.amount, version: result.version },
      'bid accepted',
    );
    // Invalidate AFTER commit. Before commit, a concurrent reader could re-cache the old row.
    await invalidateAuction(input.auctionId, result.version);
    // Socket.IO delivery happens in the outbox dispatcher (durable, retried); this just runs it now
    // instead of waiting for the next poll tick, keeping live latency low.
    wakeOutboxDispatcher();
  }
  return result;
}

async function attemptBid(trx: DB, input: PlaceBidInput, amount: Decimal): Promise<PlaceBidResult> {
  // ── Step 2: acquire the exclusive row lock and read the CURRENT state + database clock ───────
  const auction = await lockAuction(trx, input.auctionId);
  if (!auction) throw new AppError('AUCTION_NOT_FOUND', 'Auction not found');
  if (env.isTest && bidTestHooks.afterLock) await bidTestHooks.afterLock(input.auctionId, input.bidderId);

  // ── Step 3: idempotency ──────────────────────────────────────────────────────────────────────
  // Checked BEFORE the business rules on purpose: if the original request already succeeded, the
  // auction's highest bid now equals this amount, so re-running "amount ≥ highest + increment" would
  // wrongly reject a harmless network retry with BID_TOO_LOW. A replay must get the original answer.
  // Two concurrent requests with the same key on the same auction queue on the row lock, so the
  // second one is guaranteed to see the first one's committed bid here.
  const existing = await trx
    .selectFrom('bids')
    .select(['id', 'auction_id', 'amount', 'created_at'])
    .where('bidder_id', '=', input.bidderId)
    .where('client_request_id', '=', input.clientRequestId)
    .executeTakeFirst();
  if (existing) return replayResult(trx, existing, input, amount, auction);

  // ── Step 4: business rules, evaluated against the LOCKED (authoritative) state ─────────────────
  if (auction.seller_id === input.bidderId) {
    throw new AppError('SELF_BIDDING_NOT_ALLOWED', 'You cannot bid on your own auction');
  }
  const now = auction.db_now;
  switch (auction.status) {
    case 'DRAFT':
      throw new AppError('AUCTION_NOT_ACTIVE', 'This auction has not been published');
    case 'CANCELLED':
      throw new AppError('AUCTION_NOT_ACTIVE', 'This auction was cancelled');
    case 'COMPLETED':
      throw new AppError('AUCTION_ENDED', 'This auction has ended');
    case 'SCHEDULED':
    case 'ACTIVE':
      break;
  }
  if (now.getTime() < auction.start_time.getTime()) {
    throw new AppError('AUCTION_NOT_STARTED', 'Bidding has not opened yet', { startTime: auction.start_time.toISOString() });
  }
  // The end-time check uses the DATABASE clock and does not depend on status. Even if the lifecycle
  // worker is late and the row still says ACTIVE, a bid at or after end_time is rejected.
  if (!isWithinBiddingWindow(auction.start_time, auction.end_time, now)) {
    throw new AppError('AUCTION_ENDED', 'This auction has ended', { endTime: auction.end_time.toISOString() });
  }
  const minNext = minimumNextBid(auction.starting_price, auction.current_highest_bid, auction.minimum_bid_increment);
  if (amount.lt(minNext)) {
    throw new AppError('BID_TOO_LOW', `Bid must be at least ${formatInr(formatMoney(minNext))}`, {
      minimumNextBid: formatMoney(minNext),
      currentHighestBid: auction.current_highest_bid === null ? null : formatMoney(auction.current_highest_bid),
      version: auction.version,
    });
  }

  // Lazy activation: if the worker has not yet flipped SCHEDULED→ACTIVE but the start time has
  // passed (checked above with the DB clock), the bid itself performs the transition.
  const wasScheduled = auction.status === 'SCHEDULED';

  // Optional anti-sniping: a bid in the final N seconds pushes the end time out. Done inside the
  // same locked transaction, so the closing worker (which takes the same lock) sees the new end time.
  let newEndTime = auction.end_time;
  let extended = false;
  if (env.ANTI_SNIPE_WINDOW_SECONDS > 0) {
    const msLeft = auction.end_time.getTime() - now.getTime();
    if (msLeft <= env.ANTI_SNIPE_WINDOW_SECONDS * 1000) {
      newEndTime = new Date(auction.end_time.getTime() + env.ANTI_SNIPE_EXTENSION_SECONDS * 1000);
      extended = true;
    }
  }

  // ── Step 5: persist the bid ─────────────────────────────────────────────────────────────────
  const amountStr = formatMoney(amount);
  const inserted = await trx
    .insertInto('bids')
    .values({
      auction_id: auction.id,
      bidder_id: input.bidderId,
      amount: amountStr,
      client_request_id: input.clientRequestId,
      created_at: now, // database clock — the same instant the window check used
    })
    .executeTakeFirstOrThrow();
  const bidId = Number(inserted.insertId);

  // ── Step 6: update the denormalised summary ──────────────────────────────────────────────────
  // `version = ?` is defence in depth: we hold the lock, so it can only fail if someone bypassed the
  // lock protocol. If it ever does, we throw and the whole transaction (including the bid) rolls back.
  const newVersion = auction.version + 1;
  const upd = await trx
    .updateTable('auctions')
    .set({
      current_highest_bid: amountStr,
      current_highest_bidder_id: input.bidderId,
      bid_count: sql<number>`bid_count + 1`,
      version: newVersion,
      end_time: newEndTime,
      ...(wasScheduled ? { status: 'ACTIVE' as const } : {}),
    })
    .where('id', '=', auction.id)
    .where('version', '=', auction.version)
    .executeTakeFirst();
  if (Number(upd.numUpdatedRows) !== 1) {
    throw new Error(`auction ${auction.id} changed under lock (expected version ${auction.version})`);
  }

  // ── Step 7: notifications, outbox events and audit — atomic with the bid ─────────────────────
  const bidder = await trx.selectFrom('users').select(['name']).where('id', '=', input.bidderId).executeTakeFirstOrThrow();
  const leader = { id: input.bidderId, name: publicName(bidder.name) };
  const after: LockedAuction = {
    ...auction,
    status: 'ACTIVE',
    current_highest_bid: amountStr,
    current_highest_bidder_id: input.bidderId,
    bid_count: auction.bid_count + 1,
    end_time: newEndTime,
    version: newVersion,
  };
  const state = liveState(after, leader);
  const bid: PublicBid = { id: bidId, amount: amountStr, bidder: leader, createdAt: now.toISOString() };

  // No separate auction:started event on lazy activation: it would share this version number and
  // clients would discard the bid event as a duplicate version. bid_placed carries status ACTIVE.
  await enqueueEvent(trx, { type: 'auction:bid_placed', auctionId: auction.id, version: newVersion, occurredAt: now, data: { bid, state, extended } });
  await enqueueEvent(trx, {
    type: 'auction:price_updated',
    auctionId: auction.id,
    version: newVersion,
    occurredAt: now,
    data: { currentHighestBid: amountStr, bidCount: after.bid_count, endTime: newEndTime.toISOString() },
  });

  await notify(
    trx,
    {
      userId: input.bidderId,
      type: 'BID_ACCEPTED',
      title: 'Bid placed',
      message: `Your bid of ${formatInr(amountStr)} on “${auction.title}” is the highest.`,
      auctionId: auction.id,
    },
    now,
  );
  const previousLeader = auction.current_highest_bidder_id;
  if (previousLeader !== null && previousLeader !== input.bidderId) {
    await notify(
      trx,
      {
        userId: previousLeader,
        type: 'OUTBID',
        title: 'You have been outbid',
        message: `Someone bid ${formatInr(amountStr)} on “${auction.title}”. Bid at least ${formatInr(state.minimumNextBid)} to lead again.`,
        auctionId: auction.id,
      },
      now,
    );
  }
  await recordAudit(trx, {
    actorId: input.bidderId,
    action: 'BID_ACCEPTED',
    entityType: 'bid',
    entityId: bidId,
    metadata: { auctionId: auction.id, amount: amountStr, version: newVersion, extended },
  });

  // ── Step 8: COMMIT happens when this callback returns (Kysely commits; any throw rolls back) ──
  return { bid, state, version: newVersion, replayed: false, extended };
}

async function replayResult(
  trx: DB,
  existing: { id: number; auction_id: number; amount: string; created_at: Date },
  input: PlaceBidInput,
  amount: Decimal,
  auction: LockedAuction,
): Promise<PlaceBidResult> {
  if (existing.auction_id !== input.auctionId || !new Decimal(existing.amount).eq(amount)) {
    throw new AppError('IDEMPOTENCY_KEY_REUSED', 'This clientRequestId was already used for a different bid', {
      originalAuctionId: existing.auction_id,
      originalAmount: formatMoney(existing.amount),
    });
  }
  const [bidder, leader] = await Promise.all([
    trx.selectFrom('users').select(['id', 'name']).where('id', '=', input.bidderId).executeTakeFirstOrThrow(),
    auction.current_highest_bidder_id
      ? trx.selectFrom('users').select(['id', 'name']).where('id', '=', auction.current_highest_bidder_id).executeTakeFirst()
      : Promise.resolve(undefined),
  ]);
  return {
    bid: { id: existing.id, amount: formatMoney(existing.amount), bidder: { id: bidder.id, name: publicName(bidder.name) }, createdAt: existing.created_at.toISOString() },
    // Current state (which may already include later bids by others).
    state: liveState(auction, leader ? { id: leader.id, name: publicName(leader.name) } : null),
    version: auction.version,
    replayed: true,
    extended: false,
  };
}

async function resolveDuplicate(db: DB, input: PlaceBidInput, amount: Decimal): Promise<PlaceBidResult> {
  return db.transaction().execute(async (trx) => {
    const auction = await lockAuction(trx, input.auctionId);
    const existing = await trx
      .selectFrom('bids')
      .select(['id', 'auction_id', 'amount', 'created_at'])
      .where('bidder_id', '=', input.bidderId)
      .where('client_request_id', '=', input.clientRequestId)
      .executeTakeFirstOrThrow();
    if (!auction) throw new AppError('AUCTION_NOT_FOUND', 'Auction not found');
    return replayResult(trx as unknown as DB, existing, input, amount, auction);
  });
}
