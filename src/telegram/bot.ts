import { Bot, GrammyError, type Context } from 'grammy';
import type {
  BotCommand,
  InlineKeyboardMarkup,
  InlineQueryResultArticle,
  Update,
  UserFromGetMe,
} from 'grammy/types';
import { Value } from '@sinclair/typebox/value';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { telegramUser } from '../auth/service.js';
import { AppError } from '../errors.js';
import {
  addTribute,
  audit,
  createMemorial,
  createSubmission,
  moderateMemorial,
  prepareProvider,
  resolveIncident,
  reviewSubmission,
  setFollow,
} from '../catalog/service.js';
import { ProviderInput } from '../catalog/schemas.js';
import { decrypt } from '../crypto.js';
import { notifyAdmins } from './notifications.js';
import {
  ceremonyCard,
  escape,
  expandId,
  lifecycleLabels,
  listKeyboard,
  markup,
  providerCard,
  providerKeyboard,
  providerTitle,
  healthLabels,
  startLink,
  tributeKinds,
  tributeLabels,
  tributeRow,
  webLink,
  type ProviderView,
  type TributeKind,
} from './format.js';
import { views, type View } from './views.js';

export const allowedUpdates: Array<Exclude<keyof Update, 'update_id'>> = [
  'message',
  'edited_message',
  'channel_post',
  'edited_channel_post',
  'business_connection',
  'business_message',
  'edited_business_message',
  'deleted_business_messages',
  'guest_message',
  'stopped_message_generation',
  'inline_query',
  'chosen_inline_result',
  'callback_query',
  'shipping_query',
  'pre_checkout_query',
  'purchased_paid_media',
  'poll',
  'poll_answer',
  'my_chat_member',
  'managed_bot',
  'chat_join_request',
  'chat_boost',
  'removed_chat_boost',
  'subscription',
  'chat_member',
  'message_reaction',
  'message_reaction_count',
];

type Audience = 'everyone' | 'private' | 'reviewer' | 'groupAdmin';
const commandTable: Array<BotCommand & { audience: Audience }> = [
  { command: 'start', description: '开始使用', audience: 'private' },
  { command: 'help', description: '使用说明', audience: 'everyone', is_ephemeral: true },
  { command: 'search', description: '搜索机场：名称', audience: 'everyone', is_ephemeral: true },
  { command: 'status', description: '机场状态：slug', audience: 'everyone', is_ephemeral: true },
  { command: 'graveyard', description: '逛赛博墓园', audience: 'everyone' },
  { command: 'ceremony', description: '电子追悼会：slug', audience: 'everyone' },
  { command: 'tribute', description: '献花：slug', audience: 'everyone', is_ephemeral: true },
  {
    command: 'memorial',
    description: '追悼留言：slug 留言',
    audience: 'everyone',
    is_ephemeral: true,
  },
  { command: 'follow', description: '关注机场：slug', audience: 'everyone', is_ephemeral: true },
  { command: 'unfollow', description: '取消关注：slug', audience: 'everyone', is_ephemeral: true },
  { command: 'following', description: '我的关注', audience: 'everyone', is_ephemeral: true },
  { command: 'submit', description: '投稿：名称 | slug | 官网 | 订阅', audience: 'private' },
  { command: 'pending', description: '待处理的复核与审核', audience: 'reviewer' },
  { command: 'notify', description: '开关复核私信', audience: 'reviewer' },
  { command: 'review', description: '文字复核：事件ID 结论 证据 原因', audience: 'reviewer' },
  { command: 'bind', description: '把本群（话题）设为通报群', audience: 'groupAdmin' },
  { command: 'unbind', description: '取消本群通报', audience: 'groupAdmin' },
];
const pick = (audiences: Audience[], ephemeral: boolean): BotCommand[] =>
  commandTable
    .filter((c) => audiences.includes(c.audience))
    .map(({ command, description, is_ephemeral }) => ({
      command,
      description,
      ...(ephemeral && is_ephemeral ? { is_ephemeral } : {}),
    }));
/** Command menus per BotCommandScope, used by telegram:setup and /notify. */
export const commandMenus = {
  private: pick(['private', 'everyone'], false),
  reviewer: pick(['private', 'everyone', 'reviewer'], false),
  groups: pick(['everyone'], true),
  groupAdmins: pick(['everyone', 'groupAdmin'], true),
};

const HTML = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };
const errorText: Record<string, string> = {
  NOT_FOUND: '没有找到对应记录。',
  NOT_DEAD: '只有人工确认跑路的机场可以祭奠和留言。',
  ALREADY_DEAD: '这个机场已经入土。',
  ALREADY_REVIEWED: '已经有人处理过了。',
  INCIDENT_OPEN: '这个机场已有待复核的异常。',
  DUPLICATE_ENDPOINT: '入口地址重复。',
  INVALID_URL: '地址无效，只支持公网 http(s) 地址。',
  BLOCKED_ADDRESS: '地址解析到了非公网 IP，已拒绝。',
  DNS_TIMEOUT: '域名解析超时，请稍后再试。',
  DISABLED: '账号已停用。',
};
const reviewActions = { d: 'dead', r: 'recovered', x: 'dismissed' } as const;
const reviewLabels = { dead: '确认跑路', recovered: '服务恢复', dismissed: '排除误报' };
const isGroupChat = (type?: string) => type === 'group' || type === 'supergroup';
const hasMarkup = (m?: InlineKeyboardMarkup) =>
  m?.inline_keyboard.length ? { reply_markup: m } : {};
function ignore400(error: unknown) {
  if (error instanceof GrammyError && error.error_code === 400) return undefined;
  throw error;
}

