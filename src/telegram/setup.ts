import { loadConfig } from '../config.js';
import { database } from '../db.js';
import { setupBot } from './management.js';
import { telegramSender } from './notifications.js';
import { telegramConfig } from './settings.js';

const defaults = loadConfig();
const { db, close } = database(defaults.databaseUrl);
try {
  const config = await telegramConfig(db, defaults);
  if (!config.botToken) throw new Error('Configure the Telegram bot in the admin console first');
  console.log(JSON.stringify(await setupBot(db, config, telegramSender(config.botToken)), null, 2));
} finally {
  await close();
}
