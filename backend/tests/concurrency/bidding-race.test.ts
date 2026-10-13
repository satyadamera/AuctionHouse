/**
 * Concurrency tests against REAL MySQL row locks, over REAL concurrent HTTP requests.
 *
 * Two styles:
 *  1. Uncontrolled races (Promise.all of many requests). We never assert which request wins —
 *     only that the outcome is one of the legal ones and every invariant holds.
 *  2. Controlled schedules using bidTestHooks.afterLock: transaction A pauses WHILE HOLDING the row
 *     lock, so we can prove B is blocked, then release A and observe B re-validate against A's
 *     committed state. This makes both orderings of the ₹10,500 / ₹11,000 example deterministic.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closeDb, getDb } from '../../src/database/db.js';
import { closeRedis } from '../../src/cache/redis.js';
import { bidTestHooks } from '../../src/modules/bids/bid.service.js';
import { closeAuction } from '../../src/workers/lifecycleWorker.js';
import {
  assertAuctionConsistent,
  createAuction,
  createUser,
  dbNow,
  getAuctionRow,
  getBids,
  httpBid,
  resetState,
  startTestServer,
} from '../helpers/fixtures.js';

let server: Awaited<ReturnType<typeof startTestServer>>;

beforeAll(async () => {
  server = await startTestServer();
});
afterAll(async () => {
  await server.close();
  await closeRedis();
  await closeDb();
});
beforeEach(async () => {
  bidTestHooks.afterLock = undefined;
  await resetState();
});

/** A gate the test opens manually; used to hold a transaction inside its critical section. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { open, opened };
}

const settledWithin = (p: Promise<unknown>, ms: number) =>
  Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);

describe('the ₹10,000 → A ₹10,500 / B ₹11,000 race', () => {
  async function setup() {
    const seller = await createUser('SELLER');
    const a = await createUser('USER', 'Alice A');
    const b = await createUser('USER', 'Bob B');
    const opener = await createUser('USER', 'Opening Bidder');
    const id = await createAuction({ sellerId: seller.id, startingPrice: '5000.00', increment: '100.00', highest: { bidderId: opener.id, amount: '10000.00' } });
    return { a, b, id };
  }

  it('A locks first: B waits for the lock, then both succeed (10,500 then 11,000)', async () => {
    const { a, b, id } = await setup();
    const aHoldsLock = gate();
    const releaseA = gate();
    bidTestHooks.afterLock = async (_auction, bidderId) => {
      if (bidderId === a.id) {
        aHoldsLock.open();
        await releaseA.opened;
      }
    };

    const pa = httpBid(server.url, a.token, id, '10500');
    await aHoldsLock.opened;
    const pb = httpBid(server.url, b.token, id, '11000');
    // B must be blocked on SELECT … FOR UPDATE while A holds the lock.
    expect(await settledWithin(pb, 400)).toBe(false);
    releaseA.open();
    const [ra, rb] = await Promise.all([pa, pb]);

    expect(ra.status).toBe(201);
    expect(rb.status).toBe(201);
    const { auction, bids, problems } = await assertAuctionConsistent(id);
    expect(problems).toEqual([]);
    expect(bids.map((x) => x.amount)).toEqual(['10000.00', '10500.00', '11000.00']);
    expect(auction).toMatchObject({ current_highest_bid: '11000.00', current_highest_bidder_id: b.id, bid_count: 3 });
  });

  it('B locks first: A is re-validated after waiting and rejected — the lower bid can never overwrite the higher one', async () => {
    const { a, b, id } = await setup();
    const bHoldsLock = gate();
    const releaseB = gate();
    bidTestHooks.afterLock = async (_auction, bidderId) => {
      if (bidderId === b.id) {
        bHoldsLock.open();
        await releaseB.opened;
      }
    };

    const pb = httpBid(server.url, b.token, id, '11000');
    await bHoldsLock.opened;
    const pa = httpBid(server.url, a.token, id, '10500');
    expect(await settledWithin(pa, 400)).toBe(false);
    releaseB.open();
    const [ra, rb] = await Promise.all([pa, pb]);

    expect(rb.status).toBe(201);
    expect(ra.status).toBe(409);
    expect(ra.body.error?.code).toBe('BID_TOO_LOW');
    const { auction, bids, problems } = await assertAuctionConsistent(id);
    expect(problems).toEqual([]);
    expect(bids.map((x) => x.amount)).toEqual(['10000.00', '11000.00']);
    expect(auction).toMatchObject({ current_highest_bid: '11000.00', current_highest_bidder_id: b.id });
  });

  it('uncontrolled: 25 repetitions of the race always end in a legal state', async () => {
    for (let i = 0; i < 25; i++) {
      await resetState();
      const { a, b, id } = await setup();
      const [ra, rb] = await Promise.all([httpBid(server.url, a.token, id, '10500'), httpBid(server.url, b.token, id, '11000')]);
      // B is always valid (11,000 ≥ 10,500 + 100 and ≥ 10,000 + 100). A is valid only if it went first.
      expect(rb.status).toBe(201);
      const { auction, bids, problems } = await assertAuctionConsistent(id);
      expect(problems).toEqual([]);
      expect(auction.current_highest_bid).toBe('11000.00');
      if (ra.status === 201) expect(bids.map((x) => x.amount)).toEqual(['10000.00', '10500.00', '11000.00']);
      else {
        expect(ra.body.error?.code).toBe('BID_TOO_LOW');
        expect(bids.map((x) => x.amount)).toEqual(['10000.00', '11000.00']);
      }
    }
  });
});

describe('equal and duplicate bids', () => {
  it('two users bidding the same amount at the same time: exactly one wins', async () => {
    const seller = await createUser('SELLER');
    const users = await Promise.all([createUser('USER'), createUser('USER')]);
    const id = await createAuction({ sellerId: seller.id, startingPrice: '10000.00', increment: '100.00' });
    const res = await Promise.all(users.map((u) => httpBid(server.url, u.token, id, '10000')));
    expect(res.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(res.find((r) => r.status === 409)!.body.error?.code).toBe('BID_TOO_LOW');
    const { bids, problems } = await assertAuctionConsistent(id);
    expect(problems).toEqual([]);
    expect(bids).toHaveLength(1);
  });

  it('the same request retried 10 times concurrently creates exactly one bid', async () => {
    const seller = await createUser('SELLER');
    const u = await createUser('USER');
    const id = await createAuction({ sellerId: seller.id, startingPrice: '10000.00' });
    const key = randomUUID();
    const res = await Promise.all(Array.from({ length: 10 }, () => httpBid(server.url, u.token, id, '10000', key)));
    expect(res.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(new Set(res.map((r) => r.body.data!.bid.id)).size).toBe(1);
    expect(await getBids(id)).toHaveLength(1);
    expect((await getAuctionRow(id)).bid_count).toBe(1);
  });

  it('the same key used concurrently on two DIFFERENT auctions: the unique index lets only one through', async () => {
    const seller = await createUser('SELLER');
    const u = await createUser('USER');
    const x = await createAuction({ sellerId: seller.id, startingPrice: '10000.00' });
    const y = await createAuction({ sellerId: seller.id, startingPrice: '10000.00' });
    const key = randomUUID();
    const res = await Promise.all([httpBid(server.url, u.token, x, '10000', key), httpBid(server.url, u.token, y, '10000', key)]);
    expect(res.map((r) => r.status).sort()).toEqual([201, 422]);
    const total = (await getBids(x)).length + (await getBids(y)).length;
    expect(total).toBe(1);
  });
});

describe('high contention', () => {
  it.each([20, 50, 100])('%i bidders racing on one auction: no lost updates, strictly increasing bids, summary = MAX', async (n) => {
    const seller = await createUser('SELLER');
    const bidders = await Promise.all(Array.from({ length: n }, () => createUser('USER')));
    const id = await createAuction({ sellerId: seller.id, startingPrice: '10000.00', increment: '100.00' });
    // Amounts deliberately overlap so many requests are invalid by the time they get the lock.
    const amounts = bidders.map((_, i) => (10000 + 100 * ((i * 37) % n)).toFixed(2));
    const res = await Promise.all(bidders.map((u, i) => httpBid(server.url, u.token, id, amounts[i]!)));

    const accepted = res.filter((r) => r.status === 201);
    const rejected = res.filter((r) => r.status !== 201);
    expect(accepted.length).toBeGreaterThan(0);
    // The only legitimate rejection here is "someone else got there first".
    expect(new Set(rejected.map((r) => r.body.error?.code))).toEqual(rejected.length ? new Set(['BID_TOO_LOW']) : new Set());

    const { auction, bids, problems } = await assertAuctionConsistent(id);
    expect(problems).toEqual([]);
    // Every 201 corresponds to exactly one row; nothing accepted was lost, nothing rejected was stored.
    expect(bids).toHaveLength(accepted.length);
    expect(new Set(bids.map((b) => b.id))).toEqual(new Set(accepted.map((r) => r.body.data!.bid.id)));
    // The highest accepted amount is the authoritative highest bid.
    const maxAccepted = Math.max(...accepted.map((r) => Number(r.body.data!.bid.amount)));
    expect(Number(auction.current_highest_bid)).toBe(maxAccepted);
    // version advanced once per accepted bid
    expect(auction.version).toBe(1 + accepted.length);
  });

  it('bids on different auctions do not block each other (row lock, not table lock)', async () => {
    const seller = await createUser('SELLER');
    const a = await createUser('USER');
    const b = await createUser('USER');
    const x = await createAuction({ sellerId: seller.id, startingPrice: '1000.00' });
    const y = await createAuction({ sellerId: seller.id, startingPrice: '1000.00' });
    const holding = gate();
    const release = gate();
    bidTestHooks.afterLock = async (auctionId) => {
      if (auctionId === x) {
        holding.open();
        await release.opened;
      }
    };
    const px = httpBid(server.url, a.token, x, '1000');
    await holding.opened;
    // While auction X is locked, a bid on auction Y completes immediately.
    const ry = await httpBid(server.url, b.token, y, '1000');
    expect(ry.status).toBe(201);
    release.open();
    expect((await px).status).toBe(201);
  });
});

describe('bidding vs closing', () => {
  it('a bid holding the lock when the end time passes still commits, and the closer then declares it the winner', async () => {
    const seller = await createUser('SELLER');
    const u = await createUser('USER');
    const id = await createAuction({ sellerId: seller.id, startingPrice: '1000.00', endOffsetMs: 700 });
    const locked = gate();
    const release = gate();
    bidTestHooks.afterLock = async () => {
      locked.open();
      await release.opened;
    };
    // The bid validated its window (now < end) right after taking the lock…
    const pBid = httpBid(server.url, u.token, id, '1000');
    await locked.opened;
    await new Promise((r) => setTimeout(r, 900)); // …and the end time passes while it is still in its transaction.
    const pClose = closeAuction(id); // the closer blocks on the same row lock
    expect(await settledWithin(pClose, 300)).toBe(false);
    release.open();
    const [rb, closed] = await Promise.all([pBid, pClose]);
    expect(rb.status).toBe(201);
    expect(closed).toBe(true);
    expect(await getAuctionRow(id)).toMatchObject({ status: 'COMPLETED', winner_id: u.id, final_price: '1000.00' });
  });

  it('once the closer holds the lock, a waiting bid is rejected and the winner is unchanged', async () => {
    const seller = await createUser('SELLER');
    const leader = await createUser('USER');
    const late = await createUser('USER');
    const id = await createAuction({ sellerId: seller.id, startingPrice: '1000.00', endOffsetMs: -1, highest: { bidderId: leader.id, amount: '1000.00' } });
    const [closed, rb] = await Promise.all([closeAuction(id), httpBid(server.url, late.token, id, '9999')]);
    expect(closed).toBe(true);
    expect(rb.status).toBe(409);
    expect(rb.body.error?.code).toBe('AUCTION_ENDED');
    expect(await getAuctionRow(id)).toMatchObject({ status: 'COMPLETED', winner_id: leader.id, final_price: '1000.00' });
    expect(await getBids(id)).toHaveLength(1);
  });

  it('bids racing a closing loop around the end time: no accepted bid after end_time, winner = highest accepted', async () => {
    const seller = await createUser('SELLER');
    const bidders = await Promise.all(Array.from({ length: 30 }, () => createUser('USER')));
    const id = await createAuction({ sellerId: seller.id, startingPrice: '1000.00', increment: '10.00', endOffsetMs: 400 });
    let stop = false;
    const closer = (async () => {
      while (!stop) {
        await closeAuction(id);
        await new Promise((r) => setTimeout(r, 20));
      }
    })();
    const res = await Promise.all(
      bidders.map(async (u, i) => {
        await new Promise((r) => setTimeout(r, i * 25)); // spread bids from t=0 to t≈750ms
        return httpBid(server.url, u.token, id, (1000 + i * 10).toFixed(2));
      }),
    );
    await new Promise((r) => setTimeout(r, 200));
    stop = true;
    await closer;

    const { auction, bids, problems } = await assertAuctionConsistent(id);
    expect(problems).toEqual([]);
    expect(auction.status).toBe('COMPLETED');
    for (const b of bids) expect(b.created_at.getTime()).toBeLessThan(auction.end_time.getTime());
    const accepted = res.filter((r) => r.status === 201);
    expect(bids).toHaveLength(accepted.length);
    const late = res.filter((r) => r.status === 409).map((r) => r.body.error?.code);
    expect(late.every((c) => c === 'AUCTION_ENDED' || c === 'BID_TOO_LOW')).toBe(true);
    if (bids.length) {
      const top = bids[bids.length - 1]!;
      expect(auction.winner_id).toBe(top.bidder_id);
      expect(auction.final_price).toBe(top.amount);
    } else {
      expect(auction.winner_id).toBeNull();
    }
    // Nothing was inserted after the auction was completed.
    expect(bids.every((b) => b.created_at <= (auction.completed_at ?? new Date(0)))).toBe(true);
  });

  it('database clock is authoritative: end_time boundary uses UTC_TIMESTAMP, not the API server clock', async () => {
    const seller = await createUser('SELLER');
    const u = await createUser('USER');
    const now = await dbNow();
    const id = await createAuction({ sellerId: seller.id, endOffsetMs: 1500 });
    expect((await httpBid(server.url, u.token, id, '1000')).status).toBe(201);
    const wait = 1500 - (Date.now() - now.getTime()) + 150;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const late = await httpBid(server.url, u.token, id, '2000');
    expect(late.body.error?.code).toBe('AUCTION_ENDED');
    expect(await getDb().selectFrom('bids').select('id').where('auction_id', '=', id).execute()).toHaveLength(1);
  });
});
