import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { getDb } from '../../src/database/db.js';
import { useCleanDatabase } from './setup.js';
import { createAuction, createCategory, createUser, dbNow } from '../helpers/fixtures.js';

const app = createApp();
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function body(startOffset = 60_000, endOffset = 3_600_000) {
  const now = await dbNow();
  return {
    title: 'Vintage chronograph',
    description: 'Serviced, original dial and hands.',
    categoryId: await createCategory(),
    startingPrice: '5000',
    minimumBidIncrement: '100.50',
    startTime: new Date(now.getTime() + startOffset).toISOString(),
    endTime: new Date(now.getTime() + endOffset).toISOString(),
    imageUrls: ['/static/seed/watch-dress.svg'],
  };
}

describe('auction management & RBAC', () => {
  useCleanDatabase();

  it('lets a seller create a draft', async () => {
    const s = await createUser('SELLER');
    const res = await request(app).post('/api/v1/auctions').set(auth(s.token)).send(await body());
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'DRAFT', startingPrice: '5000.00', minimumBidIncrement: '100.50' });
    const log = await getDb().selectFrom('audit_logs').select('action').where('action', '=', 'AUCTION_CREATED').execute();
    expect(log).toHaveLength(1);
  });

  it('forbids a plain USER from creating listings', async () => {
    const u = await createUser('USER');
    const res = await request(app).post('/api/v1/auctions').set(auth(u.token)).send(await body());
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('rejects anonymous listing creation', async () => {
    expect((await request(app).post('/api/v1/auctions').send(await body())).status).toBe(401);
  });

  it('validates input and reports field details', async () => {
    const s = await createUser('SELLER');
    const res = await request(app).post('/api/v1/auctions').set(auth(s.token)).send({ ...(await body()), startingPrice: '-1', title: '' });
    expect(res.status).toBe(400);
    const paths = res.body.error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['startingPrice', 'title']));
  });

  it('refuses images that were not uploaded through the API', async () => {
    const s = await createUser('SELLER');
    const res = await request(app).post('/api/v1/auctions').set(auth(s.token)).send({ ...(await body()), imageUrls: ['https://evil.example/x.png'] });
    expect(res.status).toBe(400);
  });

  it('strips HTML from titles and descriptions', async () => {
    const s = await createUser('SELLER');
    const res = await request(app).post('/api/v1/auctions').set(auth(s.token)).send({ ...(await body()), title: '<b>Rare</b> watch<script>x</script>' });
    expect(res.body.data.title).toBe('Rare watchx');
  });

  it('publishes to SCHEDULED when start is in the future and ACTIVE when it has passed', async () => {
    const s = await createUser('SELLER');
    const future = await request(app).post('/api/v1/auctions').set(auth(s.token)).send(await body(3_600_000, 7_200_000));
    expect((await request(app).post(`/api/v1/auctions/${future.body.data.id}/publish`).set(auth(s.token))).body.data.status).toBe('SCHEDULED');
    const now = await request(app).post('/api/v1/auctions').set(auth(s.token)).send({ ...(await body(0)), publish: true });
    expect(now.body.data.status).toBe('ACTIVE');
    const notes = await getDb().selectFrom('notifications').select('type').where('user_id', '=', s.id).execute();
    expect(notes.map((n) => n.type)).toEqual(['LISTING_APPROVED', 'LISTING_APPROVED']);
  });

  it('cannot publish twice (state machine)', async () => {
    const s = await createUser('SELLER');
    const a = await request(app).post('/api/v1/auctions').set(auth(s.token)).send({ ...(await body()), publish: true });
    const again = await request(app).post(`/api/v1/auctions/${a.body.data.id}/publish`).set(auth(s.token));
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('prevents a seller from editing, publishing or cancelling another seller’s auction (IDOR)', async () => {
    const owner = await createUser('SELLER');
    const other = await createUser('SELLER');
    const a = await request(app).post('/api/v1/auctions').set(auth(owner.token)).send(await body());
    const id = a.body.data.id;
    expect((await request(app).patch(`/api/v1/auctions/${id}`).set(auth(other.token)).send({ title: 'Hijacked' })).status).toBe(403);
    expect((await request(app).post(`/api/v1/auctions/${id}/publish`).set(auth(other.token))).status).toBe(403);
    expect((await request(app).post(`/api/v1/auctions/${id}/cancel`).set(auth(other.token)).send({ reason: 'mine now' })).status).toBe(403);
  });

  it('hides drafts from everyone except the owner and admins', async () => {
    const owner = await createUser('SELLER');
    const stranger = await createUser('USER');
    const admin = await createUser('ADMIN');
    const id = (await request(app).post('/api/v1/auctions').set(auth(owner.token)).send(await body())).body.data.id;
    expect((await request(app).get(`/api/v1/auctions/${id}`)).status).toBe(404);
    expect((await request(app).get(`/api/v1/auctions/${id}`).set(auth(stranger.token))).status).toBe(404);
    expect((await request(app).get(`/api/v1/auctions/${id}`).set(auth(owner.token))).status).toBe(200);
    expect((await request(app).get(`/api/v1/auctions/${id}`).set(auth(admin.token))).status).toBe(200);
  });

  it('does not allow editing a live auction', async () => {
    const s = await createUser('SELLER');
    const id = await createAuction({ sellerId: s.id });
    const res = await request(app).patch(`/api/v1/auctions/${id}`).set(auth(s.token)).send({ startingPrice: '1' });
    expect(res.status).toBe(409);
  });

  it('lets a seller cancel a live auction only while it has no bids', async () => {
    const s = await createUser('SELLER');
    const b = await createUser('USER');
    const empty = await createAuction({ sellerId: s.id });
    expect((await request(app).post(`/api/v1/auctions/${empty}/cancel`).set(auth(s.token)).send({ reason: 'Changed my mind' })).body.data.status).toBe('CANCELLED');
    const withBids = await createAuction({ sellerId: s.id, highest: { bidderId: b.id, amount: '1000.00' } });
    const res = await request(app).post(`/api/v1/auctions/${withBids}/cancel`).set(auth(s.token)).send({ reason: 'Changed my mind' });
    expect(res.status).toBe(409);
  });

  it('lets an admin cancel a live auction with bids and notifies bidders', async () => {
    const s = await createUser('SELLER');
    const b = await createUser('USER');
    const admin = await createUser('ADMIN');
    const id = await createAuction({ sellerId: s.id, highest: { bidderId: b.id, amount: '1000.00' } });
    const res = await request(app).post(`/api/v1/admin/auctions/${id}/cancel`).set(auth(admin.token)).send({ reason: 'Counterfeit reported' });
    expect(res.body.data).toMatchObject({ status: 'CANCELLED', cancelReason: 'Counterfeit reported' });
    const notes = await getDb().selectFrom('notifications').select(['user_id', 'type']).execute();
    expect(notes).toEqual(expect.arrayContaining([{ user_id: b.id, type: 'AUCTION_CANCELLED' }, { user_id: s.id, type: 'AUCTION_CANCELLED' }]));
  });

  it('browses with filters, search, sorting and pagination', async () => {
    const s = await createUser('SELLER');
    const b = await createUser('USER');
    await createAuction({ sellerId: s.id, title: 'Alpha camera', startingPrice: '1000.00' });
    await createAuction({ sellerId: s.id, title: 'Beta watch', startingPrice: '5000.00', highest: { bidderId: b.id, amount: '9000.00' } });
    await createAuction({ sellerId: s.id, title: 'Gamma watch', startingPrice: '3000.00' });
    await createAuction({ sellerId: s.id, title: 'Draft thing', status: 'DRAFT' });

    const all = await request(app).get('/api/v1/auctions?sort=price_desc');
    expect(all.body.data.map((a: { title: string }) => a.title)).toEqual(['Beta watch', 'Gamma watch', 'Alpha camera']);
    expect(all.body.meta.total).toBe(3);

    const search = await request(app).get('/api/v1/auctions?q=watch&sort=price_asc');
    expect(search.body.data.map((a: { title: string }) => a.title)).toEqual(['Gamma watch', 'Beta watch']);

    const price = await request(app).get('/api/v1/auctions?minPrice=2000&maxPrice=6000');
    expect(price.body.data.map((a: { title: string }) => a.title)).toEqual(['Gamma watch']);

    const paged = await request(app).get('/api/v1/auctions?pageSize=2&page=2&sort=price_desc');
    expect(paged.body.data).toHaveLength(1);
    expect(paged.body.meta).toMatchObject({ page: 2, totalPages: 2 });

    expect((await request(app).get('/api/v1/auctions?sort=bogus')).status).toBe(400);
  });

  it('treats LIKE wildcards in search literally', async () => {
    const s = await createUser('SELLER');
    await createAuction({ sellerId: s.id, title: 'Plain lot' });
    expect((await request(app).get('/api/v1/auctions?q=%25')).body.data).toHaveLength(0);
  });
});

