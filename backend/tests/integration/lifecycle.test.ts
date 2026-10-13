import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/app.js';
import { getDb } from '../../src/database/db.js';
import { activateAuction, closeAuction, notifyEndingSoon, runLifecycleOnce } from '../../src/workers/lifecycleWorker.js';
import { useCleanDatabase } from './setup.js';
import { createAuction, createUser, getAuctionRow } from '../helpers/fixtures.js';

const app = createApp();

describe('auction lifecycle worker', () => {
  useCleanDatabase();

  it('activates scheduled auctions whose start time has passed, and only those', async () => {
    const s = await createUser('SELLER');
    const due = await createAuction({ sellerId: s.id, status: 'SCHEDULED', startOffsetMs: -1000 });
    const later = await createAuction({ sellerId: s.id, status: 'SCHEDULED', startOffsetMs: 3_600_000, endOffsetMs: 7_200_000 });
    const r = await runLifecycleOnce();
    expect(r.started).toBe(1);
    expect((await getAuctionRow(due)).status).toBe('ACTIVE');
    expect((await getAuctionRow(later)).status).toBe('SCHEDULED');
    expect(await activateAuction(due)).toBe(false); // idempotent
  });

  it('closes an ended auction, persists the winner and notifies winner, seller and losing bidders', async () => {
    const s = await createUser('SELLER');
    const a = await createUser('USER');
    const b = await createUser('USER');
    const id = await createAuction({ sellerId: s.id, startingPrice: '1000.00', endOffsetMs: 3_000 });
    for (const [u, amt] of [[a, '1000'], [b, '1500'], [a, '1600']] as const) {
      await request(app).post(`/api/v1/auctions/${id}/bids`).set('Authorization', `Bearer ${u.token}`).send({ amount: amt, clientRequestId: randomUUID() }).expect(201);
    }
    expect(await closeAuction(id)).toBe(false); // not due yet
    await new Promise((r) => setTimeout(r, 3_100));
    expect(await closeAuction(id)).toBe(true);
    const row = await getAuctionRow(id);
    expect(row).toMatchObject({ status: 'COMPLETED', winner_id: a.id, final_price: '1600.00' });
    const notes = await getDb().selectFrom('notifications').select(['user_id', 'type']).where('type', 'in', ['AUCTION_WON', 'AUCTION_SOLD', 'AUCTION_LOST']).execute();
    expect(notes).toEqual(expect.arrayContaining([{ user_id: a.id, type: 'AUCTION_WON' }, { user_id: s.id, type: 'AUCTION_SOLD' }, { user_id: b.id, type: 'AUCTION_LOST' }]));
    expect(notes).toHaveLength(3);

    // Closing again is a no-op and new bids are rejected.
    expect(await closeAuction(id)).toBe(false);
    const late = await request(app).post(`/api/v1/auctions/${id}/bids`).set('Authorization', `Bearer ${b.token}`).send({ amount: '5000', clientRequestId: randomUUID() });
    expect(late.body.error.code).toBe('AUCTION_ENDED');
  });

  it('completes without a winner when there were no bids', async () => {
    const s = await createUser('SELLER');
    const id = await createAuction({ sellerId: s.id, startOffsetMs: -7_200_000, endOffsetMs: -1 });
    expect((await runLifecycleOnce()).completed).toBe(1);
    expect(await getAuctionRow(id)).toMatchObject({ status: 'COMPLETED', winner_id: null, final_price: null });
    const n = await getDb().selectFrom('notifications').select('type').where('user_id', '=', s.id).executeTakeFirstOrThrow();
    expect(n.type).toBe('AUCTION_ENDED_NO_BIDS');
  });

  it('closes a SCHEDULED auction whose whole window passed while the server was down (restart recovery)', async () => {
    const s = await createUser('SELLER');
    const id = await createAuction({ sellerId: s.id, status: 'SCHEDULED', startOffsetMs: -7_200_000, endOffsetMs: -3_600_000 });
    await runLifecycleOnce();
    expect((await getAuctionRow(id)).status).toBe('COMPLETED');
  });

  it('sends the ending-soon alert exactly once to watchers and bidders', async () => {
    const s = await createUser('SELLER');
    const w = await createUser('USER');
    const id = await createAuction({ sellerId: s.id, endOffsetMs: 60_000 });
    await getDb().insertInto('watchlist').values({ user_id: w.id, auction_id: id }).execute();
    expect(await notifyEndingSoon(id)).toBe(true);
    expect(await notifyEndingSoon(id)).toBe(false);
    const n = await getDb().selectFrom('notifications').select(['user_id', 'type']).execute();
    expect(n).toEqual([{ user_id: w.id, type: 'AUCTION_ENDING_SOON' }]);
  });

  it('is safe when several workers try to close the same auction at once', async () => {
    const s = await createUser('SELLER');
    const b = await createUser('USER');
    const id = await createAuction({ sellerId: s.id, startOffsetMs: -7_200_000, endOffsetMs: -1, highest: { bidderId: b.id, amount: '1000.00' } });
    const results = await Promise.all(Array.from({ length: 8 }, () => closeAuction(id)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await getDb().selectFrom('notifications').select('id').where('type', '=', 'AUCTION_WON').execute()).toHaveLength(1);
    expect(await getDb().selectFrom('outbox_events').select('id').where('type', '=', 'auction:ended').execute()).toHaveLength(1);
  });

  it('if the summary ever disagrees with the bids table, closing trusts the bids and repairs the summary', async () => {
    const s = await createUser('SELLER');
    const a = await createUser('USER');
    const b = await createUser('USER');
    const id = await createAuction({ sellerId: s.id, startOffsetMs: -7_200_000, endOffsetMs: -1, highest: { bidderId: a.id, amount: '1000.00' } });
    // Simulate a lost update (what the race demo's unsafe path produces): a higher bid row exists,
    // but the summary still names the lower bid.
    await getDb().insertInto('bids').values({ auction_id: id, bidder_id: b.id, amount: '1500.00', client_request_id: 'corrupt-1' }).execute();
    await closeAuction(id);
    expect(await getAuctionRow(id)).toMatchObject({ winner_id: b.id, final_price: '1500.00', current_highest_bid: '1500.00', current_highest_bidder_id: b.id });
  });
});