export function createBot(db: DB, config: Config, botInfo?: UserFromGetMe) {
  const bot = new Bot(config.botToken!, botInfo ? { botInfo } : undefined);
  const v = views(db, config);
  const me = (ctx: Context) =>
    telegramUser(db, { id: String(ctx.from!.id), name: ctx.from!.first_name });
  const staff = async (ctx: Context, roles = ['admin', 'moderator']) =>
    (
      await db.query<{ id: string; role: string; display_name: string }>(
        'SELECT id,role,display_name FROM users WHERE telegram_id=$1 AND NOT disabled AND role=ANY($2)',
        [String(ctx.from!.id), roles],
      )
    )[0];
  const deepLink = (ctx: Context, payload: string) => startLink(ctx.me.username, payload);

  /** Replies to a message; ephemeral commands get an ephemeral answer visible only to the sender. */
  async function reply(ctx: Context, text: string, reply_markup?: InlineKeyboardMarkup) {
    const msg = ctx.msg;
    if (msg?.ephemeral_message_id && ctx.from) {
      await ctx
        .reply(text, {
          ...HTML,
          ...hasMarkup(reply_markup),
          ephemeral_message_parameters: { receiver_user_id: ctx.from.id },
          reply_parameters: { ephemeral_message_id: msg.ephemeral_message_id },
        })
        .catch(ignore400);
      return;
    }
    await ctx.reply(text, {
      ...HTML,
      ...hasMarkup(reply_markup),
      ...(isGroupChat(ctx.chat?.type) && msg
        ? { reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } }
        : {}),
    });
  }
  const answer = (ctx: Context, text?: string, alert = false) =>
    ctx.answerCallbackQuery(text ? { text, show_alert: alert } : undefined).catch(ignore400);

  /**
   * Shows a view in response to a button: edits the message in private chats, sends an
   * ephemeral overlay in groups, and otherwise sends the user to the private chat.
   */
  async function show(ctx: Context, view: View, notice?: string) {
    const query = ctx.callbackQuery!,
      message = query.message;
    const extra = { ...HTML, ...hasMarkup(view.markup) };
    if (message && message.chat.type === 'private') {
      await answer(ctx, notice);
      try {
        await ctx.editMessageText(view.text, extra);
      } catch (error) {
        if (error instanceof GrammyError && error.description.includes('not modified')) return;
        if (!(error instanceof GrammyError && error.error_code === 400)) throw error;
        await ctx.reply(view.text, extra);
      }
      return;
    }
    if (message && isGroupChat(message.chat.type)) {
      const ephemeralId = 'ephemeral_message_id' in message ? message.ephemeral_message_id : 0;
      try {
        if (ephemeralId)
          await ctx.api.editEphemeralMessageText(
            message.chat.id,
            query.from.id,
            ephemeralId,
            view.text,
            extra,
          );
        else
          await ctx.api.sendMessage(message.chat.id, view.text, {
            ...extra,
            ...('is_topic_message' in message && message.is_topic_message
              ? { message_thread_id: message.message_thread_id }
              : {}),
            ephemeral_message_parameters: {
              receiver_user_id: query.from.id,
              callback_query_id: query.id,
            },
          });
        await answer(ctx, notice);
        return;
      } catch (error) {
        ignore400(error);
      }
    }
    const url = deepLink(ctx, view.start);
    await ctx.answerCallbackQuery(url ? { url } : { text: '请私聊机器人查看' }).catch(ignore400);
  }

  // Error boundary: business errors become a short Chinese notice instead of a retried update.
  bot.use(async (ctx, next) => {
    try {
      await next();
    } catch (error) {
      const code =
        error instanceof AppError
          ? error.code
          : (error as { code?: string }).code === '23505'
            ? 'CONFLICT'
            : undefined;
      if (!code) throw error;
      const text =
        code === 'CONFLICT'
          ? '记录已存在（例如 slug 已被占用）。'
          : (errorText[code] ?? (error as Error).message);
      if (ctx.callbackQuery) await answer(ctx, text, true);
      else if (ctx.msg && ctx.chat) await reply(ctx, escape(text));
    }
  });
  // Sender gate: ignore bots, disabled accounts and users over 30 updates per minute.
  bot.use(async (ctx, next) => {
    if (ctx.from?.is_bot) return;
    if (ctx.from) {
      const [disabled] = await db.query('SELECT id FROM users WHERE telegram_id=$1 AND disabled', [
        String(ctx.from.id),
      ]);
      if (disabled) return;
      const [rate] = await db.query<{ count: number }>(
        `INSERT INTO bot_rate_limits(user_id,window_start,count) VALUES ($1,now(),1) ON CONFLICT(user_id) DO UPDATE SET window_start=CASE WHEN bot_rate_limits.window_start<now()-interval '1 minute' THEN now() ELSE bot_rate_limits.window_start END,count=CASE WHEN bot_rate_limits.window_start<now()-interval '1 minute' THEN 1 ELSE bot_rate_limits.count+1 END RETURNING count`,
        [String(ctx.from.id)],
      );
      if (rate!.count > 30) return;
    }
    await next();
  });

  const tools: Tools = { me, reply, show, answer, deepLink, staff };
  registerSetupHandlers(bot, db, tools);
  registerGuestMode(bot, config, v);

  // Group whitelist: everything below only runs in private chats and bound groups.
  bot.use(async (ctx, next) => {
    if (isGroupChat(ctx.chat?.type)) {
      const [allowed] = await db.query(
        "SELECT id FROM telegram_chats WHERE id=$1 AND kind='group' AND enabled",
        [String(ctx.chat!.id)],
      );
      if (!allowed) return;
    } else if (ctx.chat && ctx.chat.type !== 'private') return;
    await next();
  });

  registerCatalogHandlers(bot, db, config, v, tools);
  registerReviewHandlers(bot, db, config, v, tools);
  return bot;
}
type Views = ReturnType<typeof views>;
interface Tools {
  me(ctx: Context): ReturnType<typeof telegramUser>;
  reply(ctx: Context, text: string, markup?: InlineKeyboardMarkup): Promise<void>;
  show(ctx: Context, view: View, notice?: string): Promise<void>;
  answer(ctx: Context, text?: string, alert?: boolean): Promise<unknown>;
  deepLink(ctx: Context, payload: string): string | undefined;
  staff(
    ctx: Context,
    roles?: string[],
  ): Promise<{ id: string; role: string; display_name: string } | undefined>;
}

