/**
 * Socket.IO behaviour over a real server: rooms, targeted notifications, versions, reconnection.
 * Events reach clients only through the outbox dispatcher, exactly as in production.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import { closeDb } from '../../src/database/db.js';
import { closeRedis } from '../../src/cache/redis.js';
import { startOutboxDispatcher, stopOutboxDispatcher } from '../../src/workers/outboxDispatcher.js';
import { closeAuction } from '../../src/workers/lifecycleWorker.js';
import type { BidPlacedEvent, JoinAck, NotificationNewEvent, ServerEvent } from '../../src/shared/events.js';
import { createAuction, createUser, httpBid, resetState, startTestServer } from '../helpers/fixtures.js';

let server: Awaited<ReturnType<typeof startTestServer>>;
const sockets: Socket[] = [];

beforeAll(async () => {
  server = await startTestServer();
  startOutboxDispatcher();
});
afterAll(async () => {
  for (const s of sockets) s.disconnect();
  await stopOutboxDispatcher();
  await server.close();
  await closeRedis();
  await closeDb();
});
beforeEach(async () => {
  await resetState();
});

async function client(token?: string): Promise<Socket> {
  const s = connect(server.url, { path: '/socket.io', transports: ['websocket'], auth: token ? { token } : {}, reconnection: false, forceNew: true });
  sockets.push(s);
  await new Promise<void>((resolve, reject) => {
    s.once('connect', () => resolve());
    s.once('connect_error', reject);
  });
  return s;
}

const join = (s: Socket, auctionId: number) => new Promise<JoinAck>((r) => s.emit('auction:join', auctionId, r));

function nextEvent<T extends ServerEvent>(s: Socket, name: T['type'], timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out waiting for ${name}`)), timeoutMs);
    s.once(name as string, (e: T) => {
      clearTimeout(t);
      resolve(e);
    });
  });
}

function collect(s: Socket, name: string): ServerEvent[] {
  const out: ServerEvent[] = [];
  s.on(name, (e: ServerEvent) => out.push(e));
  return out;
}

describe('Socket.IO live updates', () => {
  it('delivers committed bids to everyone in the auction room, with version and event id', async () => {
    const seller = await createUser('SELLER');
    const bidder = await createUser('USER', 'Viewer One');
    const id = await createAuction({ sellerId: seller.id, startingPrice: '1000.00' });
    const watcher = await client(); // anonymous viewers may watch
    const ack = await join(watcher, id);
    expect(ack).toMatchObject({ ok: true, version: 1 });
    const pending = nextEvent<BidPlacedEvent>(watcher, 'auction:bid_placed');
    await httpBid(server.url, bidder.token, id, '1000');
    const e = await pending;
    expect(e).toMatchObject({ type: 'auction:bid_placed', auctionId: id, version: 2, data: { bid: { amount: '1000.00' }, state: { currentHighestBid: '1000.00', minimumNextBid: '1100.00', bidCount: 1 } } });
    expect(e.eventId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('does not leak events to other auction rooms', async () => {
    const seller = await createUser('SELLER');
    const bidder = await createUser('USER');
    const x = await createAuction({ sellerId: seller.id, startingPrice: '1000.00' });
    const y = await createAuction({ sellerId: seller.id, startingPrice: '1000.00' });
    const inY = await client();
    await join(inY, y);
    const seen = collect(inY, 'auction:bid_placed');
    const inX = await client();
    await join(inX, x);
    const got = nextEvent(inX, 'auction:bid_placed');
    await httpBid(server.url, bidder.token, x, '1000');
    await got;
    await new Promise((r) => setTimeout(r, 300));
    expect(seen).toHaveLength(0);
  });

  it('sends the OUTBID notification only to the outbid user', async () => {
    const seller = await createUser('SELLER');
    const a = await createUser('USER');
    const b = await createUser('USER');
    const id = await createAuction({ sellerId: seller.id, startingPrice: '1000.00' });
    const sa = await client(a.token);
    const sb = await client(b.token);
    await httpBid(server.url, a.token, id, '1000');
    await new Promise((r) => setTimeout(r, 400)); // let a's own BID_ACCEPTED arrive first
    const aNotes = collect(sa, 'notification:new') as NotificationNewEvent[];
    const bNotes = collect(sb, 'notification:new') as NotificationNewEvent[];
    await httpBid(server.url, b.token, id, '1100');
    await new Promise((r) => setTimeout(r, 600));
    expect(aNotes.map((n) => n.data.type)).toEqual(['OUTBID']);
    expect(bNotes.map((n) => n.data.type)).toEqual(['BID_ACCEPTED']);
  });

  it('broadcasts auction:ended with the winner when the worker closes the auction', async () => {
    const seller = await createUser('SELLER');
    const b = await createUser('USER', 'Winner Person');
    const id = await createAuction({ sellerId: seller.id, endOffsetMs: -1, highest: { bidderId: b.id, amount: '2500.00' } });
    const s = await client();
    await join(s, id);
    const ended = nextEvent(s, 'auction:ended');
    await closeAuction(id);
    expect((await ended).data).toMatchObject({ finalPrice: '2500.00', winner: { id: b.id, name: 'Winner P.' }, state: { status: 'COMPLETED' } });
  });

  it('rejects invalid tokens and keeps drafts private', async () => {
    await expect(client('not-a-token')).rejects.toThrow(/UNAUTHENTICATED/);
    const seller = await createUser('SELLER');
    const draft = await createAuction({ sellerId: seller.id, status: 'DRAFT' });
    expect((await join(await client(), draft)).ok).toBe(false);
    expect((await join(await client(seller.token), draft)).ok).toBe(true);
  });

  it('reports live viewer counts and ignores duplicate joins', async () => {
    const seller = await createUser('SELLER');
    const id = await createAuction({ sellerId: seller.id });
    const s1 = await client();
    await join(s1, id);
    await join(s1, id); // duplicate subscription is a no-op
    const s2 = await client();
    expect((await join(s2, id)).viewers).toBe(2);
    const update = new Promise<{ viewers: number }>((r) => s1.once('auction:viewers', r));
    s2.disconnect();
    expect((await update).viewers).toBe(1);
  });

  it('after reconnecting, the join ack version reveals missed events so the client can re-sync via REST', async () => {
    const seller = await createUser('SELLER');
    const bidder = await createUser('USER');
    const id = await createAuction({ sellerId: seller.id, startingPrice: '1000.00' });
    const s = await client();
    const first = await join(s, id);
    s.disconnect();
    await httpBid(server.url, bidder.token, id, '1000'); // happens while we are offline
    await httpBid(server.url, bidder.token, id, '1200');
    const again = await client();
    const second = await join(again, id);
    expect(second.version! - first.version!).toBe(2); // gap → client refetches GET /auctions/:id
    const res = await fetch(`${server.url}/api/v1/auctions/${id}`);
    expect(((await res.json()) as { data: unknown }).data).toMatchObject({ version: second.version, currentHighestBid: '1200.00' });
  });
});
