import { loadConfig } from '../config.js';
import { commands, allowedUpdates } from './bot.js';
import { telegramSender } from './notifications.js';

const config = loadConfig();
if (!config.botToken || !config.webhookSecret || !config.publicUrl.startsWith('https://'))
  throw new Error('Set TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and an HTTPS PUBLIC_URL');
const sender = telegramSender(config.botToken);
await sender.send('setMyCommands', { commands });
await sender.send('setMyDescription', {
  description: '机场可用性观察、人工复核与赛博墓园。自动异常不等于跑路。',
});
await sender.send('setWebhook', {
  url: `${config.publicUrl}/telegram/webhook`,
  secret_token: config.webhookSecret,
  allowed_updates: allowedUpdates,
  max_connections: 20,
  drop_pending_updates: false,
});
console.log('Telegram commands and webhook configured');