/** Chat lifecycle and binding. Runs before the group whitelist so unbound groups can be set up. */
function registerSetupHandlers(bot: Bot, db: DB, t: Tools) {
  bot.on('my_chat_member', async (ctx) => {
    const { chat, new_chat_member, old_chat_member, from } = ctx.myChatMember;
    if (!isGroupChat(chat.type)) return;
    const id = String(chat.id),
      title = escape('title' in chat ? (chat.title ?? id) : id);
    const [bound] = await db.query<{ enabled: boolean }>(
      "SELECT enabled FROM telegram_chats WHERE id=$1 AND kind='group'",
      [id],
    );
    const gone = ['left', 'kicked'];
    if (gone.includes(new_chat_member.status)) {
      if (!bound?.enabled) return;
      await db.query('UPDATE telegram_chats SET enabled=false WHERE id=$1', [id]);
      await audit(db, null, 'telegram.removed', id);
      await notifyAdmins(db, `chat-removed:${id}:${ctx.update.update_id}`, {
        text: `⚠️ <b>机器人已离开通报群</b>\n${title} · <code>${id}</code>\n已停用该群的通报，重新加入后用 /bind 恢复。`,
      });
      return;
    }
    if (bound || !gone.includes(old_chat_member.status)) return;
    await notifyAdmins(db, `chat-added:${id}:${ctx.update.update_id}`, {
      text: `➕ <b>机器人被加入新群</b>\n${title} · <code>${id}</code>\n邀请人：${escape(from.first_name)}\n绑定前不会响应群命令，也不会收到通报。`,
      reply_markup: markup([
        [{ text: '📣 绑定为通报群', callback_data: `bind:${id}`, style: 'primary' }],
      ]),
    });
  });
  bot.callbackQuery(/^bind:(-?\d{1,20})$/, async (ctx) => {
    const admin = await t.staff(ctx, ['admin']);
    if (!admin) return void (await t.answer(ctx, '只有管理员可以绑定群', true));
    const chat = await ctx.api.getChat(ctx.match[1]!);
    if (!isGroupChat(chat.type)) return void (await t.answer(ctx, '这不是群组', true));
    await bindGroup(db, admin.id, String(chat.id), chat.title ?? String(chat.id), null);
    await ctx
      .editMessageReplyMarkup({
        reply_markup: markup([[{ text: '✅ 已绑定为通报群', disabled: {} }]]),
      })
      .catch(ignore400);
    await t.answer(ctx, '已绑定');
  });
  bot.command(['bind', 'unbind'], async (ctx) => {
    if (!isGroupChat(ctx.chat.type))
      return void (await t.reply(ctx, '请在要绑定的群里发送此命令。'));
    const admin = await t.staff(ctx, ['admin']);
    if (!admin)
      return void (await t.reply(ctx, '只有在网站绑定了 Telegram 的管理员可以设置通报群。'));
    const id = String(ctx.chat.id);
    if (ctx.message!.text.split(/[\s@]/)[0] === '/unbind') {
      await db.query("DELETE FROM telegram_chats WHERE id=$1 AND kind='group'", [id]);
      await audit(db, admin.id, 'telegram.unbind', id);
      return void (await t.reply(ctx, '已取消本群通报，机器人不再响应本群命令。'));
    }
    const topic = ctx.message!.is_topic_message ? ctx.message!.message_thread_id! : null;
    await bindGroup(db, admin.id, id, ('title' in ctx.chat && ctx.chat.title) || id, topic);
    await t.reply(
      ctx,
      `📣 已绑定为通报群${topic ? `，通报发到当前话题（<code>${topic}</code>）` : ''}。\n群 ID：<code>${id}</code>`,
    );
  });
}
async function bindGroup(
  db: DB,
  actorId: string,
  id: string,
  title: string,
  topicId: number | null,
) {
  await db.transaction(async (tx) => {
    await tx.query(
      "INSERT INTO telegram_chats(id,title,kind,topic_id,enabled) VALUES ($1,$2,'group',$3,true) ON CONFLICT(id) DO UPDATE SET title=excluded.title,kind='group',topic_id=excluded.topic_id,enabled=true",
      [id, title.slice(0, 255), topicId],
    );
    await audit(tx, actorId, 'telegram.bind', id, { kind: 'group', topicId, via: 'bot' });
  });
}

function article(p: ProviderView, config: Config, username: string): InlineQueryResultArticle {
  const dead = p.lifecycle === 'dead';
  const links = providerKeyboard(p, config, { username, interactive: false });
  const keyboard = dead ? markup([tributeRow(p.id), ...links.inline_keyboard]) : links;
  return {
    type: 'article',
    id: p.id,
    title: providerTitle(p),
    description: `${lifecycleLabels[p.lifecycle] ?? p.lifecycle} · ${healthLabels[p.health] ?? p.health}`,
    input_message_content: {
      message_text: dead ? ceremonyCard(p) : providerCard(p),
      ...HTML,
    },
    ...hasMarkup(keyboard),
  };
}

