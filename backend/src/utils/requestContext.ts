import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request context propagated through async calls. Used for request IDs in logs and to count
 * the SQL queries a request executed (exposed as the X-DB-Queries header for the cache demo).
 */
export interface RequestContext {
  requestId: string;
  dbQueries: number;
  /** Set by the cache layer so the response can expose X-Cache: HIT | MISS | BYPASS. */
  cacheStatus?: 'HIT' | 'MISS' | 'BYPASS';
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function currentRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}
