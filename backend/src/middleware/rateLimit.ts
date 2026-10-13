import { rateLimit } from 'express-rate-limit';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';

/**
 * In-memory rate limiters (single instance). With multiple API instances these would use a shared
 * Redis store so limits apply across the fleet.
 */
const handler = (_req: unknown, _res: unknown, next: (e: unknown) => void) =>
  next(new AppError('RATE_LIMITED', 'Too many requests, please slow down'));

export const authLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_AUTH_WINDOW_SECONDS * 1000,
  limit: env.RATE_LIMIT_AUTH_MAX,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler,
});

/** Keyed by user id (bidding is authenticated), so one abusive account cannot starve others on a shared IP. */
export const bidLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_BID_WINDOW_SECONDS * 1000,
  limit: env.RATE_LIMIT_BID_MAX,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => `user:${(req as { user?: { id: number } }).user?.id ?? 'anon'}`,
  handler,
});

export const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: env.isTest ? 100_000 : 600,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler,
});
