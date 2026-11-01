import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { loadConfig } from './config.js';
import { database } from './db.js';
import { checker } from './monitor/check.js';
import { claimChecks, cleanup, monitorSettings, runCheck, schedule } from './monitor/queue.js';
import { createBot, processBotUpdates } from './telegram/bot.js';
import { dispatchNotifications, telegramSender } from './telegram/notifications.js';

const config = loadConfig(),
  { db, close } = database(config.databaseUrl),
  controller = new AbortController();
if (config.probeMode === 'proxy') await access(config.mihomoBin!, constants.X_OK);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort());
const workerId = randomUUID();
async function loop(name: string, work: () => Promise<unknown>, delay: number) {
  while (!controller.signal.aborted) {
    try {
      await work();
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'worker_error',
          loop: name,
          type: error instanceof Error ? error.name : 'unknown',
        }),
      );
    }
    try {
      await sleep(delay, undefined, { signal: controller.signal });
    } catch {
      break;
    }
  }
}
const check = checker(config);
const loops = [
  loop(
    'heartbeat',
    () =>
      db.query(
        'INSERT INTO worker_heartbeats(id,last_seen_at) VALUES ($1,now()) ON CONFLICT(id) DO UPDATE SET last_seen_at=now()',
        [workerId],
      ),
    10000,
  ),
  loop(
    'monitor',
    async () => {
      const settings = await monitorSettings(db);
      await schedule(db, settings);
      const jobs = await claimChecks(db, settings.concurrency);
      await Promise.all(
        jobs.map((job) =>
          runCheck(db, config, job, settings, async (endpoint, s) => {
            controller.signal.throwIfAborted();
            return check(endpoint, s);
          }),
        ),
      );
    },
    2000,
  ),
  loop(
    'cleanup',
    async () => {
      await cleanup(db, (await monitorSettings(db)).retentionDays);
      await db.query("DELETE FROM worker_heartbeats WHERE last_seen_at<now()-interval '1 day'");
    },
    3600000,
  ),
];
if (config.botToken) {
  const bot = createBot(db, config),
    sender = telegramSender(config.botToken);
  // Keep notification delivery alive even if getMe or inbound processing temporarily fails.
  loops.push(
    loop(
      'telegram_inbox',
      async () => {
        if (!bot.isInited()) await bot.init();
        await processBotUpdates(db, config, bot);
      },
      150,
    ),
  );
  loops.push(loop('telegram_outbox', () => dispatchNotifications(db, sender, 3), 1500));
}
console.log(
  JSON.stringify({ event: 'worker_started', workerId, telegram: Boolean(config.botToken) }),
);
await Promise.all(loops);
await db.query('DELETE FROM worker_heartbeats WHERE id=$1', [workerId]);
await close();
