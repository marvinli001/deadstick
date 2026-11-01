import type { Config } from '../config.js';
import type { DB } from '../db.js';
import { decrypt, encrypt, token } from '../crypto.js';
import { AppError } from '../errors.js';
import { audit } from '../catalog/service.js';

type TelegramConfig = Pick<
  Config,
  'botToken' | 'botUsername' | 'webhookSecret' | 'telegramClientId' | 'telegramClientSecret'
>;

export async function telegramConfig(db: DB, defaults: Config): Promise<Config> {
  const [row] = await db.query<{ value: { ciphertext: string } }>(
    "SELECT value FROM settings WHERE key='telegram'",
  );
  if (!row) return { ...defaults };
  const saved = JSON.parse(decrypt(row.value.ciphertext, defaults.appKey)) as TelegramConfig;
  return {
    ...defaults,
    botToken: saved.botToken || undefined,
    botUsername: saved.botUsername || undefined,
    webhookSecret: saved.webhookSecret || undefined,
    telegramClientId: saved.telegramClientId || undefined,
    telegramClientSecret: saved.telegramClientSecret || undefined,
  };
}

export const telegramSettingsView = (config: Config) => ({
  bot_username: config.botUsername ?? '',
  bot_token_set: Boolean(config.botToken),
  webhook_secret_set: Boolean(config.webhookSecret),
  client_id: config.telegramClientId ?? '',
  client_secret_set: Boolean(config.telegramClientSecret),
  public_url: config.publicUrl,
  webhook_url: `${config.publicUrl}/telegram/webhook`,
  callback_url: `${config.publicUrl}/auth/telegram/callback`,
});

export async function saveTelegramSettings(
  db: DB,
  config: Config,
  input: {
    botUsername: string;
    botToken?: string;
    webhookSecret?: string;
    telegramClientId: string;
    telegramClientSecret?: string;
  },
  actorId: string,
) {
  const saved = {
    botToken: input.botToken || config.botToken || '',
    botUsername: input.botUsername.trim().replace(/^@/, ''),
    webhookSecret: input.webhookSecret || config.webhookSecret || token(),
    telegramClientId: input.telegramClientId.trim(),
    telegramClientSecret: input.telegramClientId.trim()
      ? input.telegramClientSecret || config.telegramClientSecret || ''
      : '',
  };
  if (saved.botToken && !saved.botUsername)
    throw new AppError(400, 'BOT_USERNAME', 'Set the bot username');
  if (saved.telegramClientId && !saved.telegramClientSecret)
    throw new AppError(400, 'OIDC_CREDENTIALS', 'Set both Telegram Client ID and Client Secret');
  await db.transaction(async (tx) => {
    await tx.query(
      "INSERT INTO settings(key,value) VALUES ('telegram',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      [JSON.stringify({ ciphertext: encrypt(JSON.stringify(saved), config.appKey) })],
    );
    await audit(tx, actorId, 'settings.telegram', 'telegram');
  });
  return telegramSettingsView({ ...config, ...saved });
}
