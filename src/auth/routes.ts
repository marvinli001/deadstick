import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { AppError, required } from '../errors.js';
import { decrypt, digest, encrypt, hashPassword, token, verifyPassword } from '../crypto.js';
import {
  authenticated,
  newSession,
  publicUser,
  telegramUser,
  userColumns,
  type User,
} from './service.js';
import { pkceChallenge, verifyMiniApp, verifyTelegramIdToken } from './telegram.js';

const credentials = Type.Object(
  {
    email: Type.String({ format: 'email', maxLength: 254 }),
    password: Type.String({ minLength: 12, maxLength: 128 }),
  },
  { additionalProperties: false },
);
export function authRoutes(app: FastifyInstance, db: DB, config: Config) {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();
  const destination = Type.Object({
    next: Type.Optional(Type.String({ maxLength: 512, pattern: '^/(?!/)[^\\\\\\s]*$' })),
  });
  api.get('/auth/telegram/config', { schema: { tags: ['auth'] } }, async () => ({
    bot_username: config.botUsername ?? null,
    oidc_enabled: Boolean(config.telegramClientId && config.telegramClientSecret),
    miniapp_enabled: Boolean(
      config.botToken && config.botUsername && config.publicUrl.startsWith('https://'),
    ),
    miniapp_url: config.botUsername ? `https://t.me/${config.botUsername}?startapp=me` : null,
  }));
  api.post(
    '/auth/register',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        tags: ['auth'],
        body: Type.Object(
          { ...credentials.properties, displayName: Type.String({ minLength: 1, maxLength: 80 }) },
          { additionalProperties: false },
        ),
      },
    },
    async (req, reply) => {
      const hash = await hashPassword(req.body.password);
      const [user] = await db.query<User>(
        `INSERT INTO users(email,password_hash,display_name) VALUES ($1,$2,$3) RETURNING ${userColumns}`,
        [req.body.email.toLowerCase(), hash, req.body.displayName],
      );
      reply.code(201);
      return newSession(db, config, reply, user!);
    },
  );
  api.post(
    '/auth/login',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: { tags: ['auth'], body: credentials },
    },
    async (req, reply) => {
      const [user] = await db.query<User & { password_hash: string | null }>(
        'SELECT * FROM users WHERE email=$1',
        [req.body.email.toLowerCase()],
      );
      const dummy = 'scrypt:deadstick-dummy-salt:' + '0'.repeat(128);
      const valid = await verifyPassword(req.body.password, user?.password_hash ?? dummy);
      if (!user || !valid || !user.password_hash)
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
      return newSession(db, config, reply, user);
    },
  );
  api.get(
    '/auth/me',
    { preHandler: authenticated, schema: { tags: ['auth'] } },
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      const [row] = await db.query<{ has_password: boolean }>(
        'SELECT password_hash IS NOT NULL AS has_password FROM users WHERE id=$1',
        [req.user!.id],
      );
      return {
        user: { ...publicUser(req.user!), has_password: row!.has_password },
        csrfToken: req.csrfToken,
      };
    },
  );
  api.patch(
    '/auth/me',
    {
      preHandler: authenticated,
      schema: {
        tags: ['auth'],
        body: Type.Object(
          { displayName: Type.String({ minLength: 1, maxLength: 80, pattern: '\\S' }) },
          { additionalProperties: false },
        ),
      },
    },
    async (req) => {
      const [user] = await db.query<User>(
        `UPDATE users SET display_name=$1 WHERE id=$2 RETURNING ${userColumns}`,
        [req.body.displayName.trim(), req.user!.id],
      );
      return { user: publicUser(user!) };
    },
  );
  api.delete(
    '/auth/telegram',
    { preHandler: authenticated, schema: { tags: ['auth'] } },
    async (req) =>
      db.transaction(async (tx) => {
        const [current] = await tx.query<{ telegram_id: string | null; has_password: boolean }>(
          'SELECT telegram_id,(email IS NOT NULL AND password_hash IS NOT NULL) AS has_password FROM users WHERE id=$1 FOR UPDATE',
          [req.user!.id],
        );
        if (!current?.telegram_id)
          throw new AppError(409, 'NOT_LINKED', 'No Telegram account is linked');
        if (!current.has_password)
          throw new AppError(
            409,
            'LAST_LOGIN_METHOD',
            'Set an email and password before unlinking Telegram',
          );
        await tx.query("DELETE FROM telegram_chats WHERE id=$1 AND kind='admin'", [
          current.telegram_id,
        ]);
        const [user] = await tx.query<User>(
          `UPDATE users SET telegram_id=NULL,telegram_subject=NULL WHERE id=$1 RETURNING ${userColumns}`,
          [req.user!.id],
        );
        return { user: publicUser(user!) };
      }),
  );
  api.post(
    '/auth/logout',
    { preHandler: authenticated, schema: { tags: ['auth'] } },
    async (req, reply) => {
      await db.query('DELETE FROM sessions WHERE token_hash=$1', [req.sessionHash]);
      reply.clearCookie('session', { path: '/' });
      return { ok: true };
    },
  );
  api.post(
    '/auth/password',
    {
      preHandler: authenticated,
      schema: {
        tags: ['auth'],
        body: Type.Object(
          {
            currentPassword: Type.String({ maxLength: 128 }),
            newPassword: Type.String({ minLength: 12, maxLength: 128 }),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req, reply) => {
      const [user] = await db.query<{ password_hash: string | null }>(
        'SELECT password_hash FROM users WHERE id=$1',
        [req.user!.id],
      );
      if (
        !user?.password_hash ||
        !(await verifyPassword(req.body.currentPassword, user.password_hash))
      )
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Current password is invalid');
      await db.transaction(async (tx) => {
        await tx.query('UPDATE users SET password_hash=$1 WHERE id=$2', [
          await hashPassword(req.body.newPassword),
          req.user!.id,
        ]);
        await tx.query('DELETE FROM sessions WHERE user_id=$1', [req.user!.id]);
      });
      return newSession(db, config, reply, req.user!);
    },
  );
  async function start(
    mode: 'login' | 'link',
    req: Parameters<typeof authenticated>[0],
    reply: Parameters<typeof newSession>[2],
    returnPath?: string,
  ) {
    if (!config.telegramClientId || !config.telegramClientSecret)
      throw new AppError(503, 'NOT_CONFIGURED', 'Telegram OIDC is not configured');
    const state = token(),
      browser = token(),
      verifier = token(),
      nonce = token();
    await db.query(
      "INSERT INTO auth_challenges(state_hash,browser_hash,nonce,verifier,mode,user_id,return_path,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,now()+interval '10 minutes')",
      [
        digest(state),
        digest(browser),
        nonce,
        encrypt(verifier, config.appKey),
        mode,
        mode === 'link' ? req.user!.id : null,
        returnPath ?? null,
      ],
    );
    reply.setCookie('tg_state', browser, {
      httpOnly: true,
      path: '/auth/telegram',
      secure: config.production,
      sameSite: 'lax',
      maxAge: 600,
    });
    reply.header('Cache-Control', 'no-store');
    const url = new URL('https://oauth.telegram.org/auth');
    url.search = new URLSearchParams({
      client_id: config.telegramClientId,
      redirect_uri: `${config.publicUrl}/auth/telegram/callback`,
      response_type: 'code',
      scope: 'openid profile telegram:bot_access',
      state,
      nonce,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: 'S256',
    }).toString();
    return { url: url.toString() };
  }
  api.get(
    '/auth/telegram/start',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: { tags: ['auth'], querystring: destination },
    },
    (req, reply) => start('login', req, reply, req.query.next),
  );
  api.post(
    '/auth/telegram/link',
    { preHandler: authenticated, schema: { tags: ['auth'] } },
    (req, reply) => start('link', req, reply),
  );
  api.get(
    '/auth/telegram/callback',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags: ['auth'],
        querystring: Type.Object({
          state: Type.String({ maxLength: 128 }),
          code: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
          error: Type.Optional(Type.String({ maxLength: 128 })),
          error_description: Type.Optional(Type.String({ maxLength: 1024 })),
        }),
      },
    },
    async (req, reply) => {
      // A browser navigation lands back in the web app; API clients keep the JSON response.
      const browser = req.headers.accept?.includes('text/html') ?? false;
      let returnPath: string | null = null;
      let linking = false;
      try {
        if (!config.telegramClientId || !config.telegramClientSecret)
          throw new AppError(503, 'NOT_CONFIGURED', 'Telegram OIDC is not configured');
        const [challenge] = await db.query<{
          nonce: string;
          verifier: string;
          user_id: string | null;
          mode: string;
          return_path: string | null;
        }>(
          'DELETE FROM auth_challenges WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>now() RETURNING *',
          [digest(req.query.state), digest(req.cookies.tg_state ?? '')],
        );
        if (!challenge) throw new AppError(401, 'INVALID_STATE', 'Invalid or expired login state');
        returnPath = challenge.return_path;
        linking = challenge.mode === 'link';
        if (challenge.mode === 'link' && req.user?.id !== challenge.user_id)
          throw new AppError(401, 'INVALID_STATE', 'Linking session changed');
        reply.clearCookie('tg_state', { path: '/auth/telegram' });
        if (req.query.error)
          throw new AppError(
            401,
            req.query.error === 'access_denied' ? 'TELEGRAM_CANCELLED' : 'TELEGRAM_AUTH',
            'Telegram authorization was not completed',
          );
        if (!req.query.code) throw new AppError(401, 'TELEGRAM_AUTH', 'Missing authorization code');
        const response = await fetch('https://oauth.telegram.org/token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${Buffer.from(`${config.telegramClientId}:${config.telegramClientSecret}`).toString('base64')}`,
          },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: req.query.code,
            client_id: config.telegramClientId,
            redirect_uri: `${config.publicUrl}/auth/telegram/callback`,
            code_verifier: decrypt(challenge.verifier, config.appKey),
          }),
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new AppError(401, 'TELEGRAM_AUTH', 'Telegram code exchange failed');
        const data = (await response.json()) as { id_token: string };
        const identity = await verifyTelegramIdToken(
          data.id_token,
          config.telegramClientId,
          challenge.nonce,
        );
        const user = await telegramUser(db, identity, challenge.user_id ?? undefined);
        const session = await newSession(db, config, reply, user);
        if (!browser) return session;
        return reply.redirect(
          challenge.mode === 'link'
            ? '/me/security?telegram=linked'
            : (challenge.return_path ?? (user.role === 'user' ? '/me' : '/console')),
        );
      } catch (error) {
        if (!browser) throw error;
        const code = error instanceof AppError ? error.code : 'TELEGRAM_AUTH';
        const params = new URLSearchParams({ telegram: code });
        if (returnPath && !linking) params.set('next', returnPath);
        return reply.redirect(`${linking ? '/me/security' : '/login'}?${params}`);
      }
    },
  );
  api.post(
    '/auth/telegram/miniapp',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['auth'],
        body: Type.Object(
          { initData: Type.String({ minLength: 1, maxLength: 16384 }) },
          { additionalProperties: false },
        ),
      },
    },
    async (req, reply) => {
      if (!config.botToken)
        throw new AppError(503, 'NOT_CONFIGURED', 'Telegram bot is not configured');
      const launchData = new URLSearchParams(req.body.initData);
      launchData.sort();
      const replayHash = digest(launchData.toString());
      // Only the same authenticated account can resume an already verified launch.
      if (req.user) {
        const [launch] = await db.query(
          'SELECT hash FROM auth_replays WHERE hash=$1 AND user_id=$2 AND expires_at>now()',
          [replayHash, req.user.id],
        );
        if (launch) {
          const [row] = await db.query<{ has_password: boolean }>(
            'SELECT password_hash IS NOT NULL AS has_password FROM users WHERE id=$1',
            [req.user.id],
          );
          return {
            user: { ...publicUser(req.user), has_password: row!.has_password },
            csrfToken: req.csrfToken,
          };
        }
      }
      const identity = verifyMiniApp(req.body.initData, config.botToken);
      const user = await telegramUser(db, identity);
      return db.transaction(async (tx) => {
        const [inserted] = await tx.query(
          "INSERT INTO auth_replays(hash,user_id,expires_at) VALUES ($1,$2,now()+interval '30 days') ON CONFLICT DO NOTHING RETURNING hash",
          [replayHash, user.id],
        );
        if (!inserted)
          throw new AppError(
            401,
            'REPLAY',
            'Mini App login data was already used; reopen the Mini App',
          );
        return newSession(tx, config, reply, user);
      });
    },
  );
}
