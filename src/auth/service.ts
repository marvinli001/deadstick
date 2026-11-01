import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { digest, equal, token } from '../crypto.js';
import { AppError } from '../errors.js';

export interface User {
  id: string;
  email: string | null;
  display_name: string;
  role: 'user' | 'moderator' | 'admin';
  telegram_id: string | null;
  disabled: boolean;
}
declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
    sessionHash: string | null;
    csrfToken: string | null;
  }
}
export const userColumns = 'id,email,display_name,role,telegram_id,disabled';
export function publicUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    role: user.role,
    telegram_id: user.telegram_id,
  };
}
export async function newSession(db: DB, config: Config, reply: FastifyReply, user: User) {
  if (user.disabled) throw new AppError(403, 'DISABLED', 'Account disabled');
  const session = token(),
    csrfToken = token();
  const [row] = await db.query<{ has_password: boolean }>(
    "INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES ($1,$2,$3,now()+interval '30 days') RETURNING (SELECT password_hash IS NOT NULL FROM users WHERE id=$2) AS has_password",
    [digest(session), user.id, csrfToken],
  );
  reply.setCookie('session', session, {
    path: '/',
    httpOnly: true,
    secure: config.production,
    sameSite: 'lax',
    maxAge: 30 * 86400,
  });
  reply.header('Cache-Control', 'no-store');
  return { user: { ...publicUser(user), has_password: row!.has_password }, csrfToken };
}
export function authHook(db: DB, config: Config) {
  return async (request: FastifyRequest) => {
    request.user = null;
    request.sessionHash = null;
    request.csrfToken = null;
    const bearer = request.headers.authorization?.startsWith('Bearer ')
      ? request.headers.authorization.slice(7)
      : undefined;
    const session = bearer ?? request.cookies.session;
    if (session) {
      const [row] = await db.query<User & { csrf_token: string }>(
        `SELECT u.*,s.csrf_token FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND NOT u.disabled`,
        [digest(session)],
      );
      if (row) {
        request.user = row;
        request.sessionHash = digest(session);
        request.csrfToken = row.csrf_token;
      }
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.headers.origin;
      if (origin && !config.corsOrigins.includes(origin))
        throw new AppError(403, 'ORIGIN', 'Origin not allowed');
      if (
        request.user &&
        !bearer &&
        !equal(String(request.headers['x-csrf-token'] ?? ''), request.csrfToken!)
      )
        throw new AppError(403, 'CSRF', 'Send X-CSRF-Token from the login or /auth/me response');
    }
  };
}
export async function authenticated(request: FastifyRequest) {
  if (!request.user) throw new AppError(401, 'UNAUTHORIZED', 'Login required');
}
export async function reviewer(request: FastifyRequest) {
  await authenticated(request);
  if (!['admin', 'moderator'].includes(request.user!.role))
    throw new AppError(403, 'FORBIDDEN', 'Reviewer access required');
}
export async function administrator(request: FastifyRequest) {
  await authenticated(request);
  if (request.user!.role !== 'admin')
    throw new AppError(403, 'FORBIDDEN', 'Administrator access required');
}

export async function telegramUser(
  db: DB,
  identity: { id: string; name: string; subject?: string },
  linkUserId?: string,
) {
  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `telegram:${identity.id}`,
    ]);
    const [existing] = await tx.query<User & { telegram_subject: string | null }>(
      'SELECT * FROM users WHERE telegram_id=$1 FOR UPDATE',
      [identity.id],
    );
    if (existing?.disabled) throw new AppError(403, 'DISABLED', 'Account disabled');
    if (existing && linkUserId && existing.id !== linkUserId)
      throw new AppError(409, 'ALREADY_LINKED', 'Telegram account is already linked');
    if (
      existing?.telegram_subject &&
      identity.subject &&
      existing.telegram_subject !== identity.subject
    )
      throw new AppError(409, 'IDENTITY_MISMATCH', 'Telegram identity mismatch');
    if (linkUserId) {
      const [target] = await tx.query<User>(
        'SELECT * FROM users WHERE id=$1 AND NOT disabled FOR UPDATE',
        [linkUserId],
      );
      if (!target || (target.telegram_id && target.telegram_id !== identity.id))
        throw new AppError(409, 'ALREADY_LINKED', 'Account already linked or unavailable');
      return (
        await tx.query<User>(
          `UPDATE users SET telegram_id=$1,telegram_subject=coalesce($2,telegram_subject) WHERE id=$3 RETURNING ${userColumns}`,
          [identity.id, identity.subject ?? null, linkUserId],
        )
      )[0]!;
    }
    if (existing) {
      if (identity.subject)
        await tx.query('UPDATE users SET telegram_subject=$1 WHERE id=$2', [
          identity.subject,
          existing.id,
        ]);
      return existing;
    }
    return (
      await tx.query<User>(
        `INSERT INTO users(telegram_id,telegram_subject,display_name) VALUES ($1,$2,$3) RETURNING ${userColumns}`,
        [identity.id, identity.subject ?? null, identity.name.slice(0, 80)],
      )
    )[0]!;
  });
}
