import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth.js';
import { idParam, validateRequest } from '../../middleware/validate.js';
import { ok, pageMeta } from '../../utils/http.js';
import { getDb } from '../../database/db.js';
import { notFound } from '../../utils/errors.js';

export const notificationsRouter = Router();
notificationsRouter.use(authenticate);

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  unreadOnly: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
});

notificationsRouter.get('/', validateRequest({ query: listQuery }), async (req, res) => {
  const { page, pageSize, unreadOnly } = req.query as unknown as z.infer<typeof listQuery>;
  const db = getDb();
  let q = db.selectFrom('notifications').where('user_id', '=', req.user!.id);
  if (unreadOnly) q = q.where('is_read', '=', 0);
  const [rows, total, unread] = await Promise.all([
    q.selectAll().orderBy('id', 'desc').limit(pageSize).offset((page - 1) * pageSize).execute(),
    q.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
    db.selectFrom('notifications').select((eb) => eb.fn.countAll<number>().as('n')).where('user_id', '=', req.user!.id).where('is_read', '=', 0).executeTakeFirstOrThrow(),
  ]);
  ok(
    res,
    rows.map((n) => ({ id: n.id, type: n.type, title: n.title, message: n.message, auctionId: n.auction_id, isRead: Boolean(n.is_read), createdAt: n.created_at.toISOString() })),
    { ...pageMeta(page, pageSize, Number(total.n)), unreadCount: Number(unread.n) },
  );
});

// Declared before '/:id/read' so "read-all" is not captured as an id.
notificationsRouter.patch('/read-all', async (req, res) => {
  const r = await getDb().updateTable('notifications').set({ is_read: 1 }).where('user_id', '=', req.user!.id).where('is_read', '=', 0).executeTakeFirst();
  ok(res, { updated: Number(r.numUpdatedRows) });
});

notificationsRouter.patch('/:id/read', validateRequest({ params: idParam }), async (req, res) => {
  // The WHERE includes user_id, so someone else's notification id behaves exactly like a missing one
  // (404) — no information leaks about which ids exist.
  const r = await getDb()
    .updateTable('notifications')
    .set({ is_read: 1 })
    .where('id', '=', Number(req.params.id))
    .where('user_id', '=', req.user!.id)
    .executeTakeFirst();
  // mysql2 sets CLIENT_FOUND_ROWS, so numUpdatedRows counts MATCHED rows (already-read still counts as 1).
  if (Number(r.numUpdatedRows) === 0) throw notFound('Notification');
  ok(res, { id: Number(req.params.id), isRead: true });
});
