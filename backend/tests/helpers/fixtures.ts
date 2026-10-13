import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { sql } from 'kysely';
import { getDb } from '../../src/database/db.js';
import { getRedis, waitForRedis } from '../../src/cache/redis.js';
import { signAccessToken } from '../../src/modules/auth/tokens.js';
import { createApp } from '../../src/app.js';
import { createSocketServer, closeSocketServer } from '../../src/sockets/io.js';
import type { AuctionStatus, Role } from '../../src/database/types.js';
import { cacheMetrics } from '../../src/cache/metrics.js';

export const PASSWORD = 'Password123';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4); // low cost: tests only

const TABLES = ['outbox_events', 'audit_logs', 'refresh_sessions', 'notifications', 'watchlist', 'bids', 'auction_images', 'auctions', 'categories', 'users'];

/** Empties every table and the Redis test DB. Called in beforeEach so tests are independent. */
export async function resetState() {
  const db = getDb();
  await sql`SET FOREIGN_KEY_CHECKS = 0`.execute(db);
  for (const t of TABLES) await sql`DELETE FROM ${sql.table(t)}`.execute(db);
  await sql`SET FOREIGN_KEY_CHECKS = 1`.execute(db);
  if (await waitForRedis(2000)) await getRedis().flushdb();
  cacheMetrics.reset();
}

let userSeq = 0;
export async function createUser(role: Role = 'USER', name?: string) {
  userSeq++;
  const email = `user${userSeq}-${randomUUID().slice(0, 6)}@test.dev`;
  const r = await getDb()
    .insertInto('users')
    .values({ name: name ?? `Test User${userSeq} ${role}`, email, password_hash: PASSWORD_HASH, role })
    .executeTakeFirstOrThrow();
  const id = Number(r.insertId);
  return { id, email, role, name: name ?? `Test User${userSeq} ${role}`, token: signAccessToken({ id, role, name: 'x' }) };
}

export async function createCategory(slug = 'watches') {
  const existing = await getDb().selectFrom('categories').select('id').where('slug', '=', slug).executeTakeFirst();
  if (existing) return existing.id;
  const r = await getDb().insertInto('categories').values({ name: slug[0]!.toUpperCase() + slug.slice(1), slug, description: null, image_url: null }).executeTakeFirstOrThrow();
  return Number(r.insertId);
}

export async function dbNow(): Promise<Date> {
  const { rows } = await sql<{ now: Date }>`SELECT UTC_TIMESTAMP(3) AS now`.execute(getDb());
  return rows[0]!.now;
}

/**
 * Inserts an auction directly. Times are offsets from the DB clock in ms.
 * Optionally pre-seeds a highest bid (inserted as a real bid row so invariants hold).
 */
export async function createAuction(opts: {
  sellerId: number;
  status?: AuctionStatus;
  startOffsetMs?: number;
  endOffsetMs?: number;
  startingPrice?: string;
  increment?: string;
  highest?: { bidderId: number; amount: string };
  title?: string;
}) {
  const db = getDb();
  const now = await dbNow();
  const start = new Date(now.getTime() + (opts.startOffsetMs ?? -60_000));
  const end = new Date(now.getTime() + (opts.endOffsetMs ?? 3_600_000));
  const categoryId = await createCategory();
  const r = await db
    .insertInto('auctions')
    .values({
      seller_id: opts.sellerId,
      category_id: categoryId,
      title: opts.title ?? 'Test lot',
      description: 'A test auction used by the automated test suite.',
      starting_price: opts.startingPrice ?? '1000.00',
      minimum_bid_increment: opts.increment ?? '100.00',
      start_time: start,
      end_time: end,
      original_end_time: end,
      status: opts.status ?? 'ACTIVE',
      current_highest_bid: opts.highest?.amount ?? null,
      current_highest_bidder_id: opts.highest?.bidderId ?? null,
      bid_count: opts.highest ? 1 : 0,
    })
    .executeTakeFirstOrThrow();
  const id = Number(r.insertId);
  await db.insertInto('auction_images').values({ auction_id: id, image_url: '/static/seed/watch-dress.svg', alt_text: 't', display_order: 0 }).execute();
  if (opts.highest) {
    await db
      .insertInto('bids')
      .values({ auction_id: id, bidder_id: opts.highest.bidderId, amount: opts.highest.amount, client_request_id: `fixture-${id}`, created_at: new Date(now.getTime() - 1000) })
      .execute();
  }
  return id;
}

export async function getAuctionRow(id: number) {
  return getDb().selectFrom('auctions').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
}

export async function getBids(auctionId: number) {
  return getDb().selectFrom('bids').selectAll().where('auction_id', '=', auctionId).orderBy('id').execute();
}

/** A real HTTP server (Express + Socket.IO) on a random port, for concurrency and socket tests. */
export async function startTestServer(): Promise<{ url: string; server: Server; close: () => Promise<void> }> {
  const server = createServer(createApp());
  createSocketServer(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    close: async () => {
      await closeSocketServer();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

export interface BidResponse {
  status: number;
  body: { success: boolean; data?: { bid: { id: number; amount: string }; replayed: boolean; version: number }; error?: { code: string } };
}

export async function httpBid(baseUrl: string, token: string, auctionId: number, amount: string, clientRequestId = randomUUID()): Promise<BidResponse> {
  const res = await fetch(`${baseUrl}/api/v1/auctions/${auctionId}/bids`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ amount, clientRequestId }),
  });
  return { status: res.status, body: (await res.json()) as BidResponse['body'] };
}

/**
 * Asserts the bidding invariants directly against MySQL:
 *  I1 summary highest = MAX(bids.amount) and leader = that bid's bidder
 *  I2 accepted bids strictly increase in commit (id) order by at least the increment
 *  I3 bid_count = number of bid rows
 */
export async function assertAuctionConsistent(auctionId: number) {
  const a = await getAuctionRow(auctionId);
  const bids = await getBids(auctionId);
  const problems: string[] = [];
  if (a.bid_count !== bids.length) problems.push(`bid_count ${a.bid_count} != rows ${bids.length}`);
  const inc = Number(a.minimum_bid_increment);
  for (let i = 1; i < bids.length; i++) {
    const prev = Number(bids[i - 1]!.amount);
    const cur = Number(bids[i]!.amount);
    if (cur < prev + inc - 1e-9) problems.push(`bid ${bids[i]!.id} (${cur}) < previous ${prev} + ${inc}`);
  }
  const last = bids[bids.length - 1];
  if (last) {
    if (Number(a.current_highest_bid) !== Number(last.amount)) problems.push(`summary ${a.current_highest_bid} != last bid ${last.amount}`);
    if (a.current_highest_bidder_id !== last.bidder_id) problems.push(`leader ${a.current_highest_bidder_id} != ${last.bidder_id}`);
    const max = Math.max(...bids.map((b) => Number(b.amount)));
    if (Number(a.current_highest_bid) !== max) problems.push(`summary ${a.current_highest_bid} != MAX ${max}`);
  } else if (a.current_highest_bid !== null) problems.push('summary set but no bids');
  return { auction: a, bids, problems };
}
