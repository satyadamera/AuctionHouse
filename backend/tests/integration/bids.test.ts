import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { getDb } from '../../src/database/db.js';
import { useCleanDatabase } from './setup.js';
import { assertAuctionConsistent, createAuction, createUser, getBids } from '../helpers/fixtures.js';

const app = createApp();

function bid(token: string, auctionId: number, amount: string | number, clientRequestId: string = randomUUID()) {
  return request(app).post(`/api/v1/auctions/${auctionId}/bids`).set('Authorization', `Bearer ${token}`).send({ amount, clientRequestId });
}

describe('placing bids (REST)', () => {
  useCleanDatabase();

  it('accepts a valid first bid at the starting price and updates the summary atomically', async () => {
    const s = await createUser('SELLER');
    const b = await createUser('USER');
    const id = await createAuction({ sellerId: s.id, startingPrice: '10000.00', increment: '100.00' });
    const res = await bid(b.token, id, '10000');
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ replayed: false, bid: { amount: '10000.00' }, state: { currentHighestBid: '10000.00', minimumNextBid: '10100.00', bidCount: 1 } });
    const { problems, auction } = await assertAuctionConsistent(id);
    expect(problems).toEqual([]);
    expect(auction.version).toBe(2);
  });

  it('writes a BID_ACCEPTED notification, an OUTBID notification for the previous leader, outbox events and an audit row in the same transaction', async () => {
    const s = await createUser('SELLER');
    const first = await createUser('USER');
    const second = await createUser('USER');
    const id = await createAuction({ sellerId: s.id, startingPrice: '1000.00' });
    await bid(first.token, id, '1000').expect(201);
    await bid(second.token, id, '1100').expect(201);
    const notes = await getDb().selectFrom('notifications').select(['user_id', 'type']).orderBy('id').execute();
    expect(notes).toEqual([
      { user_id: first.id, type: 'BID_ACCEPTED' },
      { user_id: second.id, type: 'BID_ACCEPTED' },
      { user_id: first.id, type: 'OUTBID' },
    ]);
    const events = await getDb().selectFrom('outbox_events').select(['type', 'version']).where('auction_id', '=', id).where('type', '=', 'auction:bid_placed').orderBy('id').execute();
    expect(events).toEqual([{ type: 'auction:bid_placed', version: 2 }, { type: 'auction:bid_placed', version: 3 }]);
    expect(await getDb().selectFrom('audit_logs').select('action').where('action', '=', 'BID_ACCEPTED').execute()).toHaveLength(2);
  });

  it.each([
    ['0', 'INVALID_BID_AMOUNT'],
    ['-100', 'INVALID_BID_AMOUNT'],
    ['1000.001', 'INVALID_BID_AMOUNT'],
    ['abc', 'INVALID_BID_AMOUNT'],
    ['100000000.01', 'INVALID_BID_AMOUNT'],
  ])('rejects amount %s with %s', async (amount, code) => {
    const s = await createUser('SELLER');
    const b = await createUser('USER');
    const id = await createAuction({ sellerId: s.id });
    const res = await bid(b.token, id, amount);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(code);
    expect(await getBids(id)).toHaveLength(0);
  });

  it('rejects a bid below the minimum next bid, reporting the server-computed threshold', async () => {
    const s = await createUser('SELLER');
    const a = await createUser('USER');
    const b = await createUser('USER');
    const id = await createAuction({ sellerId: s.id, startingPrice: '10000.00', increment: '500.00', highest: { bidderId: a.id, amount: '10000.00' } });
    const res = await bid(b.token, id, '10499.99');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'BID_TOO_LOW', details: { minimumNextBid: '10500.00', currentHighestBid: '10000.00' } });
    expect((await bid(b.token, id, '10500')).status).toBe(201);
  });

  it('forbids bidding on your own auction', async () => {
    const s = await createUser('SELLER');
    const id = await createAuction({ sellerId: s.id });
    const res = await bid(s.token, id, '5000');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SELF_BIDDING_NOT_ALLOWED');
  });

  it('forbids admins from bidding', async () => {
    const s = await createUser('SELLER');
    const admin = await createUser('ADMIN');
    const id = await createAuction({ sellerId: s.id });
    expect((await bid(admin.token, id, '5000')).status).toBe(403);
  });

  it('rejects unauthenticated bids and nonexistent auctions', async () => {
    const b = await createUser('USER');
    expect((await request(app).post('/api/v1/auctions/1/bids').send({ amount: '1', clientRequestId: randomUUID() })).status).toBe(401);
    const res = await bid(b.token, 999999, '5000');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('AUCTION_NOT_FOUND');
  });

  it('rejects bids after end_time even if the lifecycle worker has not closed the auction yet', async () => {
    const s = await createUser('SELLER');
    const b = await createUser('USER');
    // status still ACTIVE, but end_time is 1 ms in the past on the DATABASE clock
    const id = await createAuction({ sellerId: s.id, startOffsetMs: -3_600_000, endOffsetMs: -1 });
    const res = await bid(b.token, id, '5000');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('AUCTION_ENDED');
  });

  it('rejects bids on completed and cancelled auctions', async () => {
    const s = await createUser('SELLER');
    const b = await createUser('USER');
    const done = await createAuction({ sellerId: s.id, status: 'COMPLETED', startOffsetMs: -7_200_000, endOffsetMs: -3_600_000 });
    expect((await bid(b.token, done, '5000')).body.error.code).toBe('AUCTION_ENDED');
    const cancelled = await createAuction({ sellerId: s.id, status: 'CANCELLED' });
    expect((await bid(b.token, cancelled, '5000')).body.error.code).toBe('AUCTION_NOT_ACTIVE');
  });

  it('rejects bids before the start time and lazily activates a scheduled auction once it has started', async () => {
    const s = await createUser('SELLER');
    const b = await createUser('USER');
    const future = await createAuction({ sellerId: s.id, status: 'SCHEDULED', startOffsetMs: 3_600_000, endOffsetMs: 7_200_000 });
    expect((await bid(b.token, future, '5000')).body.error.code).toBe('AUCTION_NOT_STARTED');
    const due = await createAuction({ sellerId: s.id, status: 'SCHEDULED', startOffsetMs: -1000 });
    expect((await bid(b.token, due, '1000')).status).toBe(201);
    expect((await getDb().selectFrom('auctions').select('status').where('id', '=', due).executeTakeFirstOrThrow()).status).toBe('ACTIVE');
  });

  it('is idempotent: retrying with the same clientRequestId returns the original bid without inserting another', async () => {
    const s = await createUser('SELLER');
    const b = await createUser('USER');
    const id = await createAuction({ sellerId: s.id, startingPrice: '1000.00' });
    const key = randomUUID();
    const first = await bid(b.token, id, '1000', key);
    const retry = await bid(b.token, id, '1000', key);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body.data.replayed).toBe(true);
    expect(retry.body.data.bid.id).toBe(first.body.data.bid.id);
    expect(await getBids(id)).toHaveLength(1);
  });

  it('returns IDEMPOTENCY_KEY_REUSED when a key is reused with a different amount or auction', async () => {
    const s = await createUser('SELLER');
    const b = await createUser('USER');
    const id = await createAuction({ sellerId: s.id, startingPrice: '1000.00' });
    const other = await createAuction({ sellerId: s.id, startingPrice: '1000.00' });
    const key = randomUUID();
    await bid(b.token, id, '1000', key).expect(201);
    expect((await bid(b.token, id, '2000', key)).body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await bid(b.token, other, '1000', key)).body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await getBids(other)).toHaveLength(0);
  });

  it('scopes idempotency keys per bidder (two users may pick the same key)', async () => {
    const s = await createUser('SELLER');
    const a = await createUser('USER');
    const b = await createUser('USER');
    const id = await createAuction({ sellerId: s.id, startingPrice: '1000.00' });
    await bid(a.token, id, '1000', 'shared-key-0001').expect(201);
    await bid(b.token, id, '1100', 'shared-key-0001').expect(201);
  });

  it('lists bid history newest first with cursor pagination', async () => {
    const s = await createUser('SELLER');
    const a = await createUser('USER', 'Ana Gomez');
    const id = await createAuction({ sellerId: s.id, startingPrice: '1000.00' });
    for (const amt of ['1000', '1100', '1200']) await bid(a.token, id, amt).expect(201);
    const page1 = await request(app).get(`/api/v1/auctions/${id}/bids?limit=2`);
    expect(page1.body.data.map((x: { amount: string }) => x.amount)).toEqual(['1200.00', '1100.00']);
    expect(page1.body.data[0].bidder.name).toBe('Ana G.');
    const page2 = await request(app).get(`/api/v1/auctions/${id}/bids?limit=2&before=${page1.body.meta.nextBefore}`);
    expect(page2.body.data.map((x: { amount: string }) => x.amount)).toEqual(['1000.00']);
  });

  it('reports position on the user dashboard (WINNING / OUTBID)', async () => {
    const s = await createUser('SELLER');
    const a = await createUser('USER');
    const b = await createUser('USER');
    const id = await createAuction({ sellerId: s.id, startingPrice: '1000.00' });
    await bid(a.token, id, '1000').expect(201);
    await bid(b.token, id, '1100').expect(201);
    const mine = await request(app).get('/api/v1/users/me/bids').set('Authorization', `Bearer ${a.token}`);
    expect(mine.body.data[0]).toMatchObject({ position: 'OUTBID', myHighestBid: '1000.00' });
    const theirs = await request(app).get('/api/v1/users/me/bids').set('Authorization', `Bearer ${b.token}`);
    expect(theirs.body.data[0].position).toBe('WINNING');
  });
});
