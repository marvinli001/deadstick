import 'dotenv/config';

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const appKey = env.APP_KEY ?? '';
  if (!/^[A-Za-z0-9+/]{43}=$/.test(appKey) || Buffer.from(appKey, 'base64').length !== 32)
    throw new Error('APP_KEY must be a base64-encoded random 32-byte key');
  const production = env.NODE_ENV === 'production';
  const publicUrl = new URL(env.PUBLIC_URL ?? 'http://localhost:3000').origin;
  if (production && !publicUrl.startsWith('https://'))
    throw new Error('PUBLIC_URL must use HTTPS in production');
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  if (env.TELEGRAM_BOT_TOKEN && !/^[A-Za-z0-9_-]{32,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET ?? ''))
    throw new Error(
      'Set TELEGRAM_WEBHOOK_SECRET (32–256 URL-safe characters) when enabling the bot',
    );
  if (Boolean(env.TELEGRAM_CLIENT_ID) !== Boolean(env.TELEGRAM_CLIENT_SECRET))
    throw new Error('Set both TELEGRAM_CLIENT_ID and TELEGRAM_CLIENT_SECRET');
  const probeMode = env.PROBE_MODE ?? 'tcp';
  if (!['tcp', 'proxy'].includes(probeMode)) throw new Error('PROBE_MODE must be tcp or proxy');
  if (probeMode === 'proxy' && !env.MIHOMO_BIN)
    throw new Error('MIHOMO_BIN is required for PROBE_MODE=proxy');
  return {
    appKey,
    production,
    publicUrl,
    port,
    host: env.HOST ?? '0.0.0.0',
    databaseUrl: env.DATABASE_URL ?? 'postgres://localhost:5432/deadstick',
    corsOrigins: (env.CORS_ORIGINS ?? publicUrl).split(',').map((s) => new URL(s.trim()).origin),
    botToken: env.TELEGRAM_BOT_TOKEN,
    botUsername: env.TELEGRAM_BOT_USERNAME,
    webhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
    telegramClientId: env.TELEGRAM_CLIENT_ID,
    telegramClientSecret: env.TELEGRAM_CLIENT_SECRET,
    logLevel: env.LOG_LEVEL ?? 'info',
    trustProxy: env.TRUST_PROXY ? env.TRUST_PROXY.split(',').map((s) => s.trim()) : false,
    probeMode: probeMode as 'tcp' | 'proxy',
    mihomoBin: env.MIHOMO_BIN,
  };
}
export type Config = ReturnType<typeof loadConfig>;
