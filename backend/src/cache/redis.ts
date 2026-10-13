import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Redis client tuned for "cache, not source of truth":
 * - enableOfflineQueue=false: when Redis is down, commands fail immediately instead of queueing
 *   and stalling HTTP requests. Callers catch the error and fall back to MySQL.
 * - maxRetriesPerRequest=1 and a short connect timeout keep a dead Redis from adding latency.
 * - The client reconnects in the background, so the cache comes back on its own.
 */
let client: Redis | undefined;

export function getRedis(): Redis {
  if (client) return client;
  client = new Redis(env.redisUrl, {
    lazyConnect: false,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    commandTimeout: 1000,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });
  let warned = false;
  client.on('error', (err) => {
    if (!warned) logger.warn({ err: err.message }, 'Redis unavailable — serving from MySQL');
    warned = true;
  });
  client.on('ready', () => {
    if (warned) logger.info('Redis connection restored');
    warned = false;
  });
  return client;
}

export function isRedisReady(): boolean {
  return client?.status === 'ready';
}

export async function waitForRedis(timeoutMs = 5000): Promise<boolean> {
  const r = getRedis();
  if (r.status === 'ready') return true;
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), timeoutMs);
    r.once('ready', () => {
      clearTimeout(t);
      resolve(true);
    });
  });
}

export async function closeRedis(): Promise<void> {
  if (client) {
    client.removeAllListeners();
    await client.quit().catch(() => client?.disconnect());
    client = undefined;
  }
}
