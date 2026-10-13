import { Router, type CookieOptions, type Response } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { authenticate, requireCsrfHeader } from '../../middleware/auth.js';
import { authLimiter } from '../../middleware/rateLimit.js';
import { validateRequest } from '../../middleware/validate.js';
import { ok, created } from '../../utils/http.js';
import { getDb } from '../../database/db.js';
import { notFound } from '../../utils/errors.js';
import * as auth from './auth.service.js';
import { REFRESH_COOKIE } from './tokens.js';

const email = z.string().trim().toLowerCase().email().max(191);
const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(72, 'Password must be at most 72 characters') // bcrypt ignores bytes beyond 72
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/[0-9]/, 'Password must contain a number');

export const registerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email,
  password,
  // Self-service sign-up may choose to sell. ADMIN can never be self-assigned.
  role: z.enum(['USER', 'SELLER']).default('USER'),
});
const loginSchema = z.object({ email, password: z.string().min(1).max(200) });

/**
 * Refresh cookie: HttpOnly (JS cannot read it), SameSite=Strict (not sent on cross-site requests),
 * Secure in production (HTTPS only), and scoped to /api/v1/auth so it is not sent with every API call.
 */
function cookieOptions(expires?: Date): CookieOptions {
  return {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: 'strict',
    path: '/api/v1/auth',
    ...(expires ? { expires } : {}),
  };
}

function sendSession(res: Response, result: auth.AuthResult, status = 200) {
  res.cookie(REFRESH_COOKIE, result.refreshToken, cookieOptions(result.refreshTokenExpiresAt));
  const body = { user: result.user, accessToken: result.accessToken, expiresIn: result.accessTokenExpiresIn };
  return status === 201 ? created(res, body) : ok(res, body);
}

export const authRouter = Router();

authRouter.post('/register', authLimiter, validateRequest({ body: registerSchema }), async (req, res) => {
  sendSession(res, await auth.register(req.body, req.header('user-agent')), 201);
});

authRouter.post('/login', authLimiter, validateRequest({ body: loginSchema }), async (req, res) => {
  sendSession(res, await auth.login(req.body.email, req.body.password, req.header('user-agent')));
});

authRouter.post('/refresh', requireCsrfHeader, async (req, res) => {
  try {
    sendSession(res, await auth.refresh(req.cookies?.[REFRESH_COOKIE], req.header('user-agent')));
  } catch (err) {
    // Only clear the cookie for definitive failures; the multi-tab "already rotated" case keeps it.
    if (!(err instanceof Error && err.message.includes('retry'))) res.clearCookie(REFRESH_COOKIE, cookieOptions());
    throw err;
  }
});

authRouter.post('/logout', requireCsrfHeader, async (req, res) => {
  await auth.logout(req.cookies?.[REFRESH_COOKIE]);
  res.clearCookie(REFRESH_COOKIE, cookieOptions());
  ok(res, { loggedOut: true });
});

authRouter.get('/me', authenticate, async (req, res) => {
  const user = await getDb().selectFrom('users').selectAll().where('id', '=', req.user!.id).executeTakeFirst();
  if (!user) throw notFound('User');
  ok(res, auth.toPublicUser(user));
});
