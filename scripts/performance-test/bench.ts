/**
 * Performance benchmark (autocannon).  npm run bench
 *
 * Self-contained: boots its own API instance in-process against the TEST database and TEST Redis DB
 * (wiped first), with logging off and rate limits raised, so results are not skewed by the dev
 * server's pretty logs or by throttling. Nothing here touches your demo data.
 *
 * Scenarios
 *  A  GET /auctions/:id, warm Redis cache
 *  B  GET /auctions/:id, cache bypassed (dev-only header) → every request hits MySQL
 *  C  POST bids, 20 users spread over 20 auctions (low contention)
 *  D  POST bids, 20 users all on ONE auction (worst-case row-lock contention)
 * Results are printed and written to scripts/performance-test/results/<timestamp>.json.
 */
import os from 'node:os';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Request as CannonRequest } from 'autocannon';

process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_BID_MAX = '10000000';
process.env.RATE_LIMIT_AUTH_MAX = '10000000';
process.env.ENABLE_DEV_ROUTES = 'true';
process.env.DISABLE_WORKERS = 'true';
process.env.DB_POOL_SIZE = process.env.DB_POOL_SIZE ?? '20';

const DURATION = Number(process.env.BENCH_SECONDS ?? 10);
const CONNECTIONS = Number(process.env.BENCH_CONNECTIONS ?? 50);

