import type { Request, RequestHandler } from 'express';
import { getDb } from '../database/db.js';
import type { Role } from '../database/types.js';
import { AppError } from '../utils/errors.js';
import { verifyAccessToken } from '../modules/auth/tokens.js';

export interface AuthUser {
  id: number;
  role: Role;
  name: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

function bearer(req: Request): string | undefined {
  const h = req.header('authorization');
  if (!h?.startsWith('Bearer ')) return undefined;
  return h.slice(7).trim() || undefined;
}

/**
 * Verifies the access token, then loads the user's CURRENT role and status from MySQL (a primary
 * key lookup). This makes suspensions and role changes take effect immediately rather than when
 * the 15-minute token expires.
 */
export const authenticate: RequestHandler = async (req, _res, next) => {
  const token = bearer(req);
  if (!token) return next(new AppError('UNAUTHENTICATED', 'Authentication required'));
  const claims = verifyAccessToken(token);
  const user = await getDb()
    .selectFrom('users')
    .select(['id', 'role', 'name', 'status'])
    .where('id', '=', Number(claims.sub))
    .executeTakeFirst();
  if (!user) throw new AppError('UNAUTHENTICATED', 'User no longer exists');
  if (user.status === 'SUSPENDED') throw new AppError('ACCOUNT_SUSPENDED', 'This account has been suspended');
  req.user = { id: user.id, role: user.role, name: user.name };
  next();
};

/** Attaches req.user when a valid token is present; anonymous otherwise. Never rejects. */
export const optionalAuth: RequestHandler = async (req, res, next) => {
  if (!bearer(req)) return next();
  try {
    await authenticate(req, res, () => undefined);
  } catch {
    req.user = undefined;
  }
  next();
};

/**
 * Role gate. ADMIN implicitly has SELLER and USER capabilities; SELLER has USER capabilities.
 * Ownership checks (e.g. "is this MY auction") are done in services, because they need the row.
 */
const rank: Record<Role, number> = { USER: 1, SELLER: 2, ADMIN: 3 };

export function requireRole(...allowed: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) return next(new AppError('UNAUTHENTICATED', 'Authentication required'));
    const ok = allowed.some((r) => (r === 'ADMIN' ? req.user!.role === 'ADMIN' : rank[req.user!.role] >= rank[r]));
    if (!ok) return next(new AppError('FORBIDDEN', `This action requires role: ${allowed.join(' or ')}`));
    next();
  };
}

export function hasRoleAtLeast(role: Role, min: Role) {
  return rank[role] >= rank[min];
}

/**
 * CSRF defence for the cookie-authenticated endpoints (/auth/refresh, /auth/logout).
 * The refresh cookie is SameSite=Strict, and additionally these endpoints require a custom header.
 * Browsers cannot attach custom headers to cross-site form posts, and a cross-origin fetch with one
 * triggers a CORS preflight that our origin allow-list rejects.
 */
export const requireCsrfHeader: RequestHandler = (req, _res, next) => {
  if (req.header('x-auctra-csrf') !== '1') {
    return next(new AppError('CSRF_CHECK_FAILED', 'Missing CSRF protection header'));
  }
  next();
};
