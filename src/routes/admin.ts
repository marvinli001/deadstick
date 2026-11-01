import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { administrator, reviewer } from '../auth/service.js';
import { AppError, required } from '../errors.js';
import { token } from '../crypto.js';
import {
  audit,
  moderateMemorial,
  openIncident,
  resolveIncident,
  reviveProvider,
} from '../catalog/service.js';
import { Id, MonitorSettings, Page, Resolution } from '../catalog/schemas.js';
import { type TelegramSender } from '../telegram/notifications.js';

export function adminRoutes(app: FastifyInstance, db: DB, config: Config, sender?: TelegramSender) {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();
  api.get(
    '/admin/health',
    { preHandler: administrator, schema: { tags: ['admin'] } },
    async () => ({
      workers: await db.query(
        "SELECT id,last_seen_at,last_seen_at>now()-interval '30 seconds' AS healthy FROM worker_heartbeats ORDER BY last_seen_at DESC",
      ),
      checks: await db.query(
        'SELECT status,count(*)::int AS count FROM check_jobs GROUP BY status',
      ),
      notifications: await db.query(
        'SELECT status,count(*)::int AS count FROM notifications GROUP BY status',
      ),
    }),
  );
  api.get(
    '/admin/settings/monitor',
    { preHandler: administrator, schema: { tags: ['admin'] } },
    async () => (await db.query("SELECT value FROM settings WHERE key='monitor'"))[0]!.value,
  );
  api.put(
    '/admin/settings/monitor',
    { preHandler: administrator, schema: { tags: ['admin'], body: MonitorSettings } },
    async (req) =>
      db.transaction(async (tx) => {
        await tx.query("UPDATE settings SET value=$1 WHERE key='monitor'", [
          JSON.stringify(req.body),
        ]);
        await audit(tx, req.user!.id, 'settings.monitor', 'monitor', req.body);
        return { ok: true };
      }),
  );
  api.get(
    '/admin/incidents',
    {
      preHandler: reviewer,
      schema: {
        tags: ['admin'],
        querystring: Type.Object({
          ...Page,
          status: Type.Optional(
            Type.Union([
              Type.Literal('open'),
              Type.Literal('resolved'),
              Type.Literal('confirmed_dead'),
              Type.Literal('dismissed'),
            ]),
          ),
        }),
      },
    },
    async (req) => ({
      items: await db.query(
        'SELECT i.*,p.name AS provider_name FROM incidents i JOIN providers p ON i.provider_id=p.id WHERE i.status=$1 ORDER BY i.created_at DESC LIMIT $2 OFFSET $3',
        [req.query.status ?? 'open', req.query.limit ?? 20, req.query.offset ?? 0],
      ),
    }),
  );
  api.post(
    '/admin/incidents/:id/resolve',
    { preHandler: reviewer, schema: { tags: ['admin'], params: Id, body: Resolution } },
    (req) => resolveIncident(db, config, req.params.id, req.body, req.user!.id),
  );
  api.post(
    '/admin/providers/:id/incidents',
    {
      preHandler: reviewer,
      schema: {
        tags: ['admin'],
        params: Id,
        body: Type.Object(
          { summary: Type.String({ minLength: 3, maxLength: 2000 }) },
          { additionalProperties: false },
        ),
      },
    },
    (req) => openIncident(db, config, req.params.id, req.body.summary, req.user!.id),
  );
  api.post(
    '/admin/providers/:id/revive',
    {
      preHandler: reviewer,
      schema: {
        tags: ['admin'],
        params: Id,
        body: Type.Object(
          {
            reason: Type.String({ minLength: 3, maxLength: 2000 }),
            evidenceUrls: Type.Array(
              Type.String({ format: 'uri', pattern: '^https?://', maxLength: 2048 }),
              { minItems: 1, maxItems: 10 },
            ),
          },
          { additionalProperties: false },
        ),
      },
    },
    (req) => reviveProvider(db, config, req.params.id, req.body, req.user!.id),
  );
  api.post(
    '/admin/providers/:id/check',
    {
      preHandler: reviewer,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: { tags: ['admin'], params: Id },
    },
    async (req) =>
      db.transaction(async (tx) => {
        const p = required(
          (
            await tx.query<{ enabled: boolean; lifecycle: string }>(
              'SELECT enabled,lifecycle FROM providers WHERE id=$1 FOR UPDATE',
              [req.params.id],
            )
          )[0],
        );
        if (!p.enabled || p.lifecycle === 'dead')
          throw new AppError(
            409,
            'MONITOR_DISABLED',
            'Enable monitoring or revive the provider first',
          );
        const [existing] = await tx.query(
          "SELECT id FROM check_jobs WHERE provider_id=$1 AND status IN ('pending','running') LIMIT 1",
          [req.params.id],
        );
        if (existing) return existing;
        const [job] = await tx.query(
          'INSERT INTO check_jobs(provider_id,dedupe_key) VALUES ($1,$2) RETURNING id',
          [req.params.id, `manual:${req.params.id}:${token()}`],
        );
        await audit(tx, req.user!.id, 'check.enqueue', req.params.id);
        return job;
      }),
  );
  api.get(
    '/admin/jobs',
    {
      preHandler: reviewer,
      schema: {
        tags: ['admin'],
        querystring: Type.Object({
          ...Page,
          status: Type.Optional(
            Type.Union([
              Type.Literal('pending'),
              Type.Literal('running'),
              Type.Literal('done'),
              Type.Literal('failed'),
            ]),
          ),
        }),
      },
    },
    async (req) => ({
      items: await db.query(
        'SELECT * FROM check_jobs WHERE ($1::text IS NULL OR status=$1) ORDER BY created_at DESC LIMIT $2 OFFSET $3',
        [req.query.status ?? null, req.query.limit ?? 20, req.query.offset ?? 0],
      ),
    }),
  );
  api.get(
    '/admin/checks/:id/results',
    { preHandler: reviewer, schema: { tags: ['admin'], params: Id } },
    async (req) => ({
      items: await db.query('SELECT * FROM endpoint_results WHERE run_id=$1', [req.params.id]),
    }),
  );
  api.get(
    '/admin/notifications',
    { preHandler: administrator, schema: { tags: ['admin'], querystring: Type.Object(Page) } },
    async (req) => ({
      items: await db.query(
        'SELECT id,chat_id,topic_id,status,attempts,error_code,created_at,sent_at FROM notifications ORDER BY created_at DESC LIMIT $1 OFFSET $2',
        [req.query.limit ?? 20, req.query.offset ?? 0],
      ),
    }),
  );
  api.post(
    '/admin/notifications/:id/retry',
    { preHandler: administrator, schema: { tags: ['admin'], params: Id } },
    async (req) => {
      required(
        (
          await db.query(
            "UPDATE notifications SET status='pending',attempts=0,available_at=now(),error_code=NULL WHERE id=$1 AND status='failed' RETURNING id",
            [req.params.id],
          )
        )[0],
      );
      return { ok: true };
    },
  );
  api.get(
    '/admin/memorials',
    {
      preHandler: reviewer,
      schema: {
        tags: ['admin'],
        querystring: Type.Object({
          ...Page,
          status: Type.Optional(
            Type.Union([Type.Literal('pending'), Type.Literal('visible'), Type.Literal('hidden')]),
          ),
        }),
      },
    },
    async (req) => ({
      items: await db.query(
        'SELECT m.id,m.provider_id,m.user_id,m.body,m.status,m.created_at,p.name AS provider_name,u.display_name AS author_name FROM memorials m JOIN providers p ON m.provider_id=p.id JOIN users u ON u.id=m.user_id WHERE m.status=$1 ORDER BY m.created_at LIMIT $2 OFFSET $3',
        [req.query.status ?? 'pending', req.query.limit ?? 20, req.query.offset ?? 0],
      ),
    }),
  );
  api.patch(
    '/admin/memorials/:id',
    {
      preHandler: reviewer,
      schema: {
        tags: ['admin'],
        params: Id,
        body: Type.Object({ visible: Type.Boolean() }, { additionalProperties: false }),
      },
    },
    (req) => moderateMemorial(db, req.params.id, req.body.visible, req.user!.id),
  );
  api.get(
    '/admin/users',
    {
      preHandler: administrator,
      schema: {
        tags: ['admin'],
        querystring: Type.Object({
          ...Page,
          q: Type.Optional(Type.String({ maxLength: 254 })),
          role: Type.Optional(
            Type.Union([Type.Literal('user'), Type.Literal('moderator'), Type.Literal('admin')]),
          ),
        }),
      },
    },
    async (req) => ({
      items: await db.query(
        "SELECT id,email,display_name,role,telegram_id,disabled,created_at FROM users WHERE ($1::text IS NULL OR email ILIKE '%'||$1||'%' OR display_name ILIKE '%'||$1||'%' OR telegram_id=$1) AND ($2::text IS NULL OR role=$2) ORDER BY created_at DESC LIMIT $3 OFFSET $4",
        [req.query.q ?? null, req.query.role ?? null, req.query.limit ?? 20, req.query.offset ?? 0],
      ),
    }),
  );
  api.patch(
    '/admin/users/:id',
    {
      preHandler: administrator,
      schema: {
        tags: ['admin'],
        params: Id,
        body: Type.Object(
          {
            role: Type.Union([
              Type.Literal('user'),
              Type.Literal('moderator'),
              Type.Literal('admin'),
            ]),
            disabled: Type.Boolean(),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req) =>
      db.transaction(async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(73912682)');
        const user = required(
          (
            await tx.query<{ role: string; disabled: boolean }>(
              'SELECT role,disabled FROM users WHERE id=$1 FOR UPDATE',
              [req.params.id],
            )
          )[0],
        );
        if (
          user.role === 'admin' &&
          !user.disabled &&
          (req.body.role !== 'admin' || req.body.disabled)
        ) {
          const admins = await tx.query("SELECT id FROM users WHERE role='admin' AND NOT disabled");
          if (admins.length <= 1)
            throw new AppError(
              409,
              'LAST_ADMIN',
              'Cannot disable or demote the last administrator',
            );
        }
        await tx.query('UPDATE users SET role=$1,disabled=$2 WHERE id=$3', [
          req.body.role,
          req.body.disabled,
          req.params.id,
        ]);
        await tx.query('DELETE FROM sessions WHERE user_id=$1', [req.params.id]);
        await audit(tx, req.user!.id, 'user.update', req.params.id, req.body);
        return { ok: true };
      }),
  );
  api.get(
    '/admin/audit',
    { preHandler: administrator, schema: { tags: ['admin'], querystring: Type.Object(Page) } },
    async (req) => ({
      items: await db.query('SELECT * FROM audit_log ORDER BY id DESC LIMIT $1 OFFSET $2', [
        req.query.limit ?? 20,
        req.query.offset ?? 0,
      ]),
    }),
  );
  const ChatId = Type.Object({ id: Type.String({ pattern: '^-?[0-9]{1,20}$' }) });
  api.get(
    '/admin/telegram/chats',
    { preHandler: administrator, schema: { tags: ['telegram'] } },
    async () => ({ items: await db.query('SELECT * FROM telegram_chats ORDER BY created_at') }),
  );
  api.put(
    '/admin/telegram/chats/:id',
    {
      preHandler: administrator,
      schema: {
        tags: ['telegram'],
        params: ChatId,
        body: Type.Object(
          {
            kind: Type.Union([Type.Literal('group'), Type.Literal('admin')]),
            topicId: Type.Optional(Type.Integer({ minimum: 1 })),
            enabled: Type.Boolean(),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req) => {
      if (!sender) throw new AppError(503, 'NOT_CONFIGURED', 'Telegram bot is not configured');
      const chat = (await sender.send('getChat', { chat_id: req.params.id })) as {
        title?: string;
        first_name?: string;
        type: string;
      };
      if (
        (req.body.kind === 'group' && !['group', 'supergroup'].includes(chat.type)) ||
        (req.body.kind === 'admin' && chat.type !== 'private')
      )
        throw new AppError(400, 'CHAT_TYPE', 'Chat type does not match binding');
      if (req.body.kind === 'admin') {
        const [admin] = await db.query(
          "SELECT id FROM users WHERE telegram_id=$1 AND role IN ('admin','moderator') AND NOT disabled",
          [req.params.id],
        );
        if (!admin)
          throw new AppError(
            400,
            'NOT_REVIEWER',
            'Link this Telegram account to an administrator or moderator first',
          );
      }
      return db.transaction(async (tx) => {
        await tx.query(
          'INSERT INTO telegram_chats(id,title,kind,topic_id,enabled) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET title=excluded.title,kind=excluded.kind,topic_id=excluded.topic_id,enabled=excluded.enabled',
          [
            req.params.id,
            chat.title ?? chat.first_name ?? req.params.id,
            req.body.kind,
            req.body.topicId ?? null,
            req.body.enabled,
          ],
        );
        await audit(tx, req.user!.id, 'telegram.bind', req.params.id, req.body);
        return { ok: true };
      });
    },
  );
  api.delete(
    '/admin/telegram/chats/:id',
    { preHandler: administrator, schema: { tags: ['telegram'], params: ChatId } },
    async (req) =>
      db.transaction(async (tx) => {
        await tx.query('DELETE FROM telegram_chats WHERE id=$1', [req.params.id]);
        await audit(tx, req.user!.id, 'telegram.unbind', req.params.id);
        return { ok: true };
      }),
  );
}
