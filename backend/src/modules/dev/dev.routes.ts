/**
 * DEVELOPMENT-ONLY helpers used by the demo scripts and Playwright test. Mounted only when
 * ENABLE_DEV_ROUTES=true, and env.ts refuses to start production with that flag set.
 */
import { Router } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { idParam, validateRequest } from '../../middleware/validate.js';
import { ok } from '../../utils/http.js';
import { getDb } from '../../database/db.js';
import { AppError, forbidden } from '../../utils/errors.js';
import { formatMoney } from '../../utils/money.js';
import { cacheMetrics } from '../../cache/metrics.js';
import { cacheDel, invalidateAuction } from '../../cache/cache.js';
import { CacheKeys } from '../../cache/keys.js';
import { lockAuction, loadAuctionDetail } from '../auctions/auction.repository.js';
import { runLifecycleOnce } from '../../workers/lifecycleWorker.js';
import { diagnostics } from '../../services/health.js';
import { moneyInput } from '../auctions/auction.schemas.js';

export const devRouter = Router();

const demoBody = z.object({
  title: z.string().max(120).default('Demo Lot — Live Bidding'),
  endsInSeconds: z.coerce.number().int().min(10).max(86_400).default(120),
  startingPrice: moneyInput.default('10000'),
  minimumBidIncrement: moneyInput.default('100'),
  categorySlug: z.string().default('watches'),
  imageUrl: z.string().default('/static/seed/watch-chronograph.svg'),
});

/** Creates an ACTIVE auction owned by the calling seller that ends in N seconds. */
devRouter.post('/demo-auction', authenticate, requireRole('SELLER'), validateRequest({ body: demoBody }), async (req, res) => {
  const db = getDb();
  const b = req.body as z.infer<typeof demoBody>;
  const cat = await db.selectFrom('categories').select('id').where('slug', '=', b.categorySlug).executeTakeFirst();
  if (!cat) throw new AppError('VALIDATION_ERROR', 'Unknown category');
  const id = await db.transaction().execute(async (trx) => {
    const { rows } = await sql<{ now: Date }>`SELECT UTC_TIMESTAMP(3) AS now`.execute(trx);
    const now = rows[0]!.now;
    const end = new Date(now.getTime() + b.endsInSeconds * 1000);
    const r = await trx
      .insertInto('auctions')
      .values({
        seller_id: req.user!.id,
        category_id: cat.id,
        title: b.title,
        description: 'A short-lived auction created by the development demo helper to show live bidding, closing and winner selection.',
        starting_price: formatMoney(b.startingPrice),
        minimum_bid_increment: formatMoney(b.minimumBidIncrement),
        start_time: now,
        end_time: end,
        original_end_time: end,
        status: 'ACTIVE',
      })
      .executeTakeFirstOrThrow();
    const auctionId = Number(r.insertId);
    await trx.insertInto('auction_images').values({ auction_id: auctionId, image_url: b.imageUrl, alt_text: b.title, display_order: 0 }).execute();
    return auctionId;
  });
  await invalidateAuction(id, 1);
  ok(res, await loadAuctionDetail(db, id), undefined, 201);
});

/** Moves an active auction's end time to "now" so the lifecycle worker closes it on its next tick. */
devRouter.post('/auctions/:id/end-now', authenticate, validateRequest({ params: idParam }), async (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const version = await db.transaction().execute(async (trx) => {
    const a = await lockAuction(trx, id);
    if (!a) throw new AppError('AUCTION_NOT_FOUND', 'Auction not found');
    if (a.seller_id !== req.user!.id && req.user!.role !== 'ADMIN') throw forbidden();
    if (a.status !== 'ACTIVE') throw new AppError('AUCTION_NOT_ACTIVE', 'Auction is not active');
    const v = a.version + 1;
    await trx.updateTable('auctions').set({ end_time: a.db_now, version: v }).where('id', '=', id).execute();
    return v;
  });
  await invalidateAuction(id, version);
  ok(res, { auctionId: id, endTime: 'now', note: 'The lifecycle worker will close it on its next tick' });
});

devRouter.post('/lifecycle/run', async (_req, res) => ok(res, await runLifecycleOnce()));

devRouter.get('/cache/metrics', (_req, res) => ok(res, cacheMetrics.snapshot()));
devRouter.post('/cache/metrics/reset', (_req, res) => {
  cacheMetrics.reset();
  ok(res, { reset: true });
});
devRouter.delete('/cache/auction/:id', validateRequest({ params: idParam }), async (req, res) => {
  const id = Number(req.params.id);
  await cacheDel(CacheKeys.auctionDetail(id), CacheKeys.auctionMinVersion(id));
  ok(res, { cleared: CacheKeys.auctionDetail(id) });
});

devRouter.get('/diagnostics', async (_req, res) => ok(res, await diagnostics()));
