import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { sql } from 'kysely';
import { getDb } from '../../database/db.js';
import { isDuplicateKey } from '../../database/db.js';
import type { Role, UserRow } from '../../database/types.js';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { generateRefreshToken, hashRefreshToken, signAccessToken } from './tokens.js';
import { recordAudit } from '../../services/audit.js';

const BCRYPT_ROUNDS = 12;
/**
 * Two tabs of the same browser can both try to refresh at once with the same cookie. The first
 * rotates it; the second would look like token theft. Within this short grace window a rotated
 * token is rejected with a retryable 401 instead of revoking the whole family.
 */
const ROTATION_GRACE_MS = 30_000;

// A real bcrypt hash of a random string, used to equalise timing when the email does not exist.
const DUMMY_HASH = bcrypt.hashSync(randomUUID(), BCRYPT_ROUNDS);

export interface PublicUser {
  id: number;
  name: string;
  email: string;
  role: Role;
  avatarUrl: string | null;
  status: string;
  createdAt: string;
}

export function toPublicUser(u: UserRow): PublicUser {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    avatarUrl: u.avatar_url,
    status: u.status,
    createdAt: u.created_at.toISOString(),
  };
}

export interface AuthResult {
  user: PublicUser;
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

async function issueSession(user: UserRow, familyId: string, userAgent?: string): Promise<AuthResult> {
  const { token, hash } = generateRefreshToken();
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
  await getDb()
    .insertInto('refresh_sessions')
    .values({ user_id: user.id, token_hash: hash, family_id: familyId, expires_at: expiresAt, user_agent: userAgent?.slice(0, 255) ?? null })
    .execute();
  return {
    user: toPublicUser(user),
    accessToken: signAccessToken(user),
    accessTokenExpiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
    refreshToken: token,
    refreshTokenExpiresAt: expiresAt,
  };
}

export async function register(input: { name: string; email: string; password: string; role: 'USER' | 'SELLER' }, userAgent?: string) {
  const db = getDb();
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
  try {
    const res = await db
      .insertInto('users')
      .values({ name: input.name, email: input.email.toLowerCase(), password_hash: passwordHash, role: input.role })
      .executeTakeFirstOrThrow();
    const user = await db.selectFrom('users').selectAll().where('id', '=', Number(res.insertId)).executeTakeFirstOrThrow();
    await recordAudit(db, { actorId: user.id, action: 'USER_REGISTERED', entityType: 'user', entityId: user.id });
    return issueSession(user, randomUUID(), userAgent);
  } catch (err) {
    // Registration necessarily reveals that an email is taken; we keep the message neutral and
    // rate-limit the endpoint to make bulk enumeration slow.
    if (isDuplicateKey(err, 'uq_users_email')) throw new AppError('EMAIL_IN_USE', 'An account with this email already exists');
    throw err;
  }
}

export async function login(email: string, password: string, userAgent?: string) {
  const user = await getDb().selectFrom('users').selectAll().where('email', '=', email.toLowerCase()).executeTakeFirst();
  // Always run bcrypt, even for unknown emails, so response time does not reveal which emails exist.
  const valid = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !valid) throw new AppError('INVALID_CREDENTIALS', 'Incorrect email or password');
  if (user.status === 'SUSPENDED') throw new AppError('ACCOUNT_SUSPENDED', 'This account has been suspended');
  return issueSession(user, randomUUID(), userAgent);
}

/**
 * Refresh-token rotation. Each refresh token is single-use: using it marks it rotated and issues a
 * new one in the same family. If an already-rotated token is presented again (outside the short
 * multi-tab grace window), someone else may hold a copy, so the entire family is revoked and every
 * device using it must log in again.
 */
export async function refresh(rawToken: string | undefined, userAgent?: string): Promise<AuthResult> {
  if (!rawToken) throw new AppError('INVALID_REFRESH_TOKEN', 'Missing refresh token');
  const db = getDb();
  const hash = hashRefreshToken(rawToken);

  const outcome = await db.transaction().execute(async (trx): Promise<AuthResult | 'REUSE_DETECTED'> => {
    // Lock the session row so two concurrent refreshes with the same token cannot both succeed.
    const session = await trx
      .selectFrom('refresh_sessions')
      .selectAll()
      .where('token_hash', '=', hash)
      .forUpdate()
      .executeTakeFirst();
    if (!session) throw new AppError('INVALID_REFRESH_TOKEN', 'Invalid refresh token');
    if (session.revoked_at) throw new AppError('INVALID_REFRESH_TOKEN', 'Session has been revoked');
    if (session.expires_at.getTime() <= Date.now()) throw new AppError('INVALID_REFRESH_TOKEN', 'Session expired');

    if (session.rotated_at) {
      if (Date.now() - session.rotated_at.getTime() < ROTATION_GRACE_MS) {
        throw new AppError('INVALID_REFRESH_TOKEN', 'Refresh token already rotated; retry with the latest cookie');
      }
      logger.warn({ userId: session.user_id, familyId: session.family_id }, 'refresh token reuse detected — revoking family');
      await trx
        .updateTable('refresh_sessions')
        .set({ revoked_at: new Date() })
        .where('family_id', '=', session.family_id)
        .where('revoked_at', 'is', null)
        .execute();
      await recordAudit(trx, { actorId: session.user_id, action: 'REFRESH_TOKEN_REUSE', entityType: 'user', entityId: session.user_id });
      // Return instead of throwing: a throw would roll back the revocation we just wrote.
      return 'REUSE_DETECTED';
    }

    const user = await trx.selectFrom('users').selectAll().where('id', '=', session.user_id).executeTakeFirstOrThrow();
    if (user.status === 'SUSPENDED') throw new AppError('ACCOUNT_SUSPENDED', 'This account has been suspended');

    await trx.updateTable('refresh_sessions').set({ rotated_at: new Date() }).where('id', '=', session.id).execute();
    const { token, hash: newHash } = generateRefreshToken();
    const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
    await trx
      .insertInto('refresh_sessions')
      .values({ user_id: user.id, token_hash: newHash, family_id: session.family_id, expires_at: expiresAt, user_agent: userAgent?.slice(0, 255) ?? null })
      .execute();
    return {
      user: toPublicUser(user),
      accessToken: signAccessToken(user),
      accessTokenExpiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
      refreshToken: token,
      refreshTokenExpiresAt: expiresAt,
    };
  });
  if (outcome === 'REUSE_DETECTED') throw new AppError('INVALID_REFRESH_TOKEN', 'Session has been revoked');
  return outcome;
}

/** Logout revokes the whole family of the presented token (this device's login). */
export async function logout(rawToken: string | undefined) {
  if (!rawToken) return;
  const db = getDb();
  const session = await db.selectFrom('refresh_sessions').select(['family_id']).where('token_hash', '=', hashRefreshToken(rawToken)).executeTakeFirst();
  if (!session) return;
  await db
    .updateTable('refresh_sessions')
    .set({ revoked_at: sql<Date>`UTC_TIMESTAMP(3)` })
    .where('family_id', '=', session.family_id)
    .where('revoked_at', 'is', null)
    .execute();
}

/** Revokes every session for a user (admin suspension). */
export async function revokeAllSessions(userId: number) {
  await getDb().updateTable('refresh_sessions').set({ revoked_at: new Date() }).where('user_id', '=', userId).where('revoked_at', 'is', null).execute();
}
