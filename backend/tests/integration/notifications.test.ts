import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { getDb } from '../../src/database/db.js';
import { useCleanDatabase } from './setup.js';
import { createAuction, createUser } from '../helpers/fixtures.js';

const app = createApp();
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('notifications & watchlist privacy', () => {
  useCleanDatabase();

  async function noteFor(userId: number) {
    const r = await getDb().insertInto('notifications').values({ user_id: userId, type: 'OUTBID', title: 't', message: 'm' }).executeTakeFirstOrThrow();
    return Number(r.insertId);
  }

  it('lists only my notifications with an unread count', async () => {
    const me = await createUser('USER');
    const other = await createUser('USER');
    await noteFor(me.id);
    await noteFor(me.id);
    await noteFor(other.id);
    const res = await request(app).get('/api/v1/notifications').set(auth(me.token));
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta.unreadCount).toBe(2);
  });

  it('returns 404 when marking someone else’s notification as read (no IDOR, no existence leak)', async () => {
    const me = await createUser('USER');
    const other = await createUser('USER');
    const theirs = await noteFor(other.id);
    const res = await request(app).patch(`/api/v1/notifications/${theirs}/read`).set(auth(me.token));
    expect(res.status).toBe(404);
    const row = await getDb().selectFrom('notifications').select('is_read').where('id', '=', theirs).executeTakeFirstOrThrow();
    expect(row.is_read).toBe(0);
  });

  it('marks one or all as read (idempotently)', async () => {
    const me = await createUser('USER');
    const a = await noteFor(me.id);
    await noteFor(me.id);
    await request(app).patch(`/api/v1/notifications/${a}/read`).set(auth(me.token)).expect(200);
    await request(app).patch(`/api/v1/notifications/${a}/read`).set(auth(me.token)).expect(200);
    const all = await request(app).patch('/api/v1/notifications/read-all').set(auth(me.token));
    expect(all.body.data.updated).toBe(1);
    expect((await request(app).get('/api/v1/notifications').set(auth(me.token))).body.meta.unreadCount).toBe(0);
  });

  it('watch / unwatch is idempotent and drafts cannot be watched', async () => {
    const s = await createUser('SELLER');
    const me = await createUser('USER');
    const id = await createAuction({ sellerId: s.id });
    await request(app).post(`/api/v1/watchlist/${id}`).set(auth(me.token)).expect(200);
    await request(app).post(`/api/v1/watchlist/${id}`).set(auth(me.token)).expect(200);
    expect((await request(app).get('/api/v1/watchlist/ids').set(auth(me.token))).body.data).toEqual([id]);
    await request(app).delete(`/api/v1/watchlist/${id}`).set(auth(me.token)).expect(200);
    expect((await request(app).get('/api/v1/watchlist').set(auth(me.token))).body.data).toEqual([]);
    const draft = await createAuction({ sellerId: s.id, status: 'DRAFT' });
    expect((await request(app).post(`/api/v1/watchlist/${draft}`).set(auth(me.token))).status).toBe(404);
  });
});