/** Guest mode (Bot API 10.0): answer a mention in any chat with one read-only provider card. */
function registerGuestMode(bot: Bot, config: Config, v: Views) {
  bot.on('guest_message', async (ctx) => {
    const message = ctx.update.guest_message!;
    const username = ctx.me.username;
    const query = (message.text ?? message.caption ?? '')
      .replace(new RegExp(`@${username}\\b`, 'gi'), '')
      .trim()
      .slice(0, 120);
    const p = query ? ((await v.find(query)) ?? (await v.search(query, 1))[0]) : undefined;
    // Callbacks from a chat the bot is not a member of are unreliable, so only link buttons.
    const result: InlineQueryResultArticle = p
      ? {
          ...article(p, config, username),
          reply_markup: undefined,
          ...hasMarkup(providerKeyboard(p, config, { username, interactive: false })),
        }
      : {
          type: 'article',
          id: 'none',
          title: '未找到',
          input_message_content: {
            message_text: query
              ? `没有找到「${escape(query)}」。试试机场名称或 slug。`
              : `用法：@${escape(username)} 机场名称或 slug`,
            ...HTML,
          },
        };
    await ctx.answerGuestQuery(result);
  });
}

const submitHelp = [
  '📮 <b>投稿</b>',
  '在私聊发送：',
  '<code>/submit 名称 | slug | https://官网 | https://订阅</code>',
  'slug 只能用小写字母、数字和连字符；订阅可省略，多个官网用空格分隔。',
  '订阅只用于检测，加密保存，不会出现在任何公开页面或消息里。',
].join('\n');
function helpText(username: string) {
  return [
    '<b>Deadstick · 机场观察与赛博墓园</b>',
    '/search 名称 · /status slug · /graveyard',
    '/ceremony slug · /tribute slug · /memorial slug 留言',
    '/follow slug · /unfollow slug · /following',
    '/submit（私聊投稿）',
    `在任意聊天输入 <code>@${escape(username)} 机场名</code> 可直接分享机场卡片。`,
    '自动检测只会标记“疑似跑路”，确认跑路必须经过人工核验。',
  ].join('\n');
}

