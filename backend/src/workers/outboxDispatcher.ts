/**
 * Outbox dispatcher — turns committed outbox rows into Socket.IO events and cache invalidations.
 *
 * Delivery semantics: AT-LEAST-ONCE.
 *   1. Claim a batch of unprocessed rows with `FOR UPDATE SKIP LOCKED` (several API instances can run
 *      dispatchers without double-claiming; a locked row is simply skipped by the others).
 *   2. For each row: invalidate cache (idempotent) and emit to the right room.
 *   3. Mark processed_at and commit.
 * If the process crashes between 2 and 3, the rows are emitted again after restart. That is why every
 * event carries a unique eventId and a version: clients drop duplicates and stale versions.
 *
 * Ordering: rows are emitted in id order within a batch, but a transaction that inserted a smaller id
 * may commit after a larger one is already visible. Clients therefore never trust arrival order; they
 * compare versions and re-fetch from the REST API when they detect a gap.
 */
import { sql } from 'kysely';
import { env } from '../config/env.js';
import { getDb } from '../database/db.js';
import { logger } from '../utils/logger.js';
import { invalidateAuction } from '../cache/cache.js';
import { Rooms, type ServerEvent } from '../shared/events.js';

export interface EventPublisher {
  toRoom(room: string, event: ServerEvent): void;
}

let publisher: EventPublisher | undefined;
let timer: NodeJS.Timeout | undefined;
let running = false;
let rerun = false;
let stopped = true;

export const outboxStats = { dispatched: 0, failed: 0, cycles: 0 };

export function setEventPublisher(p: EventPublisher | undefined) {
  publisher = p;
}

const BATCH = 200;
const MAX_ATTEMPTS = 10;

interface OutboxRow {
  id: number;
  event_id: string;
  type: string;
  auction_id: number | null;
  user_id: number | null;
  version: number | null;
  payload: unknown;
  attempts: number;
}

/** Processes pending events once. Returns how many were dispatched. Safe to call concurrently. */
export async function dispatchOnce(): Promise<number> {
  const db = getDb();
  outboxStats.cycles++;
  return db.transaction().execute(async (trx) => {
    const { rows } = await sql<OutboxRow>`
      SELECT id, event_id, type, auction_id, user_id, version, payload, attempts
        FROM outbox_events
       WHERE processed_at IS NULL AND attempts < ${MAX_ATTEMPTS}
       ORDER BY id
       LIMIT ${BATCH}
         FOR UPDATE SKIP LOCKED`.execute(trx);
    if (!rows.length) return 0;

    const done: number[] = [];
    const invalidated = new Map<number, number>();
    for (const row of rows) {
      try {
        const event = (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as ServerEvent;
        // Cache invalidation is repeated here (the request path already did it right after commit)
        // so that it still happens if that best-effort call failed or the process crashed.
        if (row.auction_id !== null && row.version !== null && row.type !== 'notification:new') {
          const prev = invalidated.get(row.auction_id) ?? 0;
          if (row.version > prev) invalidated.set(row.auction_id, row.version);
        }
        if (publisher) {
          if (row.type === 'notification:new' && row.user_id !== null) {
            publisher.toRoom(Rooms.user(row.user_id), event);
          } else if (row.type === 'auction:price_updated') {
            publisher.toRoom(Rooms.feed, event);
          } else if (row.auction_id !== null) {
            publisher.toRoom(Rooms.auction(row.auction_id), event);
          }
        }
        done.push(row.id);
      } catch (err) {
        outboxStats.failed++;
        logger.error({ err, eventId: row.event_id }, 'outbox dispatch failed');
        await trx
          .updateTable('outbox_events')
          .set({ attempts: row.attempts + 1, last_error: String((err as Error).message).slice(0, 500) })
          .where('id', '=', row.id)
          .execute();
      }
    }
    for (const [auctionId, version] of invalidated) await invalidateAuction(auctionId, version);
    if (done.length) {
      await trx.updateTable('outbox_events').set({ processed_at: new Date(), attempts: sql`attempts + 1` }).where('id', 'in', done).execute();
    }
    outboxStats.dispatched += done.length;
    return done.length;
  });
}

async function cycle() {
  if (running) {
    rerun = true; // coalesce wake-ups that arrive mid-cycle into one more pass
    return;
  }
  running = true;
  try {
    do {
      rerun = false;
      while ((await dispatchOnce()) === BATCH) {
        /* drain backlog */
      }
    } while (rerun);
  } catch (err) {
    logger.error({ err }, 'outbox cycle failed');
  } finally {
    running = false;
  }
}

/** Run a dispatch cycle now (called right after a bid commits for low latency). */
export function wakeOutboxDispatcher() {
  if (!stopped) void cycle();
}

export function startOutboxDispatcher() {
  stopped = false;
  const tick = async () => {
    await cycle();
    if (!stopped) timer = setTimeout(tick, env.OUTBOX_POLL_MS);
  };
  timer = setTimeout(tick, 0);
  logger.info({ pollMs: env.OUTBOX_POLL_MS }, 'outbox dispatcher started');
}

export async function stopOutboxDispatcher() {
  stopped = true;
  if (timer) clearTimeout(timer);
  while (running) await new Promise((r) => setTimeout(r, 10));
}

/** Housekeeping: delete processed events older than a day so the table does not grow forever. */
export async function pruneOutbox() {
  await sql`DELETE FROM outbox_events WHERE processed_at IS NOT NULL AND processed_at < UTC_TIMESTAMP(3) - INTERVAL 1 DAY LIMIT 5000`.execute(getDb());
}
