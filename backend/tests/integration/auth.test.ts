import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { sql } from 'kysely';
import { createApp } from '../../src/app.js';
import { getDb } from '../../src/database/db.js';
import { useCleanDatabase } from './setup.js';
import { createUser, PASSWORD } from '../helpers/fixtures.js';

const app = createApp();
const CSRF = { 'X-Auctra-CSRF': '1' };

function refreshCookie(res: request.Response): string {
  const raw = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const c = raw.find((x) => x.startsWith('auctra_rt='));
  if (!c) throw new Error('no refresh cookie');
  return c.split(';')[0]!;
}

describe('authentication', () => {
  useCleanDatabase();

  it('registers a user, returns an access token and sets an HttpOnly SameSite=Strict refresh cookie', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({ name: 'Nia Patel', email: 'Nia@Example.com', password: 'Secret123' });
    expect(res.status).toBe(201);
    expect(res.body.data.user).toMatchObject({ email: 'nia@example.com', role: 'USER' });
    expect(res.body.data.accessToken).toBeTypeOf('string');
    expect(res.body.data.user.passwordHash).toBeUndefined();
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('auctra_rt='))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
    expect(res.body.data.refreshToken).toBeUndefined(); // never exposed to JavaScript
  });

  it('refuses self-registration as ADMIN', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({ name: 'Mallory', email: 'm@x.dev', password: 'Secret123', role: 'ADMIN' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects weak passwords and duplicate emails', async () => {
    expect((await request(app).post('/api/v1/auth/register').send({ name: 'Aa', email: 'a@x.dev', password: 'short' })).status).toBe(400);
    await request(app).post('/api/v1/auth/register').send({ name: 'First', email: 'dup@x.dev', password: 'Secret123' }).expect(201);
    const dup = await request(app).post('/api/v1/auth/register').send({ name: 'Second', email: 'DUP@x.dev', password: 'Secret123' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('EMAIL_IN_USE');
  });

  it('logs in with valid credentials', async () => {
    const u = await createUser('USER');
    const res = await request(app).post('/api/v1/auth/login').send({ email: u.email, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.user.id).toBe(u.id);
  });

  it('gives the same error for a wrong password and an unknown email (no user enumeration)', async () => {
    const u = await createUser('USER');
    const wrong = await request(app).post('/api/v1/auth/login').send({ email: u.email, password: 'nope-nope1' });
    const unknown = await request(app).post('/api/v1/auth/login').send({ email: 'ghost@x.dev', password: 'nope-nope1' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
  });

  it('rejects suspended accounts at login and on existing tokens', async () => {
    const u = await createUser('USER');
    await getDb().updateTable('users').set({ status: 'SUSPENDED' }).where('id', '=', u.id).execute();
    expect((await request(app).post('/api/v1/auth/login').send({ email: u.email, password: PASSWORD })).body.error.code).toBe('ACCOUNT_SUSPENDED');
    const me = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${u.token}`);
    expect(me.status).toBe(403);
  });

  it('rotates the refresh token: the new one works, the old one is rejected', async () => {
    const u = await createUser('USER');
    const login = await request(app).post('/api/v1/auth/login').send({ email: u.email, password: PASSWORD });
    const first = refreshCookie(login);
    const r1 = await request(app).post('/api/v1/auth/refresh').set('Cookie', first).set(CSRF);
    expect(r1.status).toBe(200);
    const second = refreshCookie(r1);
    expect(second).not.toBe(first);
    expect((await request(app).post('/api/v1/auth/refresh').set('Cookie', first).set(CSRF)).status).toBe(401);
    expect((await request(app).post('/api/v1/auth/refresh').set('Cookie', second).set(CSRF)).status).toBe(200);
  });

  it('revokes the whole token family when a rotated token is reused after the grace window', async () => {
    const u = await createUser('USER');
    const first = refreshCookie(await request(app).post('/api/v1/auth/login').send({ email: u.email, password: PASSWORD }));
    const second = refreshCookie(await request(app).post('/api/v1/auth/refresh').set('Cookie', first).set(CSRF));
    // Simulate a thief replaying the old token a minute later.
    await sql`UPDATE refresh_sessions SET rotated_at = UTC_TIMESTAMP(3) - INTERVAL 60 SECOND WHERE rotated_at IS NOT NULL`.execute(getDb());
    expect((await request(app).post('/api/v1/auth/refresh').set('Cookie', first).set(CSRF)).status).toBe(401);
    // ...and the legitimate holder of the newest token is logged out too.
    expect((await request(app).post('/api/v1/auth/refresh').set('Cookie', second).set(CSRF)).status).toBe(401);
    const audit = await getDb().selectFrom('audit_logs').select('action').where('action', '=', 'REFRESH_TOKEN_REUSE').execute();
    expect(audit).toHaveLength(1);
  });

  it('requires the CSRF header on refresh', async () => {
    const u = await createUser('USER');
    const cookie = refreshCookie(await request(app).post('/api/v1/auth/login').send({ email: u.email, password: PASSWORD }));
    const res = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_CHECK_FAILED');
  });

  it('logout revokes the session', async () => {
    const u = await createUser('USER');
    const cookie = refreshCookie(await request(app).post('/api/v1/auth/login').send({ email: u.email, password: PASSWORD }));
    await request(app).post('/api/v1/auth/logout').set('Cookie', cookie).set(CSRF).expect(200);
    expect((await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie).set(CSRF)).status).toBe(401);
  });

  it('protects /auth/me', async () => {
    expect((await request(app).get('/api/v1/auth/me')).status).toBe(401);
    expect((await request(app).get('/api/v1/auth/me').set('Authorization', 'Bearer not.a.jwt')).status).toBe(401);
  });

  it('never returns password hashes in any user payload', async () => {
    const u = await createUser('USER');
    const res = await request(app).get('/api/v1/users/me').set('Authorization', `Bearer ${u.token}`);
    expect(JSON.stringify(res.body)).not.toMatch(/password/i);
  });
});