function registerCatalogHandlers(bot: Bot, db: DB, config: Config, v: Views, t: Tools) {
  const card = async (ctx: Context, p: ProviderView) =>
    v.provider(p, ctx.me.username, ctx.from ? (await t.me(ctx)).id : undefined);
  async function welcome(ctx: Context) {
    const site = webLink(config, '');
    const privateChat = ctx.chat?.type === 'private';
    await t.reply(
      ctx,
      `${helpText(ctx.me.username)}\n\n你的 Telegram ID：<code>${ctx.from!.id}</code>`,
      markup([
        [
          { text: '🔍 搜索机场', switch_inline_query_current_chat: '' },
          { text: '🪦 逛墓园', callback_data: 'gy:0' },
        ],
        site
          ? privateChat
            ? [{ text: '📱 打开 Deadstick', web_app: { url: site } }]
            : [{ text: '🌐 打开网站', url: site }]
          : [],
        [{ text: '📮 怎么投稿', callback_data: 'hs' }],
      ]),
    );
  }
  bot.command('start', async (ctx) => {
    await t.me(ctx);
    const [kind, value] = ctx.match.trim().split('_', 2) as [string, string | undefined];
    const id = value ? expandId(value) : undefined;
    const p = id ? await v.byId(id) : undefined;
    if (p && kind === 'p') {
      const view = await card(ctx, p);
      return t.reply(ctx, view.text, view.markup);
    }
    if (p && kind === 'c' && p.lifecycle === 'dead') {
      const view = v.ceremony(p);
      return t.reply(ctx, view.text, view.markup);
    }
    if (p && kind === 'r') {
      const report = await v.report(p);
      return void (await sendReport(ctx, report));
    }
    if (kind === 'graveyard') {
      const view = await v.graveyard(0);
      return t.reply(ctx, view.text, view.markup);
    }
    if (kind === 'submit') return t.reply(ctx, submitHelp);
    if (kind === 'pending' && (await t.staff(ctx))) {
      const view = await v.pending();
      return t.reply(ctx, view.text, view.markup);
    }
    await welcome(ctx);
  });
  bot.command('help', (ctx) => t.reply(ctx, helpText(ctx.me.username)));
  bot.callbackQuery('hs', (ctx) => t.show(ctx, { text: submitHelp, start: 'submit' }));

  async function results(ctx: Context, query: string) {
    const items = await v.search(query, 8);
    if (items.length === 1) {
      const view = await card(ctx, items[0]!);
      return t.reply(ctx, view.text, view.markup);
    }
    const more = webLink(config, `/airports?q=${encodeURIComponent(query)}`);
    await t.reply(
      ctx,
      items.length ? `🔍 「${escape(query)}」的结果` : `没有找到「${escape(query)}」。`,
      listKeyboard(items, [
        more ? [{ text: '🌐 在网站查看全部', url: more }] : [],
        [{ text: '🔍 换个关键词', switch_inline_query_current_chat: query }],
      ]),
    );
  }
  bot.command('search', async (ctx) => {
    const query = ctx.match.trim().slice(0, 120);
    if (!query)
      return t.reply(
        ctx,
        '发送 <code>/search 机场名</code>，或点下面的按钮边输边搜。',
        markup([[{ text: '🔍 搜索机场', switch_inline_query_current_chat: '' }]]),
      );
    await results(ctx, query);
  });
  bot.command('status', async (ctx) => {
    const p = await v.find(ctx.match);
    if (!p)
      return ctx.match.trim()
        ? results(ctx, ctx.match.trim().slice(0, 120))
        : t.reply(ctx, '用法：<code>/status slug</code>');
    const view = await card(ctx, p);
    await t.reply(ctx, view.text, view.markup);
  });
  bot.command('graveyard', async (ctx) => {
    const view = await v.graveyard(0);
    await t.reply(ctx, view.text, view.markup);
  });
  bot.command('ceremony', async (ctx) => {
    const p = await v.find(ctx.match);
    if (!p || p.lifecycle !== 'dead')
      return t.reply(ctx, '用法：<code>/ceremony 已确认跑路的slug</code>');
    const view = v.ceremony(p);
    await t.reply(ctx, view.text, view.markup);
  });
  const kindWords: Record<string, TributeKind> = {
    flower: 'flower',
    花: 'flower',
    献花: 'flower',
    candle: 'candle',
    烛: 'candle',
    蜡烛: 'candle',
    点烛: 'candle',
    incense: 'incense',
    香: 'incense',
    上香: 'incense',
  };
  bot.command('tribute', async (ctx) => {
    const [slug, word] = ctx.match.trim().split(/\s+/);
    const p = await v.find(slug ?? '');
    if (!p) return t.reply(ctx, '用法：<code>/tribute slug [献花|点烛|上香]</code>');
    const kind = kindWords[word ?? 'flower'] ?? 'flower';
    const result = await addTribute(db, p.id, (await t.me(ctx)).id, kind);
    await t.reply(
      ctx,
      result.created
        ? `${tributeLabels[kind]} · 已为 <b>${escape(p.name)}</b> 送上心意。`
        : '今天已经送过这份心意了。',
      markup([[{ text: '🕯 电子追悼会', callback_data: `cer:${p.id}` }]]),
    );
  });
  bot.command('memorial', async (ctx) => {
    const [slug, ...words] = ctx.match.trim().split(/\s+/);
    const body = words.join(' ').trim(),
      p = await v.find(slug ?? '');
    if (!p || p.lifecycle !== 'dead' || !body || body.length > 1000)
      return t.reply(ctx, '用法：<code>/memorial 已确认跑路的slug 留言</code>（1000 字以内）');
    await createMemorial(db, p.id, await t.me(ctx), body, ctx.update.update_id);
    await t.reply(ctx, '🕯 追悼留言已提交，审核后展示。');
  });
  bot.command(['follow', 'unfollow'], async (ctx) => {
    const p = await v.find(ctx.match);
    if (!p) return t.reply(ctx, '用法：<code>/follow slug</code>');
    const follow = ctx.message!.text.split(/[\s@]/)[0] === '/follow';
    await setFollow(db, (await t.me(ctx)).id, p.id, follow);
    const dm = ctx.chat.type === 'private' ? undefined : t.deepLink(ctx, 'start');
    await t.reply(
      ctx,
      follow
        ? `🔔 已关注 <b>${escape(p.name)}</b>，状态变化会私信通知你。${dm ? '\n先私聊机器人点一次 Start，才能收到私信。' : ''}`
        : `🔕 已取消关注 <b>${escape(p.name)}</b>。`,
      dm ? markup([[{ text: '💬 私聊机器人', url: dm }]]) : undefined,
    );
  });
  bot.command('following', async (ctx) => {
    const items = await db.query<ProviderView>(
      `SELECT p.id,p.name,p.slug,p.lifecycle,p.health,p.epitaph FROM follows f JOIN providers p ON p.id=f.provider_id WHERE f.user_id=$1 ORDER BY f.created_at DESC LIMIT 20`,
      [(await t.me(ctx)).id],
    );
    await t.reply(
      ctx,
      items.length ? '🔔 <b>我的关注</b>' : '还没有关注任何机场。',
      listKeyboard(items),
    );
  });
  bot.command('submit', async (ctx) => {
    if (ctx.chat.type !== 'private')
      return t.reply(
        ctx,
        '请私聊机器人投稿，避免泄露订阅地址。',
        markup([
          [
            ...(t.deepLink(ctx, 'submit')
              ? [{ text: '💬 私聊投稿', url: t.deepLink(ctx, 'submit')! }]
              : []),
          ],
        ]),
      );
    if (!ctx.match.trim()) return t.reply(ctx, submitHelp);
    const [name, slug, websites, subscription] = ctx.match.split('|').map((s) => s.trim());
    const input = {
      name,
      slug: slug?.toLowerCase(),
      endpoints: [
        ...(websites ?? '')
          .split(/\s+/)
          .filter(Boolean)
          .map((url) => ({ kind: 'website', url })),
        ...(subscription ? [{ kind: 'subscription', url: subscription }] : []),
      ],
    };
    if (!Value.Check(ProviderInput, input) || !input.endpoints.some((e) => e.kind === 'website'))
      return t.reply(ctx, submitHelp);
    const user = await t.me(ctx);
    const [stats] = await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM submissions WHERE user_id=$1 AND created_at>now()-interval '1 hour'",
      [user.id],
    );
    if (stats!.count >= 5) return t.reply(ctx, '每小时最多投稿 5 次。');
    await createSubmission(db, config, user, prepareProvider(input, config), ctx.update.update_id);
    const mine = webLink(config, '/me/submissions');
    await t.reply(
      ctx,
      '📮 投稿已提交，审核结果会私信通知你。',
      mine ? markup([[{ text: '🌐 我的投稿', url: mine }]]) : undefined,
    );
  });

  const id = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
  const provider = async (ctx: Context & { match: RegExpMatchArray | string }) => {
    const match = ctx.match as RegExpMatchArray;
    const p = await v.byId(match[match.length - 1]!);
    if (!p) throw new AppError(404, 'NOT_FOUND', 'Provider not found');
    return p;
  };
  bot.callbackQuery(new RegExp(`^p:${id}$`), async (ctx) =>
    t.show(ctx, await card(ctx, await provider(ctx))),
  );
  bot.callbackQuery(new RegExp(`^cer:${id}$`), async (ctx) => {
    const p = await provider(ctx);
    if (p.lifecycle !== 'dead') throw new AppError(409, 'NOT_DEAD', 'Not dead');
    await t.show(ctx, v.ceremony(p));
  });
  bot.callbackQuery(/^gy:(\d{1,6})$/, async (ctx) =>
    t.show(ctx, await v.graveyard(Number(ctx.match[1]))),
  );
  bot.callbackQuery(new RegExp(`^(fo|uf):${id}$`), async (ctx) => {
    const p = await provider(ctx);
    const follow = ctx.match[1] === 'fo';
    const user = await t.me(ctx);
    await setFollow(db, user.id, p.id, follow);
    await t.answer(ctx, follow ? '已关注，状态变化会私信通知你' : '已取消关注');
    // Follow state is personal, so only refresh the buttons in the user's own chat.
    if (ctx.callbackQuery.message?.chat.type === 'private')
      await ctx
        .editMessageReplyMarkup({
          reply_markup: (await v.provider(p, ctx.me.username, user.id)).markup,
        })
        .catch(ignore400);
  });
  async function sendReport(ctx: Context, report: { rich: string; text: string }) {
    const query = ctx.callbackQuery;
    const group = query?.message && isGroupChat(query.message.chat.type);
    const ephemeral = group
      ? {
          ephemeral_message_parameters: {
            receiver_user_id: query!.from.id,
            callback_query_id: query!.id,
          },
        }
      : {};
    const chatId = ctx.chat?.id ?? query?.message?.chat.id;
    if (chatId === undefined) return false;
    try {
      await ctx.api.sendRichMessage(
        chatId,
        { html: report.rich, skip_entity_detection: true },
        ephemeral,
      );
    } catch (error) {
      ignore400(error);
      // Clients or chats without rich message support get the same data as regular HTML.
      try {
        await ctx.api.sendMessage(chatId, report.text, { ...HTML, ...ephemeral });
      } catch (fallback) {
        ignore400(fallback);
        return false;
      }
    }
    return true;
  }
  bot.callbackQuery(new RegExp(`^rep:${id}$`), async (ctx) => {
    const p = await provider(ctx);
    const report = await v.report(p);
    if (await sendReport(ctx, report)) return void (await t.answer(ctx));
    const url = t.deepLink(ctx, report.start);
    await ctx.answerCallbackQuery(url ? { url } : { text: '请私聊机器人查看' }).catch(ignore400);
  });
  bot.callbackQuery(new RegExp(`^(${tributeKinds.join('|')}):${id}$`), async (ctx) => {
    const kind = ctx.match[1] as TributeKind;
    const p = await provider(ctx);
    const result = await addTribute(db, p.id, (await t.me(ctx)).id, kind);
    await t.answer(
      ctx,
      result.created ? `${tributeLabels[kind]} · 心意已送达` : '今天已经送过这份心意了',
    );
    // Ceremony cards and inline cards show live counters; refresh them for everyone.
    const message = ctx.callbackQuery.message;
    const ceremony =
      ctx.callbackQuery.inline_message_id ||
      (message && 'text' in message && message.text?.startsWith('🕯 电子追悼会'));
    if (result.created && ceremony) {
      const fresh = (await v.byId(p.id))!;
      const keyboard =
        message && 'reply_markup' in message && message.reply_markup
          ? message.reply_markup
          : article(fresh, config, ctx.me.username).reply_markup;
      await ctx
        .editMessageText(ceremonyCard(fresh), {
          ...HTML,
          ...hasMarkup(keyboard as InlineKeyboardMarkup | undefined),
        })
        .catch(ignore400);
    }
  });

  bot.on('inline_query', async (ctx) => {
    const offset = Math.min(Number(ctx.inlineQuery.offset) || 0, 1000);
    const items = await v.search(ctx.inlineQuery.query, 20, offset);
    await ctx.answerInlineQuery(
      items.map((p) => article(p, config, ctx.me.username)),
      {
        cache_time: 30,
        is_personal: false,
        next_offset: items.length === 20 ? String(offset + 20) : '',
        button: { text: '在机器人中查看墓园', start_parameter: 'graveyard' },
      },
    );
  });
  bot.on('message:migrate_to_chat_id', async (ctx) => {
    await db.query('UPDATE telegram_chats SET id=$1 WHERE id=$2', [
      String(ctx.message.migrate_to_chat_id),
      String(ctx.chat.id),
    ]);
  });
}