describe('admin authorization', () => {
  useCleanDatabase();

  it('blocks USER and SELLER from every admin endpoint', async () => {
    for (const role of ['USER', 'SELLER'] as const) {
      const u = await createUser(role);
      for (const path of ['/api/v1/admin/dashboard', '/api/v1/admin/users', '/api/v1/admin/auctions', '/api/v1/admin/audit-logs']) {
        const res = await request(app).get(path).set(auth(u.token));
        expect(res.status, `${role} ${path}`).toBe(403);
      }
    }
  });

  it('serves the dashboard and user management to admins', async () => {
    const admin = await createUser('ADMIN');
    const u = await createUser('USER');
    const dash = await request(app).get('/api/v1/admin/dashboard').set(auth(admin.token));
    expect(dash.status).toBe(200);
    expect(dash.body.data.totals.users).toBe(2);
    const sus = await request(app).patch(`/api/v1/admin/users/${u.id}/status`).set(auth(admin.token)).send({ status: 'SUSPENDED' });
    expect(sus.body.data.status).toBe('SUSPENDED');
    expect((await request(app).get('/api/v1/users/me').set(auth(u.token))).status).toBe(403);
    expect((await request(app).patch(`/api/v1/admin/users/${admin.id}/status`).set(auth(admin.token)).send({ status: 'SUSPENDED' })).status).toBe(403);
  });
});
