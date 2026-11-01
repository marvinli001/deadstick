import type { Config } from '../config.js';
import type { DB } from '../db.js';
import { AppError } from '../errors.js';
import { allowedUpdates } from './bot.js';
import { commandMenus } from './commands.js';
import type { TelegramSender } from './notifications.js';

interface BotInfo {
  username: string;
  first_name: string;
  can_join_groups?: boolean;
  can_read_all_group_messages?: boolean;
  supports_inline_queries?: boolean;
  supports_guest_queries?: boolean;
  has_main_web_app?: boolean;
}
interface WebhookInfo {
  url: string;
  pending_update_count: number;
  last_error_message?: string;
}
const statusView = (me: BotInfo, webhook: WebhookInfo) => ({
  bot_username: me.username,
  bot_name: me.first_name,
  webhook_url: webhook.url,
  pending_updates: webhook.pending_update_count,
  last_error: webhook.last_error_message ?? null,
  capabilities: {
    inline: Boolean(me.supports_inline_queries),
    guest: Boolean(me.supports_guest_queries),
    miniapp: Boolean(me.has_main_web_app),
    groups: Boolean(me.can_join_groups),
    privacy: !me.can_read_all_group_messages,
  },
  hints: [
    !me.supports_inline_queries && '在 BotFather 开启 Inline mode（/setinline）',
    !me.supports_guest_queries && '在 BotFather 开启 Guest Mode',
    !me.has_main_web_app && '在 BotFather 开启 Main Mini App，地址设为公网地址',
    !me.can_join_groups && '在 BotFather 允许加入群组（/setjoingroups）',
    me.can_read_all_group_messages && '建议在 BotFather 开启隐私模式（/setprivacy）',
  ].filter((hint): hint is string => Boolean(hint)),
});

export async function botStatus(sender: TelegramSender) {
  const [me, webhook] = await Promise.all([
    sender.send('getMe', {}) as Promise<BotInfo>,
    sender.send('getWebhookInfo', {}) as Promise<WebhookInfo>,
  ]);
  return statusView(me, webhook);
}

export async function setupBot(db: DB, config: Config, sender: TelegramSender) {
  if (!config.botToken || !config.webhookSecret)
    throw new AppError(503, 'NOT_CONFIGURED', 'Telegram bot is not configured');
  if (!config.publicUrl.startsWith('https://'))
    throw new AppError(400, 'HTTPS_REQUIRED', 'PUBLIC_URL must use HTTPS');
  const me = (await sender.send('getMe', {})) as BotInfo;
  if (config.botUsername?.toLowerCase() !== me.username.toLowerCase())
    throw new AppError(400, 'BOT_USERNAME_MISMATCH', 'Bot username does not match the token');
  const scopes: Array<[object, object[]]> = [
    [{ type: 'default' }, commandMenus.private],
    [{ type: 'all_private_chats' }, commandMenus.private],
    [{ type: 'all_group_chats' }, commandMenus.groups],
    [{ type: 'all_chat_administrators' }, commandMenus.groupAdmins],
  ];
  for (const [scope, commands] of scopes) await sender.send('setMyCommands', { scope, commands });
  let reviewers = 0,
    unreachable = 0;
  for (const chat of await db.query<{ id: string }>(
    "SELECT telegram_id AS id FROM users WHERE telegram_id IS NOT NULL AND role IN ('admin','moderator') AND NOT disabled",
  )) {
    // Reviewers who have not pressed Start cannot receive a chat-scoped menu.
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
  await sender.send('setMyDescription', {
    description:
      '机场可用性观察、人工复核与赛博墓园。查机场是否还活着，关注状态变化；确认跑路的机场入土墓园，可以献花、点烛、上香和留言。自动检测只会标记疑似，跑路结论由人工核验。',
  });
  await sender.send('setMyShortDescription', {
    short_description: '机场存活观察 · 人工复核 · 赛博墓园',
  });
  await sender.send('setChatMenuButton', {
    menu_button: { type: 'web_app', text: 'Deadstick', web_app: { url: config.publicUrl } },
  });
  await sender.send('setWebhook', {
    url: `${config.publicUrl}/telegram/webhook`,
    secret_token: config.webhookSecret,
    allowed_updates: allowedUpdates,
    max_connections: 20,
    drop_pending_updates: false,
  });
  const webhook = (await sender.send('getWebhookInfo', {})) as WebhookInfo;
  return {
    ...statusView(me, webhook),
    reviewer_menus: reviewers,
    unreachable_reviewers: unreachable,
  };
}
