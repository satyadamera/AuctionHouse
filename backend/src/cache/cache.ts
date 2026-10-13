import { getRedis } from './redis.js';
import { CacheKeys, CacheTTL } from './keys.js';
import { cacheMetrics } from './metrics.js';
import { logger } from '../utils/logger.js';
import { requestContext } from '../utils/requestContext.js';

/**
 * Cache-aside helpers.
 *
 * Read path:  GET key → hit: return it │ miss: load from MySQL → SET key EX ttl → return.
 * Write path: the database is updated first (and committed); then the affected keys are deleted.
 *
 * Every Redis failure is swallowed and counted: the cache is an optimisation, so an unavailable
 * Redis must degrade to "slower" (MySQL every time), never to "broken".
 */

export type CacheStatus = 'HIT' | 'MISS' | 'BYPASS';

function noteStatus(status: CacheStatus) {
  const ctx = requestContext.getStore();
  if (ctx) ctx.cacheStatus = status;
}

export async function cacheGetJson<T>(key: string, area: string): Promise<T | undefined> {
  try {
    const raw = await getRedis().get(key);
    if (raw === null) {
      cacheMetrics.miss(area);
      noteStatus('MISS');
      return undefined;
    }
    cacheMetrics.hit(area);
    noteStatus('HIT');
    return JSON.parse(raw) as T;
  } catch (err) {
    cacheMetrics.error(area);
    cacheMetrics.miss(area);
    noteStatus('BYPASS');
    logger.debug({ err: (err as Error).message, key }, 'cache get failed');
    return undefined;
  }
}

export async function cacheSetJson(key: string, value: unknown, ttlSeconds: number, area: string) {
  try {
    await getRedis().set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch (err) {
    cacheMetrics.error(area);
    logger.debug({ err: (err as Error).message, key }, 'cache set failed');
  }
}

export async function cacheDel(...keys: string[]) {
  if (!keys.length) return;
  try {
    await getRedis().del(...keys);
  } catch (err) {
    logger.debug({ err: (err as Error).message, keys }, 'cache del failed');
  }
}

/** Generic cache-aside wrapper for data without version semantics (categories, featured, stats). */
export async function cached<T>(key: string, ttl: number, area: string, load: () => Promise<T>): Promise<T> {
  const hit = await cacheGetJson<T>(key, area);
  if (hit !== undefined) return hit;
  const fresh = await load();
  await cacheSetJson(key, fresh, ttl, area);
  return fresh;
}

// ─── Versioned auction snapshots ──────────────────────────────────────────────────────────────
//
// The race that plain cache-aside has:
//   1. Reader R misses the cache and reads auction v5 from MySQL.
//   2. A bid commits v6 and the bid path DELs the cache key.
//   3. R, still holding v5, SETs the key → the cache now serves stale v5 until the TTL expires.
//
// Fix: invalidation records "minimum acceptable version = 6" in a marker key, and repopulation goes
// through a Lua script (atomic inside Redis) that refuses to write a snapshot older than the marker
// or older than whatever is already cached. Step 3 becomes a no-op.

const SET_IF_NEWER = `
local minver = tonumber(redis.call('GET', KEYS[2]) or '0')
local incoming = tonumber(ARGV[2])
if incoming < minver then return 0 end
local current = redis.call('GET', KEYS[1])
if current then
  local ok, decoded = pcall(cjson.decode, current)
  if ok and decoded.version and tonumber(decoded.version) > incoming then return 0 end
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
return 1
`;

const INVALIDATE = `
local minver = tonumber(redis.call('GET', KEYS[2]) or '0')
local v = tonumber(ARGV[1])
if v > minver then redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[2]) end
redis.call('DEL', KEYS[1])
return 1
`;

export async function setAuctionSnapshot(auctionId: number, snapshot: { version: number }) {
  try {
    const written = (await getRedis().eval(
      SET_IF_NEWER,
      2,
      CacheKeys.auctionDetail(auctionId),
      CacheKeys.auctionMinVersion(auctionId),
      JSON.stringify(snapshot),
      String(snapshot.version),
      String(CacheTTL.auctionDetail),
    )) as number;
    if (written === 0) cacheMetrics.staleWriteSkipped('auction');
  } catch (err) {
    cacheMetrics.error('auction');
    logger.debug({ err: (err as Error).message, auctionId }, 'cache snapshot write failed');
  }
}

/**
 * Called after a state change COMMITS. Order matters: invalidating before commit would let a
 * concurrent reader re-cache the pre-commit row in the gap.
 */
export async function invalidateAuction(auctionId: number, committedVersion: number, opts: { lists?: boolean } = {}) {
  const redis = getRedis();
  try {
    await redis.eval(
      INVALIDATE,
      2,
      CacheKeys.auctionDetail(auctionId),
      CacheKeys.auctionMinVersion(auctionId),
      String(committedVersion),
      String(CacheTTL.minVersionMarker),
    );
    if (opts.lists !== false) {
      await redis.incr(CacheKeys.listGeneration());
      await redis.del(CacheKeys.featured(), CacheKeys.publicStats(), CacheKeys.adminSummary(), CacheKeys.categories());
    }
  } catch (err) {
    logger.debug({ err: (err as Error).message, auctionId }, 'cache invalidation failed');
  }
}

export async function currentListGeneration(): Promise<number> {
  try {
    const v = await getRedis().get(CacheKeys.listGeneration());
    return v ? Number(v) : 0;
  } catch {
    return -1; // -1 = Redis down; callers bypass the cache
  }
}
