import { Router } from 'express';
import { sql } from 'kysely';
import { ok } from '../../utils/http.js';
import { getDb } from '../../database/db.js';
import { cached } from '../../cache/cache.js';
import { CacheKeys, CacheTTL } from '../../cache/keys.js';
import { publicStats } from '../auctions/auction.service.js';

export const categoriesRouter = Router();

/** Categories with live-auction counts. Changes rarely → long TTL, invalidated with list caches. */
categoriesRouter.get('/', async (_req, res) => {
  const data = await cached(CacheKeys.categories(), CacheTTL.categories, 'categories', async () => {
    const { rows } = await sql<{ id: number; name: string; slug: string; description: string | null; image_url: string | null; live: number }>`
      SELECT c.id, c.name, c.slug, c.description, c.image_url,
             COUNT(a.id) AS live
        FROM categories c
        LEFT JOIN auctions a ON a.category_id = c.id AND a.status = 'ACTIVE'
       GROUP BY c.id ORDER BY c.name`.execute(getDb());
    return rows.map((r) => ({ id: r.id, name: r.name, slug: r.slug, description: r.description, imageUrl: r.image_url, liveCount: Number(r.live) }));
  });
  ok(res, data);
});

export const statsRouter = Router();
statsRouter.get('/public', async (_req, res) => ok(res, await publicStats()));
