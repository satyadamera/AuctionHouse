/**
 * DEMO 3 — Redis cache-aside.  Run with the API up:  npm run demo:cache
 *
 * 1. clear the cache entry  2. read → MISS (MySQL queries > 0)  3. read again → HIT (0 queries)
 * 4. place a bid             5. show the key was invalidated     6. read → MISS, fresh data
 * 7. compare the API response with a direct MySQL query
 * Timings are single requests on this machine — illustrative, not a benchmark (see npm run bench).
 */
import 'dotenv/config';
import { createConnection } from 'mysql2/promise';
import { Redis } from 'ioredis';
import { api, bid, c, heading, inr, login } from './lib.js';

const AUCTION_KEY = (id: number) => `auctra:v1:auction:detail:${id}`;

async function main() {
  const redis = new Redis(process.env.REDIS_URL!);
  const conn = await createConnection({ uri: process.env.DATABASE_URL!, timezone: 'Z' });
  const bidder = await login('kabir');

  const list = await api<{ id: number; title: string; sellerId: number; seller: { id: number } }[]>('/auctions?sort=most_bids&pageSize=10');
  const target = list.body.data.find((a) => a.seller.id !== bidder.id)!;
  const id = target.id;
  heading(`Cache-aside on GET /api/v1/auctions/${id}  (“${target.title}”)`);

  const read = async (label: string) => {
    const r = await api<{ currentHighestBid: string; bidCount: number; version: number }>(`/auctions/${id}`);
    const cache = r.headers.get('x-cache');
    const color = cache === 'HIT' ? c.green : c.yellow;
    console.log(
      `${label.padEnd(34)} X-Cache: ${color(String(cache).padEnd(4))}  SQL queries: ${r.headers.get('x-db-queries')}  ` +
        `${r.ms.toFixed(1).padStart(6)} ms  → highest ${inr(r.body.data.currentHighestBid)}, ${r.body.data.bidCount} bids, v${r.body.data.version}`,
    );
    return r.body.data;
  };

  await api(`/dev/cache/auction/${id}`, { method: 'DELETE' });
  console.log(`1. cleared ${AUCTION_KEY(id)}  → exists in Redis: ${await redis.exists(AUCTION_KEY(id))}`);
  await read('2. first read (cold cache)');
  console.log(`   key now exists: ${await redis.exists(AUCTION_KEY(id))}, TTL ${await redis.ttl(AUCTION_KEY(id))}s`);
  await read('3. second read (warm cache)');
  await read('   third read (warm cache)');

  const before = (await api<{ minimumNextBid: string }>(`/auctions/${id}`)).body.data;
  const r = await bid(bidder.token, id, before.minimumNextBid);
  console.log(`4. ${bidder.name} bids ${inr(before.minimumNextBid)} → HTTP ${r.status}${r.body.error ? ' ' + r.body.error.code : ''}, new version v${r.body.data?.version}`);
  console.log(`5. after commit the bid path invalidated the key → exists in Redis: ${await redis.exists(AUCTION_KEY(id))}` +
    `, min-version marker = ${await redis.get(`auctra:v1:auction:minver:${id}`)}`);
  const after = await read('6. read after bid');

  const [[row]] = (await conn.query('SELECT current_highest_bid, bid_count, version FROM auctions WHERE id = ?', [id])) as unknown as [[{ current_highest_bid: string; bid_count: number; version: number }]];
  const match = row.current_highest_bid === after.currentHighestBid && row.bid_count === after.bidCount && row.version === after.version;
  console.log(`7. MySQL says highest ${inr(row.current_highest_bid)}, ${row.bid_count} bids, v${row.version}  → ${match ? c.green('✓ API matches MySQL') : c.red('✗ mismatch')}`);
  await read('   next read (warm again)');

  const m = await api<{ hits: number; misses: number; hitRate: number | null }>('/dev/cache/metrics');
  console.log(c.dim(`\nServer-side cache metrics since start: ${JSON.stringify(m.body.data)}`));
  redis.disconnect();
  await conn.end();
}

main().catch((err) => {
  console.error(c.red(String(err?.message ?? err)));
  process.exit(1);
});
