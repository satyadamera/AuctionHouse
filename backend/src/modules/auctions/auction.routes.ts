import { Router } from 'express';
import { z } from 'zod';
import { authenticate, optionalAuth, requireRole } from '../../middleware/auth.js';
import { bidLimiter } from '../../middleware/rateLimit.js';
import { idParam, validateRequest } from '../../middleware/validate.js';
import { ok, created, pageMeta } from '../../utils/http.js';
import { getDb } from '../../database/db.js';
import { AppError } from '../../utils/errors.js';
import { env } from '../../config/env.js';
import * as service from './auction.service.js';
import { loadBids } from './auction.repository.js';
import { placeBid } from '../bids/bid.service.js';
import { browseSchema, cancelSchema, createAuctionSchema, placeBidSchema, updateAuctionSchema } from './auction.schemas.js';

export const auctionRouter = Router();

/** Server clock in every auction response lets the UI correct its countdown for client clock skew. */
const serverTime = () => new Date().toISOString();

auctionRouter.get('/', validateRequest({ query: browseSchema }), async (req, res) => {
  const q = req.query as unknown as z.infer<typeof browseSchema>;
  const { items, total } = await service.browseAuctions(q);
  ok(res, items, { ...pageMeta(q.page, q.pageSize, total), serverTime: serverTime() });
});

auctionRouter.get('/featured', async (_req, res) => {
  ok(res, await service.featuredAuctions(), { serverTime: serverTime() });
});

auctionRouter.get('/:id', optionalAuth, validateRequest({ params: idParam }), async (req, res) => {
  // Development-only switch used by the benchmark to measure the uncached path under load.
  const bypass = env.ENABLE_DEV_ROUTES && req.header('x-cache-bypass') === '1';
  const detail = bypass ? await service.getAuctionDetailUncached(Number(req.params.id), req.user) : await service.getAuctionDetail(Number(req.params.id), req.user);
  ok(res, detail, { serverTime: serverTime() });
});

auctionRouter.post('/', authenticate, requireRole('SELLER'), validateRequest({ body: createAuctionSchema }), async (req, res) => {
  created(res, await service.createAuction(req.user!, req.body));
});

auctionRouter.patch('/:id', authenticate, requireRole('SELLER'), validateRequest({ params: idParam, body: updateAuctionSchema }), async (req, res) => {
  ok(res, await service.updateAuction(req.user!, Number(req.params.id), req.body));
});

auctionRouter.post('/:id/publish', authenticate, requireRole('SELLER'), validateRequest({ params: idParam }), async (req, res) => {
  ok(res, await service.publishAuction(req.user!, Number(req.params.id)));
});

auctionRouter.post('/:id/cancel', authenticate, requireRole('SELLER'), validateRequest({ params: idParam, body: cancelSchema }), async (req, res) => {
  ok(res, await service.cancelAuction(req.user!, Number(req.params.id), req.body.reason));
});

const bidsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  before: z.coerce.number().int().positive().optional(),
});

auctionRouter.get('/:id/bids', optionalAuth, validateRequest({ params: idParam, query: bidsQuery }), async (req, res) => {
  const id = Number(req.params.id);
  // Reuse the detail lookup for its 404/draft-visibility rules.
  await service.getAuctionDetail(id, req.user);
  const { limit, before } = req.query as unknown as z.infer<typeof bidsQuery>;
  const bids = await loadBids(getDb(), id, limit, before);
  ok(res, bids, { limit, nextBefore: bids.length === limit ? bids[bids.length - 1]!.id : null });
});

/**
 * Bid submission is a REST call (never a socket message): it is authenticated, validated, rate
 * limited, and answered only after the transaction has committed or been rejected.
 */
auctionRouter.post('/:id/bids', authenticate, bidLimiter, validateRequest({ params: idParam, body: placeBidSchema }), async (req, res) => {
  if (req.user!.role === 'ADMIN') throw new AppError('FORBIDDEN', 'Administrators cannot bid');
  const result = await placeBid({
    auctionId: Number(req.params.id),
    bidderId: req.user!.id,
    amount: req.body.amount,
    clientRequestId: req.body.clientRequestId,
  });
  // 201 for a newly created bid, 200 for an idempotent replay of an existing one.
  res.status(result.replayed ? 200 : 201).json({ success: true, data: result });
});
