import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { Config } from './config.js';
import type { DB } from './db.js';
import { administrator } from './auth/service.js';
import { audit } from './catalog/service.js';
import { decrypt, encrypt } from './crypto.js';
import { AppError } from './errors.js';

interface TurnstileSettings {
  enabled: boolean;
  siteKey: string;
  secretKey: string;
}

export type TurnstileAction = 'submission' | 'lead' | 'memorial';
export const TurnstileToken = Type.Optional(Type.String({ minLength: 1, maxLength: 2048 }));

async function settings(db: DB, config: Config): Promise<TurnstileSettings> {
  const [row] = await db.query<{ value: { ciphertext: string } }>(
    "SELECT value FROM settings WHERE key='turnstile'",
  );
  return row
    ? JSON.parse(decrypt(row.value.ciphertext, config.appKey))
    : { enabled: false, siteKey: '', secretKey: '' };
}

const settingsView = (saved: TurnstileSettings) => ({
  enabled: saved.enabled,
  siteKey: saved.siteKey,
  secretKeySet: Boolean(saved.secretKey),
});

export function turnstileRoutes(app: FastifyInstance, db: DB, config: Config) {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();
  api.get('/settings/turnstile', { schema: { tags: ['catalog'] } }, async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const saved = await settings(db, config);
    return { enabled: saved.enabled, siteKey: saved.enabled ? saved.siteKey : '' };
  });
  api.get(
    '/admin/settings/turnstile',
    { preHandler: administrator, schema: { tags: ['admin'] } },
    async () => settingsView(await settings(db, config)),
  );
  api.put(
    '/admin/settings/turnstile',
    {
      preHandler: administrator,
      schema: {
        tags: ['admin'],
        body: Type.Object(
          {
            enabled: Type.Boolean(),
            siteKey: Type.String({ maxLength: 256, pattern: '^[A-Za-z0-9_-]*$' }),
            secretKey: Type.Optional(Type.String({ maxLength: 256 })),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req) =>
      db.transaction(async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('settings.turnstile',0))");
        const current = await settings(tx, config);
        const saved = {
          enabled: req.body.enabled,
          siteKey: req.body.siteKey,
          secretKey: req.body.secretKey?.trim() || current.secretKey,
        };
        if (saved.enabled && (!saved.siteKey || !saved.secretKey))
          throw new AppError(400, 'TURNSTILE_CONFIG', 'Set both Site Key and Secret Key');
        await tx.query(
          "INSERT INTO settings(key,value) VALUES ('turnstile',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          [JSON.stringify({ ciphertext: encrypt(JSON.stringify(saved), config.appKey) })],
        );
        const view = settingsView(saved);
        await audit(tx, req.user!.id, 'settings.turnstile', 'turnstile', view);
        return view;
      }),
  );
}

export async function verifyTurnstile(
  db: DB,
  config: Config,
  token: string | undefined,
  action: TurnstileAction,
  remoteip: string,
) {
  const saved = await settings(db, config);
  if (!saved.enabled) return;
  if (!token) throw new AppError(403, 'TURNSTILE_REQUIRED', 'Complete the security check');
  let result: { success: boolean; action?: string; hostname?: string };
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: new URLSearchParams({ secret: saved.secretKey, response: token, remoteip }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('Siteverify unavailable');
    result = await response.json();
    if (!result || typeof result.success !== 'boolean')
      throw new Error('Invalid Siteverify response');
  } catch {
    throw new AppError(503, 'TURNSTILE_UNAVAILABLE', 'Security check unavailable; try again');
  }
  const hostnames = [config.publicUrl, ...config.corsOrigins].map((url) => new URL(url).hostname);
  if (!result.success || result.action !== action || !hostnames.includes(result.hostname ?? ''))
    throw new AppError(403, 'TURNSTILE_FAILED', 'Security check failed; try again');
}
