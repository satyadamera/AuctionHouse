import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import type { Request, Response } from 'express';
import { hashRefreshToken, generateRefreshToken, signAccessToken, verifyAccessToken } from '../../src/modules/auth/tokens.js';
import { requireRole, hasRoleAtLeast } from '../../src/middleware/auth.js';
import type { Role } from '../../src/database/types.js';
import { AppError } from '../../src/utils/errors.js';

function runRole(userRole: Role | undefined, ...allowed: Role[]) {
  let result: unknown = 'not-called';
  const req = { user: userRole ? { id: 1, role: userRole, name: 'x' } : undefined } as unknown as Request;
  requireRole(...allowed)(req, {} as Response, (err?: unknown) => {
    result = err ?? 'next';
  });
  return result;
}

describe('requireRole (RBAC)', () => {
  it('lets sellers and admins through a SELLER gate', () => {
    expect(runRole('SELLER', 'SELLER')).toBe('next');
    expect(runRole('ADMIN', 'SELLER')).toBe('next');
  });
  it('blocks a USER from a SELLER gate with FORBIDDEN', () => {
    const r = runRole('USER', 'SELLER');
    expect(r).toBeInstanceOf(AppError);
    expect((r as AppError).code).toBe('FORBIDDEN');
  });
  it('reserves ADMIN gates for admins only', () => {
    expect((runRole('SELLER', 'ADMIN') as AppError).code).toBe('FORBIDDEN');
    expect(runRole('ADMIN', 'ADMIN')).toBe('next');
  });
  it('rejects anonymous requests with UNAUTHENTICATED', () => {
    expect((runRole(undefined, 'USER') as AppError).code).toBe('UNAUTHENTICATED');
  });
  it('orders roles USER < SELLER < ADMIN', () => {
    expect(hasRoleAtLeast('SELLER', 'USER')).toBe(true);
    expect(hasRoleAtLeast('USER', 'SELLER')).toBe(false);
  });
});

describe('access tokens', () => {
  it('round-trips claims', () => {
    const t = signAccessToken({ id: 7, role: 'SELLER', name: 'Meera' });
    const c = verifyAccessToken(t);
    expect(c.sub).toBe('7');
    expect(c.role).toBe('SELLER');
  });
  it('rejects a tampered token', () => {
    const t = signAccessToken({ id: 7, role: 'USER', name: 'x' });
    const [h, p, s] = t.split('.');
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString());
    payload.role = 'ADMIN';
    const forged = `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${s}`;
    expect(() => verifyAccessToken(forged)).toThrowError(AppError);
  });
  it('rejects alg=none tokens', () => {
    const none = jwt.sign({ role: 'ADMIN' }, '', { algorithm: 'none', subject: '1', issuer: 'auctra-api', audience: 'auctra-web' });
    expect(() => verifyAccessToken(none)).toThrowError(AppError);
  });
  it('reports expiry distinctly so the client knows to refresh', () => {
    const expired = jwt.sign({ role: 'USER', name: 'x' }, process.env.JWT_ACCESS_SECRET!, {
      subject: '1', issuer: 'auctra-api', audience: 'auctra-web', expiresIn: -10,
    });
    try {
      verifyAccessToken(expired);
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).code).toBe('TOKEN_EXPIRED');
    }
  });
});

describe('refresh tokens', () => {
  it('are random, high-entropy and stored only as a hash', () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    expect(a.token).not.toBe(b.token);
    expect(a.token.length).toBeGreaterThanOrEqual(43); // 32 bytes base64url
    expect(a.hash).toBe(hashRefreshToken(a.token));
    expect(a.hash).not.toContain(a.token);
  });
});
