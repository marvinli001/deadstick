import { randomBytes } from 'node:crypto';
import type { Bot, Context } from 'grammy';
import type { InlineKeyboardMarkup } from 'grammy/types';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { setFollow } from '../catalog/service.js';
import {
  clip,
  compactId,
  escape,
  lifecycleLabels,
  markup,
  miniAppButton,
  type ProviderView,
} from './format.js';
import type { View, views } from './views.js';

type Action = 'search' | 'follow' | 'unfollow' | 'report';
type Intent = { action: Action; query: string } | { action: 'cancel' };
const reference = /^(?:这家|这家机场|这个|它|一下这家|一下这家机场)$/;

export function conversationIntent(text: string): Intent | undefined {
  const raw = text.trim();
  if (!raw || raw.startsWith('/')) return undefined;
  if (/^(?:取消|算了|不查了|不报了|取消操作)[。！!]?$/u.test(raw)) return { action: 'cancel' };
  const sentence = raw.replace(/[？?。！!]+$/u, '').trim();
  if (/^(?:我来报个信|报个信|我要投稿|投稿|补充线索)$/u.test(sentence))
    return { action: 'report', query: '' };
  const patterns: Array<[Action, RegExp]> = [
    ['unfollow', /^(?:取消关注|退订)\s*(.*)$/u],
    ['follow', /^(?:关注|蹲一下|蹲)\s*(.*)$/u],
    ['report', /^(?:给|为)\s*(.+?)\s*(?:补充线索|补线索|报个信)$/u],
    ['report', /^(?:补充线索|补线索|报个信)\s+(.+)$/u],
    ['search', /^(?:查一下|查一查|帮我查一下|查查|查询|搜索)\s*(.*)$/u],
    ['search', /^(.+?)\s*(?:还活着吗|还活着么|还在吗|跑路了吗|跑路了没)$/u],
  ];
  for (const [action, pattern] of patterns) {
    const match = pattern.exec(sentence);
    if (match) {
      const query = match[1]!.trim();
      return { action, query: reference.test(query) ? '' : query };
    }
  }
  return { action: 'search', query: raw };
}

interface ConversationTools {
  me(ctx: Context): Promise<{ id: string }>;
  reply(ctx: Context, text: string, markup?: InlineKeyboardMarkup, rich?: string): Promise<void>;
  show(ctx: Context, view: View, notice?: string): Promise<void>;
  answer(ctx: Context, text?: string, alert?: boolean): Promise<unknown>;
}
interface Pending {
  token: string;
  action: Action;
  candidates?: string[];
  providerId?: string;
}
interface Conversation {
  current?: string;
  pending?: Pending;
}