async function main() {
  const autocannon = (await import('autocannon')).default;
  const { sql } = await import('kysely');
  const { env } = await import('../../backend/src/config/env.js');
  const { dropAllTables, runMigrations } = await import('../../backend/src/database/migrate.js');
  const { getDb, closeDb } = await import('../../backend/src/database/db.js');
  const { getRedis, waitForRedis, closeRedis } = await import('../../backend/src/cache/redis.js');
  const { startTestServer, createUser, createAuction } = await import('../../backend/tests/helpers/fixtures.js');
  const { startOutboxDispatcher, stopOutboxDispatcher } = await import('../../backend/src/workers/outboxDispatcher.js');

  await dropAllTables(env.databaseUrl);
  await runMigrations(env.databaseUrl);
  if (await waitForRedis(3000)) await getRedis().flushdb();
  const server = await startTestServer();
  startOutboxDispatcher(); // realistic: events are dispatched while bids are being placed

  const seller = await createUser('SELLER');
  const users = await Promise.all(Array.from({ length: 20 }, () => createUser('USER')));
  const readTarget = await createAuction({ sellerId: seller.id, startingPrice: '1000.00' });
  for (let i = 0; i < 25; i++) await getDb().insertInto('bids').values({ auction_id: readTarget, bidder_id: users[i % 20]!.id, amount: (1000 + i * 100).toFixed(2), client_request_id: `b-${i}` }).execute();
  await sql`UPDATE auctions SET current_highest_bid = '3400.00', current_highest_bidder_id = ${users[4]!.id}, bid_count = 25 WHERE id = ${readTarget}`.execute(getDb());
  const spread = await Promise.all(Array.from({ length: 20 }, () => createAuction({ sellerId: seller.id, startingPrice: '1.00', increment: '0.01' })));
  const hot = await createAuction({ sellerId: seller.id, startingPrice: '1.00', increment: '0.01' });

  type Result = Awaited<ReturnType<typeof autocannon>>;
  const run = (title: string, opts: Parameters<typeof autocannon>[0]) =>
    new Promise<Result>((resolve, reject) => {
      console.log(`\n▶ ${title}  (${CONNECTIONS} connections, ${DURATION}s)`);
      autocannon({ connections: CONNECTIONS, duration: DURATION, ...opts }, (err, res) => (err ? reject(err) : resolve(res)));
    });

  const results: Record<string, Result> = {};
  await fetch(`${server.url}/api/v1/auctions/${readTarget}`); // warm the cache
  results['A_detail_cached'] = await run('A  GET /auctions/:id — Redis cache warm', { url: `${server.url}/api/v1/auctions/${readTarget}` });
  results['B_detail_uncached'] = await run('B  GET /auctions/:id — cache bypassed (MySQL every request)', {
    url: `${server.url}/api/v1/auctions/${readTarget}`,
    headers: { 'x-cache-bypass': '1' },
  });

  // Bids: each request gets a fresh idempotency key and a strictly increasing amount per auction,
  // so most requests are valid. Amounts that lose a race return 409 BID_TOO_LOW (counted separately).
  const counters = new Map<number, number>();
  const bidRequest = (pickAuction: (n: number) => number) => {
    let n = 0;
    return {
      method: 'POST' as const,
      setupRequest: (req: CannonRequest): CannonRequest => {
        n++;
        const auctionId = pickAuction(n);
        const next = (counters.get(auctionId) ?? 100) + 1;
        counters.set(auctionId, next);
        const user = users[n % users.length]!;
        return {
          ...req,
          path: `/api/v1/auctions/${auctionId}/bids`,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${user.token}` },
          body: JSON.stringify({ amount: (next / 100).toFixed(2), clientRequestId: randomUUID() }),
        };
      },
    };
  };
  results['C_bids_spread'] = await run('C  POST /auctions/:id/bids — spread over 20 auctions', { url: server.url, requests: [bidRequest((n) => spread[n % spread.length]!)] });
  results['D_bids_hot'] = await run('D  POST /auctions/:id/bids — all on ONE auction (row-lock contention)', { url: server.url, requests: [bidRequest(() => hot)] });

  const { rows } = await sql<{ v: string }>`SELECT VERSION() AS v`.execute(getDb());
  const environment = {
    date: new Date().toISOString(),
    cpu: `${os.cpus()[0]?.model} × ${os.cpus().length}`,
    memoryGb: Math.round(os.totalmem() / 1e9),
    os: `${os.type()} ${os.release()}`,
    node: process.version,
    mysql: rows[0]!.v,
    redis: (await getRedis().info('server')).match(/redis_version:(\S+)/)?.[1],
    connections: CONNECTIONS,
    durationSeconds: DURATION,
    dbPoolSize: env.DB_POOL_SIZE,
    note: 'API, MySQL, Redis and the load generator all ran on the same machine.',
  };

  const table = Object.entries(results).map(([name, r]) => {
    const non2xx = r.non2xx;
    return {
      scenario: name,
      'req/s (avg)': Math.round(r.requests.average),
      'p50 ms': r.latency.p50,
      'p90 ms': r.latency.p90,
      'p99 ms': r.latency.p99,
      'max ms': r.latency.max,
      requests: r.requests.total,
      '2xx': r['2xx'],
      'non-2xx': non2xx,
      errors: r.errors + r.timeouts,
    };
  });
  console.log('\nEnvironment:', environment);
  console.table(table);
  const [bidsSpread, bidsHot] = await Promise.all([
    sql<{ n: number }>`SELECT COUNT(*) AS n FROM bids WHERE auction_id IN (${sql.join(spread)})`.execute(getDb()),
    sql<{ n: number; c: number }>`SELECT COUNT(*) AS n, (SELECT bid_count FROM auctions WHERE id = ${hot}) AS c FROM bids WHERE auction_id = ${hot}`.execute(getDb()),
  ]);
  console.log(`Integrity after load: spread auctions hold ${bidsSpread.rows[0]!.n} bids; hot auction holds ${bidsHot.rows[0]!.n} bids (bid_count=${bidsHot.rows[0]!.c}).`);

  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'results');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${environment.date.replace(/[:.]/g, '-')}.json`);
  await writeFile(file, JSON.stringify({ environment, table }, null, 2));
  console.log(`Saved ${path.relative(process.cwd(), file)}`);

  await stopOutboxDispatcher();
  await server.close();
  await closeRedis();
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
