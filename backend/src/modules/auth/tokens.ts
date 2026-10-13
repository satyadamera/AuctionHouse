import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import type { Role } from '../../database/types.js';
import { AppError } from '../../utils/errors.js';

export interface AccessTokenClaims {
  sub: string; // user id
  role: Role;
  name: string;
}

const ISSUER = 'auctra-api';
const AUDIENCE = 'auctra-web';

/**
 * Access token: short-lived (15 min default) signed JWT. The SPA keeps it in memory only — never
 * localStorage — so an XSS bug cannot exfiltrate a long-lived credential from storage.
 */
export function signAccessToken(user: { id: number; role: Role; name: string }): string {
  return jwt.sign({ role: user.role, name: user.name } satisfies Omit<AccessTokenClaims, 'sub'>, env.JWT_ACCESS_SECRET, {
    subject: String(user.id),
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithm: 'HS256',
  });
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  try {
    return jwt.verify(token, env.JWT_ACCESS_SECRET, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'], // pin the algorithm — never accept "none" or an attacker-chosen alg
    }) as AccessTokenClaims;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) throw new AppError('TOKEN_EXPIRED', 'Access token expired');
    throw new AppError('UNAUTHENTICATED', 'Invalid access token');
  }
}

/**
 * Refresh token: 256 bits of randomness, opaque (not a JWT), stored only as a SHA-256 hash.
 * A database leak therefore does not leak usable refresh tokens. SHA-256 (not bcrypt) is fine here
 * because the input is high-entropy random data, not a guessable password.
 */
export function generateRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export const REFRESH_COOKIE = 'auctra_rt';