export function createConversation(
  db: DB,
  config: Config,
  v: ReturnType<typeof views>,
  t: ConversationTools,
) {
  async function state(ctx: Context) {
    const [row] = await db.query<{ state: Conversation }>(
      'SELECT state FROM bot_conversations WHERE user_id=$1 AND expires_at>now()',
      [String(ctx.from!.id)],
    );
    return row?.state;
  }
  async function save(ctx: Context, entry: Conversation) {
    await db.query(
      "INSERT INTO bot_conversations(user_id,state,expires_at) VALUES ($1,$2,now()+interval '15 minutes') ON CONFLICT(user_id) DO UPDATE SET state=excluded.state,expires_at=excluded.expires_at",
      [String(ctx.from!.id), entry],
    );
    return entry;
  }
  async function clear(ctx: Context) {
    await db.query('DELETE FROM bot_conversations WHERE user_id=$1', [String(ctx.from!.id)]);
  }
  async function consume(ctx: Context, token: string, tx = db) {
    const rows = await tx.query(
      "UPDATE bot_conversations SET state=state-'pending' WHERE user_id=$1 AND expires_at>now() AND state->'pending'->>'token'=$2 RETURNING user_id",
      [String(ctx.from!.id), token],
    );
    return rows.length > 0;
  }
  async function remember(ctx: Context, p: ProviderView) {
    if (ctx.chat?.type === 'private') await save(ctx, { current: p.id });
  }
  async function pending(ctx: Context, action: Action, extra: Partial<Pending> = {}) {
    const entry = await save(ctx, {
      current: (await state(ctx))?.current,
      pending: { token: randomBytes(6).toString('hex'), action, ...extra },
    });
    return entry.pending!;
  }
  const cancelRow = (p: Pending) => [{ text: '取消', callback_data: `cv:${p.token}:cancel` }];
  async function display(ctx: Context, text: string, keyboard?: InlineKeyboardMarkup) {
    if (ctx.callbackQuery) await t.show(ctx, { text, markup: keyboard, start: 'start' });
    else await t.reply(ctx, text, keyboard);
  }
  async function clarify(ctx: Context, action: Action) {
    const p = await pending(ctx, action);
    await display(
      ctx,
      action === 'unfollow'
        ? '要取消关注哪家？发机场名或官网域名。'
        : action === 'follow'
          ? '蹲哪家？发机场名或官网域名。'
          : '查哪家？发机场名或官网域名。',
      markup([cancelRow(p)]),
    );
  }
  async function reportMenu(ctx: Context) {
    const p = await pending(ctx, 'report');
    await display(
      ctx,
      '报新机场，还是给已有机场补线索？',
      markup([
        miniAppButton(config, '报新机场', 'submit', true),
        [{ text: '给已有机场补线索', callback_data: `cv:${p.token}:existing` }],
        cancelRow(p),
      ]),
    );
  }
  async function target(ctx: Context, action: Action, provider: ProviderView) {
    await remember(ctx, provider);
    if (action === 'search') {
      const view = await v.provider(provider, ctx.me.username, (await t.me(ctx)).id);
      if (ctx.callbackQuery) await t.show(ctx, view);
      else await t.reply(ctx, view.text, view.markup, view.rich);
      return;
    }
    const p = await pending(ctx, action, { providerId: provider.id });
    const title = `<b>${escape(provider.name)}</b> · <code>${escape(provider.slug)}</code>`;
    if (action === 'report') {
      await display(
        ctx,
        `给 ${title} 补线索。`,
        markup([
          miniAppButton(config, '填写线索', `report_${compactId(provider.id)}`, true),
          cancelRow(p),
        ]),
      );
      return;
    }
    await display(
      ctx,
      `${action === 'follow' ? '关注' : '取消关注'} ${title}？`,
      markup([
        [
          {
            text: action === 'follow' ? '确认关注' : '确认取消关注',
            callback_data: `cv:${p.token}:confirm`,
          },
        ],
        cancelRow(p),
      ]),
    );
  }
  async function search(ctx: Context, action: Action, query: string) {
    const exact = await v.find(query);
    const items = exact ? [exact] : await v.search(query, 8);
    if (items.length === 1) return target(ctx, action, items[0]!);
    const p: Pending = {
      token: randomBytes(6).toString('hex'),
      action,
      candidates: items.map((item) => item.id),
    };
    await save(ctx, { pending: p });
    await display(
      ctx,
      items.length
        ? `「${escape(query)}」有几家，选一下。`
        : `没找到「${escape(query)}」。换个名字或官网域名？`,
      markup([
        ...items.map((item) => [
          {
            text: clip(
              `${item.name} · ${item.slug} · ${lifecycleLabels[item.lifecycle] ?? item.lifecycle}`,
              64,
            ),
            callback_data: `cv:${p.token}:pick:${compactId(item.id)}`,
          },
        ]),
        ...(!items.length ? [miniAppButton(config, '报新机场', 'submit', true)] : []),
        cancelRow(p),
      ]),
    );
  }
  function register(bot: Bot) {
    bot.callbackQuery(
      /^cv:([0-9a-f]{12}):(cancel|existing|confirm|pick)(?::([0-9a-f]{32}))?$/,
      async (ctx) => {
        if (ctx.chat?.type !== 'private') return void (await t.answer(ctx, '请在私聊里操作', true));
        const entry = await state(ctx),
          p = entry?.pending;
        if (!p || p.token !== ctx.match[1])
          return void (await t.answer(ctx, '这轮对话已结束，重新发机场名就行。', true));
        const operation = ctx.match[2];
        if (operation === 'cancel') {
          const removed = await db.query(
            "DELETE FROM bot_conversations WHERE user_id=$1 AND expires_at>now() AND state->'pending'->>'token'=$2 RETURNING user_id",
            [String(ctx.from.id), p.token],
          );
          if (removed.length) return display(ctx, '已取消。');
        }
        if (operation === 'existing' && p.action === 'report' && (await consume(ctx, p.token)))
          return clarify(ctx, 'report');
        if (operation === 'pick' && p.candidates) {
          const id = p.candidates.find((id) => compactId(id) === ctx.match[3]);
          const provider = id ? await v.byId(id) : undefined;
          if (provider && (await consume(ctx, p.token))) return target(ctx, p.action, provider);
        }
        if (
          operation === 'confirm' &&
          p.providerId &&
          (p.action === 'follow' || p.action === 'unfollow')
        ) {
          const provider = await v.byId(p.providerId);
          if (provider) {
            const follow = p.action === 'follow';
            const user = await t.me(ctx);
            const changed = await db.transaction(async (tx) => {
              if (!(await consume(ctx, p.token, tx))) return false;
              await setFollow(tx, user.id, provider.id, follow);
              return true;
            });
            if (changed)
              return display(
                ctx,
                follow
                  ? `已关注 <b>${escape(provider.name)}</b>，状态变化会私信你。`
                  : `已取消关注 <b>${escape(provider.name)}</b>。`,
              );
          }
        }
        await t.answer(ctx, '目标已变化，重新发机场名试试。', true);
      },
    );
    bot.callbackQuery('cv:report', async (ctx) => {
      if (ctx.chat?.type === 'private') await reportMenu(ctx);
      else await t.answer(ctx, '请私聊机器人报信', true);
    });
    bot.callbackQuery('cv:search', async (ctx) => {
      if (ctx.chat?.type === 'private') await clarify(ctx, 'search');
      else await t.answer(ctx, '请私聊机器人查询', true);
    });
    bot.command('cancel', async (ctx) => {
      if (ctx.chat.type !== 'private') return;
      await clear(ctx);
      await t.reply(ctx, '已取消。');
    });
    bot.on('message:text', async (ctx, next) => {
      if (ctx.chat.type !== 'private') return next();
      const intent = conversationIntent(ctx.message.text);
      if (!intent) return next();
      if (intent.action === 'cancel') {
        await clear(ctx);
        return t.reply(ctx, '已取消。');
      }
      if (ctx.message.text.length > 120)
        return t.reply(ctx, '发机场名或官网域名就行，120 字以内。');
      const entry = await state(ctx);
      if (
        intent.action === 'report' &&
        !intent.query &&
        /^(?:我来报个信|报个信|我要投稿|投稿|补充线索)[。！!？?]?$/u.test(ctx.message.text.trim())
      )
        return reportMenu(ctx);
      if (!intent.query) {
        const provider = entry?.current ? await v.byId(entry.current) : undefined;
        return provider ? target(ctx, intent.action, provider) : clarify(ctx, intent.action);
      }
      // An exact catalog name wins over words that happen to look like an intent.
      if (intent.query !== ctx.message.text.trim()) {
        const exact = await v.find(ctx.message.text.trim());
        if (exact) return target(ctx, 'search', exact);
      }
      const action =
        intent.action === 'search' &&
        intent.query === ctx.message.text.trim() &&
        entry?.pending &&
        !entry.pending.providerId
          ? entry.pending.action
          : intent.action;
      await search(ctx, action, intent.query);
    });
  }
  return { remember, target, register };
}
