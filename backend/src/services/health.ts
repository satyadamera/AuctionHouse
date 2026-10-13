import { sql } from 'kysely';
import { getDb, dbStats } from '../database/db.js';
import { getRedis, isRedisReady } from '../cache/redis.js';
import { cacheMetrics } from '../cache/metrics.js';
import { outboxStats } from '../workers/outboxDispatcher.js';

async function timed<T>(fn: () => Promise<T>): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const t = performance.now();
  try {
    await fn();
    return { ok: true, latencyMs: +(performance.now() - t).toFixed(2) };
  } catch (err) {
    return { ok: false, latencyMs: +(performance.now() - t).toFixed(2), error: (err as Error).message };
  }
}

export async function readiness() {
  const [mysql, redis] = await Promise.all([
    timed(() => sql`SELECT 1`.execute(getDb())),
    timed(async () => {
      if (!isRedisReady()) throw new Error('not connected');
      await getRedis().ping();
    }),
  ]);
  // MySQL is required; Redis is optional (degraded mode serves everything from MySQL).
  return { status: mysql.ok ? (redis.ok ? 'ok' : 'degraded') : 'unavailable', checks: { mysql, redis } } as const;
}

export async function diagnostics() {
  const { rows } = await sql<{ pending: number; oldest: Date | null }>`
    SELECT COUNT(*) AS pending, MIN(created_at) AS oldest FROM outbox_events WHERE processed_at IS NULL`.execute(getDb());
  return {
    health: await readiness(),
    cache: cacheMetrics.snapshot(),
    outbox: { ...outboxStats, pending: Number(rows[0]?.pending ?? 0), oldestPendingAt: rows[0]?.oldest ?? null },
    database: { queriesSinceStart: dbStats.queries },
    process: { uptimeSeconds: Math.round(process.uptime()), rssMb: Math.round(process.memoryUsage().rss / 1048576), node: process.version },
  };
}
