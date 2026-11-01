import { loadConfig } from '../config.js';
import { database } from '../db.js';
import { allowedUpdates, commandMenus } from './bot.js';
import { telegramSender } from './notifications.js';

const config = loadConfig();
if (!config.botToken || !config.webhookSecret || !config.publicUrl.startsWith('https://'))
  throw new Error('Set TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and an HTTPS PUBLIC_URL');
const sender = telegramSender(config.botToken);
const me = (await sender.send('getMe', {})) as {
  username: string;
  can_join_groups?: boolean;
  can_read_all_group_messages?: boolean;
  supports_inline_queries?: boolean;
  supports_guest_queries?: boolean;
  has_main_web_app?: boolean;
};
if (config.botUsername?.toLowerCase() !== me.username.toLowerCase())
  throw new Error(`Set TELEGRAM_BOT_USERNAME=${me.username} to match the bot token`);

const scopes: Array<[object, object[]]> = [
  [{ type: 'default' }, commandMenus.private],
  [{ type: 'all_private_chats' }, commandMenus.private],
  [{ type: 'all_group_chats' }, commandMenus.groups],
  [{ type: 'all_chat_administrators' }, commandMenus.groupAdmins],
];
for (const [scope, commands] of scopes) await sender.send('setMyCommands', { scope, commands });
const { db, close } = database(config.databaseUrl);
let reviewers = 0,
  unreachable = 0;
try {
  // Reviewers who enabled DM alerts also see /pending, /notify and /review in their menu.
  for (const chat of await db.query<{ id: string }>(
    "SELECT c.id FROM telegram_chats c JOIN users u ON u.telegram_id=c.id WHERE c.kind='admin' AND c.enabled AND u.role IN ('admin','moderator') AND NOT u.disabled",
  )) {
    // A reviewer who never pressed Start makes Telegram reject the chat scope.
    await sender
      .send('setMyCommands', {
        scope: { type: 'chat', chat_id: chat.id },
        commands: commandMenus.reviewer,
      })
      .then(
        () => reviewers++,
        () => unreachable++,
      );
  }
} finally {
  await close();
}
await sender.send('setMyDescription', {
  description:
    '机场可用性观察、人工复核与赛博墓园。查机场是否还活着，关注状态变化；确认跑路的机场入土墓园，可以献花、点烛、上香和留言。自动检测只会标记疑似，跑路结论由人工核验。',
});
await sender.send('setMyShortDescription', {
  short_description: '机场存活观察 · 人工复核 · 赛博墓园',
});
await sender.send('setChatMenuButton', {
  menu_button: { type: 'web_app', text: '墓园', web_app: { url: config.publicUrl } },
});
await sender.send('setWebhook', {
  url: `${config.publicUrl}/telegram/webhook`,
  secret_token: config.webhookSecret,
  allowed_updates: allowedUpdates,
  max_connections: 20,
  drop_pending_updates: false,
});
const webhook = (await sender.send('getWebhookInfo', {})) as {
  url: string;
  pending_update_count: number;
  last_error_message?: string;
};
const hints = [
  !me.supports_inline_queries && 'Inline mode is off: BotFather > /setinline',
  !me.supports_guest_queries && 'Guest mode is off: BotFather Mini App > Bot Settings > Guest Mode',
  !me.can_join_groups && 'Groups are disabled: BotFather > /setjoingroups',
  me.can_read_all_group_messages &&
    'Privacy mode is off; turn it on unless you need every group message',
].filter(Boolean);
console.log(
  JSON.stringify(
    {
      bot: `@${me.username}`,
      webhook: webhook.url,
      pendingUpdates: webhook.pending_update_count,
      lastError: webhook.last_error_message ?? null,
      reviewerMenus: reviewers,
      unreachableReviewers: unreachable,
      hints,
    },
    null,
    2,
  ),
);
