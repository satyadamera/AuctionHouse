import { Router } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { idParam, validateRequest } from '../../middleware/validate.js';
import { ok, pageMeta } from '../../utils/http.js';
import { getDb } from '../../database/db.js';
import { AppError, notFound } from '../../utils/errors.js';
import { formatMoney } from '../../utils/money.js';
import { cached } from '../../cache/cache.js';
import { CacheKeys, CacheTTL } from '../../cache/keys.js';
import { recordAudit } from '../../services/audit.js';
import { revokeAllSessions, toPublicUser } from '../auth/auth.service.js';
import { summaryQuery, toSummary } from '../auctions/auction.repository.js';
import { cancelAuction, setFeatured } from '../auctions/auction.service.js';
import { cancelSchema } from '../auctions/auction.schemas.js';

export const adminRouter = Router();
// Every admin route requires an authenticated ADMIN — enforced once, here, for the whole router.
adminRouter.use(authenticate, requireRole('ADMIN'));

adminRouter.get('/dashboard', async (_req, res) => {
  const data = await cached(CacheKeys.adminSummary(), CacheTTL.adminSummary, 'admin', async () => {
    const db = getDb();
    const { rows } = await sql<Record<string, number | string | null>>`
      SELECT (SELECT COUNT(*) FROM users) AS total_users,
             (SELECT COUNT(*) FROM users WHERE status = 'SUSPENDED') AS suspended_users,
             (SELECT COUNT(*) FROM auctions) AS total_auctions,
             (SELECT COUNT(*) FROM auctions WHERE status = 'ACTIVE') AS active_auctions,
             (SELECT COUNT(*) FROM auctions WHERE status = 'SCHEDULED') AS scheduled_auctions,
             (SELECT COUNT(*) FROM auctions WHERE status = 'COMPLETED') AS completed_auctions,
             (SELECT COUNT(*) FROM auctions WHERE status = 'CANCELLED') AS cancelled_auctions,
             (SELECT COUNT(*) FROM bids) AS total_bids,
             (SELECT COALESCE(SUM(final_price), 0) FROM auctions WHERE status = 'COMPLETED') AS gmv`.execute(db);
    const r = rows[0]!;
    const { rows: daily } = await sql<{ day: string; bids: number; volume: string }>`
      SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS day, COUNT(*) AS bids, SUM(amount) AS volume
        FROM bids WHERE created_at >= UTC_DATE() - INTERVAL 13 DAY
       GROUP BY day ORDER BY day`.execute(db);
    const { rows: byCategory } = await sql<{ name: string; auctions: number; bids: number }>`
      SELECT c.name, COUNT(a.id) AS auctions, COALESCE(SUM(a.bid_count), 0) AS bids
        FROM categories c LEFT JOIN auctions a ON a.category_id = c.id
       GROUP BY c.id ORDER BY bids DESC`.execute(db);
    const hot = await summaryQuery(db).where('a.status', '=', 'ACTIVE').orderBy('a.bid_count', 'desc').limit(5).execute();
    const n = (k: string) => Number(r[k] ?? 0);
    return {
      totals: {
        users: n('total_users'),
        suspendedUsers: n('suspended_users'),
        auctions: n('total_auctions'),
        activeAuctions: n('active_auctions'),
        scheduledAuctions: n('scheduled_auctions'),
        completedAuctions: n('completed_auctions'),
        cancelledAuctions: n('cancelled_auctions'),
        bids: n('total_bids'),
        grossMerchandiseValue: formatMoney(String(r.gmv ?? '0')),
      },
      dailyBids: daily.map((d) => ({ day: d.day, bids: Number(d.bids), volume: formatMoney(d.volume) })),
      byCategory: byCategory.map((c) => ({ name: c.name, auctions: Number(c.auctions), bids: Number(c.bids) })),
      hottestAuctions: hot.map(toSummary),
    };
  });
  ok(res, data);
});