const reviewMarker = /^复核单：(dead|recovered|dismissed) ([0-9a-f-]{36})$/m;
const rejectMarker = /^驳回单：([0-9a-f-]{36})$/m;

/** Reviewer console in the private chat. Every action re-checks the current role in the database. */
function registerReviewHandlers(bot: Bot, db: DB, config: Config, v: Views, t: Tools) {
  const privateOnly = async (ctx: Context) => {
    if (ctx.chat?.type === 'private' || ctx.callbackQuery?.message?.chat.type === 'private')
      return true;
    await (ctx.callbackQuery
      ? t.answer(ctx, '请在私聊中操作', true)
      : t.reply(ctx, '请私聊机器人操作。'));
    return false;
  };
  async function reviewer(ctx: Context) {
    if (!(await privateOnly(ctx))) return undefined;
    const user = await t.staff(ctx);
    if (!user)
      await (ctx.callbackQuery
        ? t.answer(ctx, '需要后台审核权限', true)
        : t.reply(ctx, '需要后台审核权限，请先在网站绑定 Telegram 账号。'));
    return user;
  }
  const done = (ctx: Context, label: string) =>
    ctx
      .editMessageReplyMarkup({ reply_markup: markup([[{ text: label, disabled: {} }]]) })
      .catch(ignore400);
  const resolve = async (
    ctx: Context,
    user: { id: string },
    incidentId: string,
    action: 'dead' | 'recovered' | 'dismissed',
    evidenceUrls: string[],
    reason: string,
    epitaph?: string,
  ) => {
    const result = await resolveIncident(
      db,
      config,
      incidentId,
      { action, reason, evidenceUrls, ...(epitaph ? { epitaph } : {}) },
      user.id,
    );
    await t.reply(ctx, `✅ 复核已保存：${reviewLabels[action]}（${result.status}）`);
  };

  bot.command('pending', async (ctx) => {
    if (!(await reviewer(ctx))) return;
    const view = await v.pending();
    await t.reply(ctx, view.text, view.markup);
  });
  bot.callbackQuery('pd', async (ctx) => {
    if (await reviewer(ctx)) await t.show(ctx, await v.pending());
  });
  bot.callbackQuery(/^(?:ri|review):([0-9a-f-]{36})$/, async (ctx) => {
    if (!(await reviewer(ctx))) return;
    const view = await v.incident(ctx.match[1]!);
    if (!view) throw new AppError(404, 'NOT_FOUND', 'Incident not found');
    await t.show(ctx, view);
  });
  bot.callbackQuery(/^ps:(\d{1,4})$/, async (ctx) => {
    if (await reviewer(ctx)) await t.show(ctx, await v.submission(Number(ctx.match[1])));
  });
  bot.callbackQuery(/^pm:(\d{1,4})$/, async (ctx) => {
    if (await reviewer(ctx)) await t.show(ctx, await v.memorial(Number(ctx.match[1])));
  });

  // Buttons never change state on their own: the reviewer must reply with evidence and a reason.
  bot.callbackQuery(/^rv:([drx]):([0-9a-f-]{36})$/, async (ctx) => {
    if (!(await reviewer(ctx))) return;
    const action = reviewActions[ctx.match[1] as keyof typeof reviewActions];
    const view = await v.incident(ctx.match[2]!);
    if (!view) throw new AppError(404, 'NOT_FOUND', 'Incident not found');
    if (
      !view.markup?.inline_keyboard.some((row) =>
        row.some((b) => 'callback_data' in b && b.callback_data.startsWith('rv:')),
      )
    )
      return void (await t.answer(ctx, '已经有人处理过了', true));
    await t.answer(ctx);
    await ctx.reply(
      [
        `🧾 <b>${reviewLabels[action]}</b>`,
        '回复本消息：第一行写证据链接（多个用空格分隔），第二行起写核验原因。',
        ...(action === 'dead' ? ['可另起一行写 <code>墓志铭：……</code>，留空则使用原因。'] : []),
        '',
        `复核单：${action} ${ctx.match[2]}`,
      ].join('\n'),
      {
        ...HTML,
        reply_markup: { force_reply: true, input_field_placeholder: 'https://证据链接 换行写原因' },
      },
    );
  });
  bot.callbackQuery(/^sb:([ar]):([0-9a-f-]{36})$/, async (ctx) => {
    const user = await reviewer(ctx);
    if (!user) return;
    if (ctx.match[1] === 'a') {
      await reviewSubmission(
        db,
        config,
        ctx.match[2]!,
        { approve: true, reason: '审核通过' },
        user.id,
      );
      await done(ctx, `✅ 已通过 · ${user.display_name}`);
      return void (await t.answer(ctx, '已通过并收录'));
    }
    await t.answer(ctx);
    await ctx.reply(
      `❌ <b>驳回投稿</b>\n回复本消息写驳回原因，会私信告知投稿人。\n\n驳回单：${ctx.match[2]}`,
      {
        ...HTML,
        reply_markup: { force_reply: true, input_field_placeholder: '驳回原因' },
      },
    );
  });
  bot.callbackQuery(/^mm:([vh]):([0-9a-f-]{36})$/, async (ctx) => {
    const user = await reviewer(ctx);
    if (!user) return;
    const visible = ctx.match[1] === 'v';
    await moderateMemorial(db, ctx.match[2]!, visible, user.id);
    await done(ctx, `${visible ? '👁 已公开' : '🙈 已隐藏'} · ${user.display_name}`);
    await t.answer(ctx, visible ? '已公开' : '已隐藏');
  });

  // Replies to the bot's own force-reply prompts carry the decision.
  bot.on('message:text', async (ctx, next) => {
    const prompt = ctx.message.reply_to_message;
    if (ctx.chat.type !== 'private' || !prompt || prompt.from?.id !== ctx.me.id || !prompt.text)
      return next();
    const review = reviewMarker.exec(prompt.text),
      reject = rejectMarker.exec(prompt.text);
    if (!review && !reject) return next();
    const user = await t.staff(ctx);
    if (!user) return t.reply(ctx, '需要后台审核权限。');
    if (reject) {
      const reason = ctx.message.text.trim();
      if (!reason || reason.length > 1000) return t.reply(ctx, '驳回原因需要 1–1000 字。');
      await reviewSubmission(db, config, reject[1]!, { approve: false, reason }, user.id);
      return t.reply(ctx, '❌ 已驳回，已私信通知投稿人。');
    }
    const [first = '', ...rest] = ctx.message.text.trim().split('\n');
    const urls = first.split(/\s+/).filter(Boolean);
    const epitaphLine = rest.find((line) => line.startsWith('墓志铭：'));
    const reason = rest
      .filter((line) => line !== epitaphLine)
      .join('\n')
      .trim();
    const validUrl = (u: string) =>
      URL.canParse(u) && /^https?:$/.test(new URL(u).protocol) && u.length <= 2048;
    if (
      !urls.length ||
      urls.length > 10 ||
      !urls.every(validUrl) ||
      reason.length < 3 ||
      reason.length > 2000
    )
      return t.reply(
        ctx,
        '格式：第一行写证据链接（http/https，最多 10 个），第二行起写原因（3–2000 字）。请重新点按钮再回复。',
      );
    await resolve(
      ctx,
      user,
      review![2]!,
      review![1] as 'dead',
      urls,
      reason,
      epitaphLine?.slice(4).trim().slice(0, 500) || undefined,
    );
  });
  bot.command('review', async (ctx) => {
    const user = await reviewer(ctx);
    if (!user) return;
    const [id, action, evidence, ...words] = ctx.match.split(/\s+/);
    const reason = words.join(' ');
    if (
      !/^[0-9a-f-]{36}$/.test(id ?? '') ||
      !['dead', 'recovered', 'dismissed'].includes(action ?? '') ||
      !URL.canParse(evidence ?? '') ||
      !/^https?:\/\//.test(evidence ?? '') ||
      reason.length < 3 ||
      reason.length > 2000
    )
      return t.reply(
        ctx,
        '格式：<code>/review 事件ID dead|recovered|dismissed https://证据 原因</code>\n也可以用 /pending 里的按钮复核。',
      );
    await resolve(ctx, user, id!, action as 'dead', [evidence!], reason);
  });

  bot.command('notify', async (ctx) => {
    if (!(await reviewer(ctx))) return;
    const [row] = await db.query<{ enabled: boolean }>(
      "SELECT enabled FROM telegram_chats WHERE id=$1 AND kind='admin'",
      [String(ctx.from!.id)],
    );
    await t.reply(
      ctx,
      `🔔 复核私信：${row?.enabled ? '已开启' : '未开启'}\n开启后会收到异常复核、投稿和留言的待办提醒。`,
      markup([
        [
          { text: '开启', callback_data: 'nt:1', style: 'success' },
          { text: '关闭', callback_data: 'nt:0' },
        ],
      ]),
    );
  });
  bot.callbackQuery(/^nt:([01])$/, async (ctx) => {
    const user = await reviewer(ctx);
    if (!user) return;
    const enabled = ctx.match[1] === '1',
      chatId = String(ctx.from.id);
    await db.transaction(async (tx) => {
      await tx.query(
        "INSERT INTO telegram_chats(id,title,kind,enabled) VALUES ($1,$2,'admin',$3) ON CONFLICT(id) DO UPDATE SET kind='admin',enabled=excluded.enabled,title=excluded.title",
        [chatId, ctx.from.first_name.slice(0, 255), enabled],
      );
      await audit(tx, user.id, 'telegram.notify', chatId, { enabled });
    });
    // Reviewers get their extra commands in this chat's menu.
    await ctx.api
      .setMyCommands(enabled ? commandMenus.reviewer : commandMenus.private, {
        scope: { type: 'chat', chat_id: ctx.from.id },
      })
      .catch(ignore400);
    await done(ctx, enabled ? '🔔 复核私信已开启' : '🔕 复核私信已关闭');
    await t.answer(ctx, enabled ? '已开启' : '已关闭');
  });
}

