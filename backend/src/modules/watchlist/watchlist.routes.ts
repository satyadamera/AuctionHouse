import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth.js';
import { validateRequest } from '../../middleware/validate.js';
import { ok } from '../../utils/http.js';
import { getDb } from '../../database/db.js';
import { AppError } from '../../utils/errors.js';
import { summaryQuery, toSummary } from '../auctions/auction.repository.js';

export const watchlistRouter = Router();
watchlistRouter.use(authenticate);

const auctionParam = z.object({ auctionId: z.coerce.number().int().positive() });

watchlistRouter.get('/', async (req, res) => {
  const rows = await summaryQuery(getDb())
    .innerJoin('watchlist as w', 'w.auction_id', 'a.id')
    .where('w.user_id', '=', req.user!.id)
    .orderBy('w.created_at', 'desc')
    .execute();
  ok(res, rows.map(toSummary));
});

/** Just the ids — lets the UI render heart icons on any page without loading full summaries. */
watchlistRouter.get('/ids', async (req, res) => {
  const rows = await getDb().selectFrom('watchlist').select('auction_id').where('user_id', '=', req.user!.id).execute();
  ok(res, rows.map((r) => r.auction_id));
});

watchlistRouter.post('/:auctionId', validateRequest({ params: auctionParam }), async (req, res) => {
  const auctionId = Number(req.params.auctionId);
  const db = getDb();
  const a = await db.selectFrom('auctions').select(['status']).where('id', '=', auctionId).executeTakeFirst();
  if (!a || a.status === 'DRAFT') throw new AppError('AUCTION_NOT_FOUND', 'Auction not found');
  // INSERT IGNORE makes "watch" idempotent: watching twice is not an error.
  await db.insertInto('watchlist').ignore().values({ user_id: req.user!.id, auction_id: auctionId }).execute();
  ok(res, { auctionId, watching: true });
});

watchlistRouter.delete('/:auctionId', validateRequest({ params: auctionParam }), async (req, res) => {
  const auctionId = Number(req.params.auctionId);
  await getDb().deleteFrom('watchlist').where('user_id', '=', req.user!.id).where('auction_id', '=', auctionId).execute();
  ok(res, { auctionId, watching: false });
});
