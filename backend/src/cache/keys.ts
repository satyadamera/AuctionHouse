/**
 * Cache key namespace: `auctra:v1:<entity>:<qualifier>`.
 * - `auctra` prevents collisions with other apps sharing the Redis instance.
 * - `v1` lets a deploy that changes snapshot shape abandon old keys by bumping the prefix.
 */
const NS = 'auctra:v1';

export const CacheKeys = {
  auctionDetail: (id: number) => `${NS}:auction:detail:${id}`,
  /** Highest version that has been invalidated; older snapshots may not be written back. */
  auctionMinVersion: (id: number) => `${NS}:auction:minver:${id}`,
  featured: () => `${NS}:auctions:featured`,
  categories: () => `${NS}:categories:all`,
  publicStats: () => `${NS}:stats:public`,
  adminSummary: () => `${NS}:dashboard:summary`,
  /** Generation counter embedded in browse-result keys; INCR invalidates every cached page at once. */
  listGeneration: () => `${NS}:auctions:list:gen`,
  browse: (gen: number, queryHash: string) => `${NS}:auctions:list:${gen}:${queryHash}`,
} as const;

/** TTLs in seconds. Short for fast-moving data; long for nearly static data. */
export const CacheTTL = {
  auctionDetail: 60,
  minVersionMarker: 300,
  featured: 30,
  categories: 3600,
  publicStats: 30,
  adminSummary: 15,
  browse: 20,
} as const;