const usersQuery = z.object({
  q: z.string().trim().max(100).optional(),
  role: z.enum(['USER', 'SELLER', 'ADMIN']).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

adminRouter.get('/users', validateRequest({ query: usersQuery }), async (req, res) => {
  const { q, role, status, page, pageSize } = req.query as unknown as z.infer<typeof usersQuery>;
  let base = getDb().selectFrom('users as u');
  if (q) base = base.where((eb) => eb.or([eb('u.name', 'like', `%${q.replace(/[\\%_]/g, '\\$&')}%`), eb('u.email', 'like', `%${q.replace(/[\\%_]/g, '\\$&')}%`)]));
  if (role) base = base.where('u.role', '=', role);
  if (status) base = base.where('u.status', '=', status);
  const [rows, total] = await Promise.all([
    base
      .selectAll('u')
      .select((eb) => [
        eb.selectFrom('bids').select(eb.fn.countAll<number>().as('n')).whereRef('bids.bidder_id', '=', 'u.id').as('bid_count'),
        eb.selectFrom('auctions').select(eb.fn.countAll<number>().as('n')).whereRef('auctions.seller_id', '=', 'u.id').as('listing_count'),
      ])
      .orderBy('u.id')
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .execute(),
    base.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
  ]);
  ok(res, rows.map((u) => ({ ...toPublicUser(u), bidCount: Number(u.bid_count ?? 0), listingCount: Number(u.listing_count ?? 0) })), pageMeta(page, pageSize, Number(total.n)));
});

const statusBody = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']), reason: z.string().trim().max(300).optional() });

adminRouter.patch('/users/:id/status', validateRequest({ params: idParam, body: statusBody }), async (req, res) => {
  const targetId = Number(req.params.id);
  if (targetId === req.user!.id) throw new AppError('FORBIDDEN', 'You cannot change your own status');
  const db = getDb();
  const target = await db.selectFrom('users').selectAll().where('id', '=', targetId).executeTakeFirst();
  if (!target) throw notFound('User');
  if (target.role === 'ADMIN') throw new AppError('FORBIDDEN', 'Administrators cannot be suspended here');
  await db.transaction().execute(async (trx) => {
    await trx.updateTable('users').set({ status: req.body.status }).where('id', '=', targetId).execute();
    await recordAudit(trx, { actorId: req.user!.id, action: req.body.status === 'SUSPENDED' ? 'ADMIN_USER_SUSPENDED' : 'ADMIN_USER_REACTIVATED', entityType: 'user', entityId: targetId, metadata: { reason: req.body.reason ?? null } });
  });
  // Suspension also kills refresh sessions; existing access tokens are rejected by authenticate()'s
  // live status check, so the suspension takes effect on the very next request.
  if (req.body.status === 'SUSPENDED') await revokeAllSessions(targetId);
  const updated = await db.selectFrom('users').selectAll().where('id', '=', targetId).executeTakeFirstOrThrow();
  ok(res, toPublicUser(updated));
});

const roleBody = z.object({ role: z.enum(['USER', 'SELLER']) });

adminRouter.patch('/users/:id/role', validateRequest({ params: idParam, body: roleBody }), async (req, res) => {
  const targetId = Number(req.params.id);
  const db = getDb();
  const target = await db.selectFrom('users').select(['role']).where('id', '=', targetId).executeTakeFirst();
  if (!target) throw notFound('User');
  if (target.role === 'ADMIN') throw new AppError('FORBIDDEN', 'Administrator roles cannot be changed here');
  await db.transaction().execute(async (trx) => {
    await trx.updateTable('users').set({ role: req.body.role }).where('id', '=', targetId).execute();
    await recordAudit(trx, { actorId: req.user!.id, action: 'ADMIN_ROLE_CHANGED', entityType: 'user', entityId: targetId, metadata: { from: target.role, to: req.body.role } });
  });
  ok(res, toPublicUser(await db.selectFrom('users').selectAll().where('id', '=', targetId).executeTakeFirstOrThrow()));
});

const auctionsQuery = z.object({
  status: z.enum(['DRAFT', 'SCHEDULED', 'ACTIVE', 'COMPLETED', 'CANCELLED']).optional(),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

adminRouter.get('/auctions', validateRequest({ query: auctionsQuery }), async (req, res) => {
  const { status, q, page, pageSize } = req.query as unknown as z.infer<typeof auctionsQuery>;
  let base = summaryQuery(getDb()).select(['a.moderation_status', 'a.cancel_reason']);
  if (status) base = base.where('a.status', '=', status);
  if (q) base = base.where('a.title', 'like', `%${q.replace(/[\\%_]/g, '\\$&')}%`);
  const [rows, total] = await Promise.all([
    base.orderBy('a.id', 'desc').limit(pageSize).offset((page - 1) * pageSize).execute(),
    base.clearSelect().select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
  ]);
  ok(res, rows.map((r) => ({ ...toSummary(r), moderationStatus: r.moderation_status, cancelReason: r.cancel_reason })), pageMeta(page, pageSize, Number(total.n)));
});

adminRouter.post('/auctions/:id/cancel', validateRequest({ params: idParam, body: cancelSchema }), async (req, res) => {
  ok(res, await cancelAuction(req.user!, Number(req.params.id), req.body.reason));
});

/** Moderation: reject a listing (cancels it and notifies the seller with LISTING_REJECTED). */
adminRouter.post('/auctions/:id/reject', validateRequest({ params: idParam, body: cancelSchema }), async (req, res) => {
  ok(res, await cancelAuction(req.user!, Number(req.params.id), req.body.reason, { asRejection: true }));
});

adminRouter.patch('/auctions/:id/feature', validateRequest({ params: idParam, body: z.object({ isFeatured: z.boolean() }) }), async (req, res) => {
  ok(res, await setFeatured(req.user!, Number(req.params.id), req.body.isFeatured));
});

const auditQuery = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(30) });

adminRouter.get('/audit-logs', validateRequest({ query: auditQuery }), async (req, res) => {
  const { page, pageSize } = req.query as unknown as z.infer<typeof auditQuery>;
  const db = getDb();
  const [rows, total] = await Promise.all([
    db
      .selectFrom('audit_logs as l')
      .leftJoin('users as u', 'u.id', 'l.actor_id')
      .select(['l.id', 'l.action', 'l.entity_type', 'l.entity_id', 'l.metadata', 'l.created_at', 'u.name as actor_name', 'l.actor_id'])
      .orderBy('l.id', 'desc')
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .execute(),
    db.selectFrom('audit_logs').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
  ]);
  ok(
    res,
    rows.map((r) => ({ id: r.id, action: r.action, entityType: r.entity_type, entityId: r.entity_id, metadata: r.metadata, actor: r.actor_id ? { id: r.actor_id, name: r.actor_name } : null, createdAt: r.created_at.toISOString() })),
    pageMeta(page, pageSize, Number(total.n)),
  );
});

adminRouter.get('/diagnostics', async (_req, res) => {
  const { diagnostics } = await import('../../services/health.js');
  ok(res, await diagnostics());
});
