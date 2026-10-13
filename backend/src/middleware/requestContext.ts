import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { requestContext } from '../utils/requestContext.js';

const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Assigns a request ID (or accepts a well-formed X-Request-Id from the client), and exposes
 * diagnostic headers: X-Request-Id, X-DB-Queries (SQL statements run by this request), X-Cache.
 */
export const requestContextMiddleware: RequestHandler = (req, res, next) => {
  const incoming = req.header('x-request-id');
  const requestId = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
  const ctx = { requestId, dbQueries: 0 } as Parameters<typeof requestContext.run>[0];
  res.setHeader('X-Request-Id', requestId);
  const started = process.hrtime.bigint();
  const writeHead = res.writeHead.bind(res);
  // Headers must be set before they are flushed, so hook writeHead rather than 'finish'.
  res.writeHead = ((...args: Parameters<typeof res.writeHead>) => {
    if (!res.headersSent) {
      res.setHeader('X-DB-Queries', String(ctx.dbQueries));
      if (ctx.cacheStatus) res.setHeader('X-Cache', ctx.cacheStatus);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      res.setHeader('Server-Timing', `app;dur=${ms.toFixed(2)}`);
    }
    return writeHead(...args);
  }) as typeof res.writeHead;
  (req as { id?: string }).id = requestId;
  requestContext.run(ctx, () => next());
};
