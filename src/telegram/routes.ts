import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { administrator } from '../auth/service.js';
import { decrypt, encrypt, equal } from '../crypto.js';
import { AppError } from '../errors.js';
import { audit } from '../catalog/service.js';
import { Page } from '../catalog/schemas.js';
import { type TelegramSender, TelegramError } from './notifications.js';
import { saveTelegramSettings, telegramSettingsView } from './settings.js';
import { botStatus, setupBot } from './management.js';

export function telegramRoutes(
  app: FastifyInstance,
  db: DB,
  config: Config,
  sender?: TelegramSender,
) {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();
  api.get(
    '/admin/telegram/settings',
    { preHandler: administrator, schema: { tags: ['telegram'] } },
    async () => telegramSettingsView(config),
  );
  api.put(
    '/admin/telegram/settings',
    {
      preHandler: administrator,
      schema: {
        tags: ['telegram'],
        body: Type.Object(
          {
            botUsername: Type.String({
              maxLength: 33,
              pattern: '^(@?[A-Za-z][A-Za-z0-9_]{3,31})?$',
            }),
            botToken: Type.Optional(
              Type.String({ maxLength: 256, pattern: '^([0-9]+:[A-Za-z0-9_-]{20,})?$' }),
            ),
            webhookSecret: Type.Optional(
              Type.String({ maxLength: 256, pattern: '^([A-Za-z0-9_-]{32,256})?$' }),
            ),
            telegramClientId: Type.String({ maxLength: 256 }),
            telegramClientSecret: Type.Optional(Type.String({ maxLength: 512 })),
          },
          { additionalProperties: false },
        ),
      },
    },
    (req) => saveTelegramSettings(db, config, req.body, req.user!.id),
  );
  api.post(
    '/admin/telegram/test',
    { preHandler: administrator, schema: { tags: ['telegram'] } },
    async () => {
      if (!config.botToken || !sender)
        throw new AppError(503, 'NOT_CONFIGURED', 'Telegram bot is not configured');
      return botStatus(sender);
    },
  );
  api.post(
    '/admin/telegram/setup',
    { preHandler: administrator, schema: { tags: ['telegram'] } },
    async (req) => {
      if (!sender) throw new AppError(503, 'NOT_CONFIGURED', 'Telegram bot is not configured');
      await audit(db, req.user!.id, 'telegram.setup', 'telegram');
      return setupBot(db, config, sender);
    },
  );
  api.post(
    '/telegram/webhook',
    {
      config: { rateLimit: { max: 1200, timeWindow: '1 minute' } },
      onRequest: async (req) => {
        if (
          !config.botToken ||
          !config.webhookSecret ||
          !equal(String(req.headers['x-telegram-bot-api-secret-token'] ?? ''), config.webhookSecret)
        )
          throw new AppError(401, 'WEBHOOK_SECRET', 'Invalid webhook secret');
      },
      schema: {
        tags: ['telegram'],
        body: Type.Object(
          { update_id: Type.Integer({ minimum: 0 }) },
          { additionalProperties: true },
        ),
      },
    },
    async (req) => {
      await db.query(
        'INSERT INTO bot_updates(update_id,payload_ciphertext) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [req.body.update_id, encrypt(JSON.stringify(req.body), config.appKey)],
      );
      return { ok: true };
    },
  );
  const Method = Type.Object({ method: Type.String({ pattern: '^[a-zA-Z][a-zA-Z0-9]{0,79}$' }) });
  api.post(
    '/admin/telegram/api/:method',
    {
      preHandler: administrator,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        tags: ['telegram'],
        description:
          'Full Bot API JSON bridge. Accepts all method parameters, including new Bot API fields; file_id and HTTPS file URLs are supported.',
        params: Method,
        body: Type.Record(Type.String(), Type.Unknown()),
      },
    },
    async (req) => {
      if (!sender) throw new AppError(503, 'NOT_CONFIGURED', 'Telegram bot is not configured');
      await audit(db, req.user!.id, 'telegram.api', req.params.method);
      return { result: await sender.send(req.params.method, req.body) };
    },
  );
  api.post(
    '/admin/telegram/upload/:method',
    {
      preHandler: administrator,
      bodyLimit: 21 * 1024 * 1024,
      schema: {
        tags: ['telegram'],
        description:
          'Full Bot API multipart bridge; total files and fields capped at 20 MiB. Use attach://field references as in the official API.',
        params: Method,
      },
    },
    async (req) => {
      if (!config.botToken)
        throw new AppError(503, 'NOT_CONFIGURED', 'Telegram bot is not configured');
      const form = new FormData();
      let bytes = 0;
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          const data = await part.toBuffer();
          bytes += data.length;
          if (bytes > 20 * 1024 * 1024)
            throw new AppError(413, 'TOO_LARGE', 'Multipart upload exceeds 20 MiB');
          form.append(
            part.fieldname,
            new Blob([new Uint8Array(data)], { type: part.mimetype }),
            part.filename,
          );
        } else {
          const value = String(part.value);
          bytes += Buffer.byteLength(value);
          form.append(part.fieldname, value);
        }
        if (bytes > 20 * 1024 * 1024)
          throw new AppError(413, 'TOO_LARGE', 'Multipart upload exceeds 20 MiB');
      }
      await audit(db, req.user!.id, 'telegram.upload', req.params.method);
      const response = await fetch(
        `https://api.telegram.org/bot${config.botToken}/${req.params.method}`,
        { method: 'POST', body: form, signal: AbortSignal.timeout(60000) },
      );
      const data = (await response.json()) as { ok: boolean; result: unknown; error_code: number };
      if (!data.ok) throw new TelegramError(data.error_code);
      return { result: data.result };
    },
  );
  api.get(
    '/admin/telegram/updates',
    { preHandler: administrator, schema: { tags: ['telegram'], querystring: Type.Object(Page) } },
    async (req) => ({
      items: await db.query(
        'SELECT update_id,status,attempts,created_at FROM bot_updates ORDER BY update_id DESC LIMIT $1 OFFSET $2',
        [req.query.limit ?? 20, req.query.offset ?? 0],
      ),
    }),
  );
  api.get(
    '/admin/telegram/updates/:id',
    {
      preHandler: administrator,
      schema: {
        tags: ['telegram'],
        params: Type.Object({ id: Type.String({ pattern: '^[0-9]{1,20}$' }) }),
      },
    },
    async (req) => {
      const [row] = await db.query<{ payload_ciphertext: string }>(
        'SELECT payload_ciphertext FROM bot_updates WHERE update_id=$1',
        [req.params.id],
      );
      if (!row) throw new AppError(404, 'NOT_FOUND', 'Update not found');
      return { update: JSON.parse(decrypt(row.payload_ciphertext, config.appKey)) };
    },
  );
  api.post(
    '/admin/telegram/updates/:id/retry',
    {
      preHandler: administrator,
      schema: {
        tags: ['telegram'],
        params: Type.Object({ id: Type.String({ pattern: '^[0-9]{1,20}$' }) }),
      },
    },
    async (req) => {
      await db.query(
        "UPDATE bot_updates SET status='pending',attempts=0,available_at=now() WHERE update_id=$1 AND status='failed'",
        [req.params.id],
      );
      return { ok: true };
    },
  );
}
