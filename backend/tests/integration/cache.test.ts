import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { getRedis } from '../../src/cache/redis.js';
import { CacheKeys } from '../../src/cache/keys.js';
import { cacheMetrics } from '../../src/cache/metrics.js';
import { invalidateAuction, setAuctionSnapshot } from '../../src/cache/cache.js';
import { loadAuctionDetail } from '../../src/modules/auctions/auction.repository.js';
import { getDb } from '../../src/database/db.js';
import { useCleanDatabase } from './setup.js';
import { createAuction, createUser } from '../helpers/fixtures.js';

const app = createApp();

describe('Redis cache-aside for auction detail', () => {
  useCleanDatabase();

  it('misses, then hits, then is invalidated by a committed bid and serves fresh data', async () => {
    const s = await createUser('SELLER');
    const b = await createUser('USER');
    const id = await createAuction({ sellerId: s.id, startingPrice: '1000.00' });

    const miss = await request(app).get(`/api/v1/auctions/${id}`);
    expect(miss.headers['x-cache']).toBe('MISS');
    expect(Number(miss.headers['x-db-queries'])).toBeGreaterThan(0);
    expect(await getRedis().exists(CacheKeys.auctionDetail(id))).toBe(1);

    const hit = await request(app).get(`/api/v1/auctions/${id}`);
    expect(hit.headers['x-cache']).toBe('HIT');
    expect(hit.headers['x-db-queries']).toBe('0'); // served without touching MySQL

    await request(app).post(`/api/v1/auctions/${id}/bids`).set('Authorization', `Bearer ${b.token}`).send({ amount: '1000', clientRequestId: randomUUID() }).expect(201);
    expect(await getRedis().exists(CacheKeys.auctionDetail(id))).toBe(0);

    const fresh = await request(app).get(`/api/v1/auctions/${id}`);
    expect(fresh.headers['x-cache']).toBe('MISS');
    expect(fresh.body.data).toMatchObject({ currentHighestBid: '1000.00', bidCount: 1, version: 2 });
    const metrics = cacheMetrics.snapshot().areas.auction!;
    expect(metrics).toMatchObject({ hits: 1, misses: 2 });
  });

  it('refuses to repopulate the cache with a snapshot older than the last invalidation (stale-write race)', async () => {
    const s = await createUser('SELLER');
    const id = await createAuction({ sellerId: s.id });
    const stale = (await loadAuctionDetail(getDb(), id))!; // a slow reader holds version 1…
    await invalidateAuction(id, 2); // …while a bid commits version 2 and invalidates
    await setAuctionSnapshot(id, stale); // the slow reader now tries to write v1 back
    expect(await getRedis().exists(CacheKeys.auctionDetail(id))).toBe(0);
    expect(cacheMetrics.snapshot().areas.auction?.skippedStaleWrites).toBe(1);

    await setAuctionSnapshot(id, { ...stale, version: 2 }); // a current snapshot is accepted
    expect(await getRedis().exists(CacheKeys.auctionDetail(id))).toBe(1);
  });

  it('never replaces a newer cached snapshot with an older one', async () => {
    const s = await createUser('SELLER');
    const id = await createAuction({ sellerId: s.id });
    const d = (await loadAuctionDetail(getDb(), id))!;
    await setAuctionSnapshot(id, { ...d, version: 5 });
    await setAuctionSnapshot(id, { ...d, version: 4 });
    expect(JSON.parse((await getRedis().get(CacheKeys.auctionDetail(id)))!).version).toBe(5);
  });

  it('keeps serving correct data from MySQL when Redis is unavailable', async () => {
    const s = await createUser('SELLER');
    const id = await createAuction({ sellerId: s.id, title: 'Works without cache' });
    const redis = getRedis();
    redis.disconnect(); // simulate Redis outage (no auto-reconnect after manual disconnect)
    try {
      const res = await request(app).get(`/api/v1/auctions/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.data.title).toBe('Works without cache');
      expect(res.headers['x-cache']).toBe('BYPASS');
      const list = await request(app).get('/api/v1/auctions');
      expect(list.status).toBe(200);
      expect(list.body.data).toHaveLength(1);
    } finally {
      await redis.connect();
    }
  });

  it('caches browse pages and invalidates them via the list generation counter', async () => {
    const s = await createUser('SELLER');
    const b = await createUser('USER');
    const id = await createAuction({ sellerId: s.id, startingPrice: '1000.00' });
    await request(app).get('/api/v1/auctions');
    const second = await request(app).get('/api/v1/auctions');
    expect(second.headers['x-cache']).toBe('HIT');
    await request(app).post(`/api/v1/auctions/${id}/bids`).set('Authorization', `Bearer ${b.token}`).send({ amount: '1000', clientRequestId: randomUUID() }).expect(201);
    const after = await request(app).get('/api/v1/auctions');
    expect(after.headers['x-cache']).toBe('MISS');
    expect(after.body.data[0].currentHighestBid).toBe('1000.00');
  });
});