export async function processBotUpdates(
  db: DB,
  config: Config,
  bot: ReturnType<typeof createBot>,
  limit = 10,
) {
  await db.query(
    "UPDATE bot_updates SET status='failed' WHERE attempts>=5 AND (status='pending' OR status='running' AND lease_until<now())",
  );
  const rows = await db.query<{
    update_id: string;
    payload_ciphertext: string;
    lease_token: string;
    attempts: number;
  }>(
    `WITH picked AS (SELECT update_id FROM bot_updates WHERE attempts<5 AND available_at<=now() AND (status='pending' OR status='running' AND lease_until<now()) ORDER BY update_id FOR UPDATE SKIP LOCKED LIMIT $1) UPDATE bot_updates u SET status='running',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes' FROM picked WHERE u.update_id=picked.update_id RETURNING u.*`,
    [limit],
  );
  // Sequential handling keeps per-chat order; ephemeral replies must go out within 15 seconds.
  rows.sort((a, b) => Number(a.update_id) - Number(b.update_id));
  for (const row of rows) {
    try {
      await bot.handleUpdate(JSON.parse(decrypt(row.payload_ciphertext, config.appKey)) as Update);
      await db.query(
        "UPDATE bot_updates SET status='done',lease_until=NULL WHERE update_id=$1 AND lease_token=$2",
        [row.update_id, row.lease_token],
      );
    } catch {
      await db.query(
        "UPDATE bot_updates SET status=$1,lease_until=NULL,available_at=now()+$2*interval '1 second' WHERE update_id=$3 AND lease_token=$4",
        [
          row.attempts >= 5 ? 'failed' : 'pending',
          2 ** row.attempts * 5,
          row.update_id,
          row.lease_token,
        ],
      );
    }
  }
  return rows.length;
}
