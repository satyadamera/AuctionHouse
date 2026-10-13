import { Router } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { validateRequest } from '../../middleware/validate.js';
import { ok } from '../../utils/http.js';
import { getDb } from '../../database/db.js';
import { plainText } from '../../utils/sanitize.js';
import { formatMoney } from '../../utils/money.js';
import { toPublicUser } from '../auth/auth.service.js';
import { summaryQuery, toSummary } from '../auctions/auction.repository.js';

export const usersRouter = Router();
usersRouter.use(authenticate);

// Every route here is scoped to req.user.id taken from the verified token — there is no :userId
// parameter to tamper with, which rules out insecure direct object references by construction.

usersRouter.get('/me', async (req, res) => {
  const u = await getDb().selectFrom('users').selectAll().where('id', '=', req.user!.id).executeTakeFirstOrThrow();
  ok(res, toPublicUser(u));
});

const updateMe = z
  .object({
    name: z.string().transform(plainText).pipe(z.string().min(2).max(80)).optional(),
    avatarUrl: z.string().regex(/^\/uploads\/[A-Za-z0-9._-]+$/).nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update');

usersRouter.patch('/me', validateRequest({ body: updateMe }), async (req, res) => {
  const db = getDb();
  await db
    .updateTable('users')
    .set({ ...(req.body.name ? { name: req.body.name } : {}), ...(req.body.avatarUrl !== undefined ? { avatar_url: req.body.avatarUrl } : {}) })
    .where('id', '=', req.user!.id)
    .execute();
  const u = await db.selectFrom('users').selectAll().where('id', '=', req.user!.id).executeTakeFirstOrThrow();
  ok(res, toPublicUser(u));
});

/**
 * Every auction the user has bid on, with their own highest bid and a derived position:
 * WINNING / OUTBID (still live), WON / LOST (completed), CANCELLED, UPCOMING.
 */
usersRouter.get('/me/bids', async (req, res) => {
  const db = getDb();
  const mine = await db
    .selectFrom('bids')
    .select(['auction_id', (eb) => eb.fn.max('amount').as('my_max'), (eb) => eb.fn.count<number>('id').as('my_bids'), (eb) => eb.fn.max('created_at').as('last_bid_at')])
    .where('bidder_id', '=', req.user!.id)
    .groupBy('auction_id')
    .execute();
  if (!mine.length) return ok(res, []);
  const byAuction = new Map(mine.map((m) => [m.auction_id, m]));
  const rows = await summaryQuery(db)
    .select(['a.current_highest_bidder_id', 'a.winner_id', 'a.final_price'])
    .where('a.id', 'in', [...byAuction.keys()])
    .orderBy('a.end_time', 'desc')
    .execute();
  const userId = req.user!.id;
  ok(
    res,
    rows.map((r) => {
      const m = byAuction.get(r.id)!;
      const position =
        r.status === 'COMPLETED'
          ? r.winner_id === userId
            ? 'WON'
            : 'LOST'
          : r.status === 'CANCELLED'
            ? 'CANCELLED'
            : r.current_highest_bidder_id === userId
              ? 'WINNING'
              : 'OUTBID';
      return {
        auction: toSummary(r),
        myHighestBid: formatMoney(String(m.my_max)),
        myBidCount: Number(m.my_bids),
        lastBidAt: new Date(m.last_bid_at as unknown as string | Date).toISOString(),
        finalPrice: r.final_price ? formatMoney(r.final_price) : null,
        position,
      };
    }),
  );
});

usersRouter.get('/me/won-auctions', async (req, res) => {
  const rows = await summaryQuery(getDb())
    .select(['a.final_price', 'a.completed_at'])
    .where('a.winner_id', '=', req.user!.id)
    .orderBy('a.completed_at', 'desc')
    .execute();
  ok(res, rows.map((r) => ({ auction: toSummary(r), finalPrice: r.final_price ? formatMoney(r.final_price) : null, completedAt: r.completed_at?.toISOString() ?? null })));
});

const listingsQuery = z.object({ status: z.enum(['DRAFT', 'SCHEDULED', 'ACTIVE', 'COMPLETED', 'CANCELLED']).optional() });

usersRouter.get('/me/listings', requireRole('SELLER'), validateRequest({ query: listingsQuery }), async (req, res) => {
  const { status } = req.query as z.infer<typeof listingsQuery>;
  let q = summaryQuery(getDb())
    .select(['a.final_price', 'a.winner_id', 'a.moderation_status', 'a.cancel_reason'])
    .where('a.seller_id', '=', req.user!.id);
  if (status) q = q.where('a.status', '=', status);
  const rows = await q.orderBy('a.created_at', 'desc').execute();
  ok(
    res,
    rows.map((r) => ({ ...toSummary(r), finalPrice: r.final_price ? formatMoney(r.final_price) : null, hasWinner: r.winner_id !== null, moderationStatus: r.moderation_status, cancelReason: r.cancel_reason })),
  );
});

/** Seller dashboard figures: counts by status, revenue, and daily bid activity on their listings. */
usersRouter.get('/me/seller-stats', requireRole('SELLER'), async (req, res) => {
  const db = getDb();
  const sellerId = req.user!.id;
  const byStatus = await db.selectFrom('auctions').select(['status', (eb) => eb.fn.countAll<number>().as('n')]).where('seller_id', '=', sellerId).groupBy('status').execute();
  const { rows: totals } = await sql<{ revenue: string | null; total_bids: number; avg_bids: string | null; highest: string | null }>`
    SELECT SUM(CASE WHEN status = 'COMPLETED' THEN final_price END) AS revenue,
           COALESCE(SUM(bid_count), 0) AS total_bids,
           AVG(bid_count) AS avg_bids,
           MAX(current_highest_bid) AS highest
      FROM auctions WHERE seller_id = ${sellerId}`.execute(db);
  const { rows: daily } = await sql<{ day: string; bids: number; volume: string }>`
    SELECT DATE_FORMAT(b.created_at, '%Y-%m-%d') AS day, COUNT(*) AS bids, SUM(b.amount) AS volume
      FROM bids b JOIN auctions a ON a.id = b.auction_id
     WHERE a.seller_id = ${sellerId} AND b.created_at >= UTC_DATE() - INTERVAL 13 DAY
     GROUP BY day ORDER BY day`.execute(db);
  const t = totals[0]!;
  const counts = Object.fromEntries(['DRAFT', 'SCHEDULED', 'ACTIVE', 'COMPLETED', 'CANCELLED'].map((s) => [s, 0]));
  for (const r of byStatus) counts[r.status] = Number(r.n);
  ok(res, {
    countsByStatus: counts,
    revenue: formatMoney(t.revenue ?? '0'),
    totalBids: Number(t.total_bids),
    averageBidsPerListing: t.avg_bids ? Number(Number(t.avg_bids).toFixed(1)) : 0,
    highestBid: t.highest ? formatMoney(t.highest) : null,
    dailyBids: daily.map((d) => ({ day: d.day, bids: Number(d.bids), volume: formatMoney(d.volume) })),
  });
});
