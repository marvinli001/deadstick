import { Bot, InlineKeyboard } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { Value } from '@sinclair/typebox/value';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { telegramUser } from '../auth/service.js';
import { AppError } from '../errors.js';
import { addTribute, prepareProvider, resolveIncident } from '../catalog/service.js';
import { ProviderInput } from '../catalog/schemas.js';
import { decrypt } from '../crypto.js';
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

export const commands = [
  { command: 'start', description: '开始使用 / 账号信息' },
  { command: 'help', description: '使用说明' },
  { command: 'search', description: '搜索机场' },
  { command: 'status', description: '查看机场状态：slug' },
  { command: 'graveyard', description: '逛赛博墓园' },
  { command: 'tribute', description: '献花：slug' },
  { command: 'memorial', description: '追悼留言：slug 留言' },
  { command: 'ceremony', description: '电子追悼会：slug' },
  { command: 'follow', description: '关注机场：slug' },
  { command: 'unfollow', description: '取消关注：slug' },
  { command: 'submit', description: '私聊投稿：名称 | slug | 官网 | 订阅(可选)' },
  { command: 'review', description: '管理复核：事件ID dead/recovered/dismissed 证据URL 原因' },
];
type ProviderRow = {
  id: string;
  name: string;
  slug: string;
  lifecycle: string;
  health: string;
  epitaph: string | null;
};
export function createBot(db: DB, config: Config, botInfo?: UserFromGetMe) {
  const bot = new Bot(config.botToken!, botInfo ? { botInfo } : undefined);
  bot.use(async (ctx, next) => {
    if (ctx.chat && ctx.chat.type !== 'private') {
      const [allowed] = await db.query(
        "SELECT id FROM telegram_chats WHERE id=$1 AND kind='group' AND enabled",
        [String(ctx.chat.id)],
      );
      if (!allowed) return;
    }
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
  async function find(query: string): Promise<ProviderRow | undefined> {
    return (
      await db.query<ProviderRow>(
        'SELECT id,name,slug,lifecycle,health,epitaph FROM providers WHERE slug=$1 OR id::text=$1 LIMIT 1',
        [query.trim()],
      )
    )[0];
  }
  const info = (p: ProviderRow) =>
    `${p.lifecycle === 'dead' ? '🪦' : p.lifecycle === 'suspected' ? '⚠️' : '✈️'} ${p.name}\n编号：${p.slug}\n状态：${p.lifecycle} / ${p.health}${p.epitaph ? `\n墓志铭：${p.epitaph.slice(0, 200)}` : ''}`;
  bot.command(['start', 'help'], async (ctx) => {
    const user = await telegramUser(db, { id: String(ctx.from!.id), name: ctx.from!.first_name });
    await ctx.reply(
      `Deadstick · 机场观察与赛博墓园\n/search 名称 · /status slug\n/graveyard · /tribute slug\n/memorial slug 留言 · /ceremony slug\n/follow slug · /unfollow slug\n私聊投稿：/submit 名称 | slug | 官网 | 订阅(可选)\n订阅只在私聊提交。\n你的 Telegram ID：${ctx.from!.id}\n账号：${user.id}`,
    );
  });
  bot.command('search', async (ctx) => {
    const rows = await db.query<ProviderRow>(
      "SELECT id,name,slug,lifecycle,health,epitaph FROM providers WHERE name ILIKE '%'||$1||'%' OR slug ILIKE '%'||$1||'%' ORDER BY created_at DESC LIMIT 5",
      [ctx.match.slice(0, 120)],
    );
    await ctx.reply(rows.length ? rows.map(info).join('\n\n') : '暂无记录');
  });
  bot.command('status', async (ctx) => {
    const p = await find(ctx.match);
    await ctx.reply(p ? info(p) : '未找到机场，用法：/status slug');
  });
  bot.command('graveyard', async (ctx) => {
    const rows = await db.query<ProviderRow>(
      "SELECT id,name,slug,lifecycle,health,epitaph FROM providers WHERE lifecycle='dead' ORDER BY death_at DESC LIMIT 5",
    );
    await ctx.reply(rows.length ? rows.map(info).join('\n\n') : '墓园暂无已确认的记录');
  });
  bot.command('tribute', async (ctx) => {
    const p = await find(ctx.match);
    if (!p) return void (await ctx.reply('用法：/tribute slug'));
    const user = await telegramUser(db, { id: String(ctx.from!.id), name: ctx.from!.first_name });
    try {
      const result = await addTribute(db, p.id, user.id, 'flower');
      await ctx.reply(result.created ? `🌼 为 ${p.name} 献上一束花。` : '今天已经献过花了。');
    } catch (error) {
      if (error instanceof AppError) await ctx.reply(error.message);
      else throw error;
    }
  });
  bot.command(['follow', 'unfollow'], async (ctx) => {
    const p = await find(ctx.match);
    if (!p) return void (await ctx.reply('未找到机场'));
    const user = await telegramUser(db, { id: String(ctx.from!.id), name: ctx.from!.first_name });
    const unfollow = ctx.message!.text.split(' ')[0]!.split('@')[0] === '/unfollow';
    if (unfollow)
      await db.query('DELETE FROM follows WHERE user_id=$1 AND provider_id=$2', [user.id, p.id]);
    else
      await db.query(
        'INSERT INTO follows(user_id,provider_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [user.id, p.id],
      );
    await ctx.reply(
      unfollow ? '已取消关注' : `已关注 ${p.name}。请先私聊机器人点击 Start，以便收到通知。`,
    );
  });
  bot.command('memorial', async (ctx) => {
    const [slug, ...words] = ctx.match.split(/\s+/),
      body = words.join(' '),
      p = await find(slug ?? '');
    if (!p || p.lifecycle !== 'dead' || !body || body.length > 1000)
      return void (await ctx.reply('用法：/memorial 已确认跑路的slug 留言（1000字以内）'));
    const user = await telegramUser(db, { id: String(ctx.from!.id), name: ctx.from!.first_name });
    await db.query(
      "INSERT INTO memorials(provider_id,user_id,body,source_update_id) SELECT id,$2,$3,$4 FROM providers WHERE id=$1 AND lifecycle='dead' ON CONFLICT(source_update_id) DO NOTHING",
      [p.id, user.id, body, ctx.update.update_id],
    );
    await ctx.reply('追悼留言已提交，审核后展示。');
  });
  bot.command('ceremony', async (ctx) => {
    const p = await find(ctx.match);
    if (!p || p.lifecycle !== 'dead')
      return void (await ctx.reply('用法：/ceremony 已确认跑路的slug'));
    const [counts] = await db.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM tributes WHERE provider_id=$1',
      [p.id],
    );
    await ctx.reply(
      `🕯 电子追悼会\n${p.name}\n${p.epitaph ?? '愿后来者少走弯路。'}\n已有 ${counts!.count} 份祭奠。`,
      {
        reply_markup: new InlineKeyboard()
          .text('🌼 献花', `flower:${p.id}`)
          .text('🕯 点烛', `candle:${p.id}`)
          .text('🙏 上香', `incense:${p.id}`),
      },
    );
  });
  bot.callbackQuery(/^(flower|candle|incense):([0-9a-f-]{36})$/, async (ctx) => {
    const user = await telegramUser(db, { id: String(ctx.from.id), name: ctx.from.first_name });
    try {
      const result = await addTribute(
        db,
        ctx.match[2]!,
        user.id,
        ctx.match[1] as 'flower' | 'candle' | 'incense',
      );
      await ctx.answerCallbackQuery(result.created ? '心意已送达' : '今天已送过这份心意');
    } catch (error) {
      if (error instanceof AppError) await ctx.answerCallbackQuery(error.message);
      else throw error;
    }
  });
  bot.command('submit', async (ctx) => {
    if (ctx.chat.type !== 'private')
      return void (await ctx.reply('请私聊机器人投稿，避免泄露订阅地址。'));
    const [name, slug, website, subscription] = ctx.match.split('|').map((s) => s.trim());
    const input = {
      name,
      slug,
      endpoints: [
        { kind: 'website', url: website },
        ...(subscription ? [{ kind: 'subscription', url: subscription }] : []),
      ],
    };
    if (!Value.Check(ProviderInput, input))
      return void (await ctx.reply(
        '格式：/submit 名称 | slug | https://官网 | https://订阅（可选）',
      ));
    try {
      const payload = prepareProvider(input, config),
        user = await telegramUser(db, { id: String(ctx.from!.id), name: ctx.from!.first_name });
      const [stats] = await db.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM submissions WHERE user_id=$1 AND created_at>now()-interval '1 hour'",
        [user.id],
      );
      if (stats!.count >= 5) return void (await ctx.reply('每小时最多投稿5次。'));
      await db.query(
        'INSERT INTO submissions(user_id,payload,source_update_id) VALUES ($1,$2,$3) ON CONFLICT(source_update_id) DO NOTHING',
        [user.id, JSON.stringify(payload), ctx.update.update_id],
      );
      await ctx.reply('投稿已提交，等待管理员审核。');
    } catch (error) {
      if (error instanceof AppError) await ctx.reply(error.message);
      else throw error;
    }
  });
  bot.callbackQuery(/^review:([0-9a-f-]{36})$/, async (ctx) => {
    const [user] = await db.query<{ role: string }>(
      'SELECT role FROM users WHERE telegram_id=$1 AND NOT disabled',
      [String(ctx.from.id)],
    );
    if (!user || !['admin', 'moderator'].includes(user.role))
      return void (await ctx.answerCallbackQuery('需要后台审核权限'));
    await ctx.answerCallbackQuery('请核验证据后提交复核命令');
    await ctx.reply(
      `/review ${ctx.match[1]} dead/recovered/dismissed https://证据地址 核验原因\n确认跑路必须提供证据和原因；仅点击按钮不会修改状态。`,
    );
  });
  bot.command('review', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const [user] = await db.query<{ id: string; role: string }>(
      'SELECT id,role FROM users WHERE telegram_id=$1 AND NOT disabled',
      [String(ctx.from!.id)],
    );
    if (!user || !['admin', 'moderator'].includes(user.role))
      return void (await ctx.reply('需要后台审核权限，请先在网站绑定 Telegram 账号。'));
    const [id, action, evidence, ...reason] = ctx.match.split(/\s+/);
    if (
      !/^[0-9a-f-]{36}$/.test(id ?? '') ||
      !['dead', 'recovered', 'dismissed'].includes(action ?? '') ||
      !/^https?:\/\//.test(evidence ?? '') ||
      reason.join(' ').length < 3 ||
      reason.join(' ').length > 2000
    )
      return void (await ctx.reply(
        '格式：/review 事件ID dead/recovered/dismissed https://证据URL 核验原因',
      ));
    try {
      new URL(evidence!);
      const result = await resolveIncident(
        db,
        config,
        id!,
        {
          action: action as 'dead' | 'recovered' | 'dismissed',
          reason: reason.join(' '),
          evidenceUrls: [evidence!],
        },
        user.id,
      );
      await ctx.reply(`复核已保存：${result.status}`);
    } catch (error) {
      if (error instanceof AppError) await ctx.reply(error.message);
      else throw error;
    }
  });
  bot.on('inline_query', async (ctx) => {
    const rows = await db.query<ProviderRow>(
      "SELECT id,name,slug,lifecycle,health,epitaph FROM providers WHERE name ILIKE '%'||$1||'%' OR slug ILIKE '%'||$1||'%' ORDER BY created_at DESC LIMIT 10",
      [ctx.inlineQuery.query.slice(0, 120)],
    );
    await ctx.answerInlineQuery(
      rows.map((p) => ({
        type: 'article' as const,
        id: p.id,
        title: p.name,
        description: `${p.lifecycle} · ${p.health}`,
        input_message_content: { message_text: info(p) },
      })),
      { cache_time: 30, is_personal: false },
    );
  });
  bot.on('message:migrate_to_chat_id', async (ctx) => {
    await db.query('UPDATE telegram_chats SET id=$1 WHERE id=$2', [
      String(ctx.message.migrate_to_chat_id),
      String(ctx.chat.id),
    ]);
  });
  return bot;
}
export async function processBotUpdates(db: DB, config: Config, bot: ReturnType<typeof createBot>) {
  await db.query(
    "UPDATE bot_updates SET status='failed' WHERE attempts>=5 AND (status='pending' OR status='running' AND lease_until<now())",
  );
  const rows = await db.query<{
    update_id: string;
    payload_ciphertext: string;
    lease_token: string;
    attempts: number;
  }>(
    `WITH picked AS (SELECT update_id FROM bot_updates WHERE attempts<5 AND available_at<=now() AND (status='pending' OR status='running' AND lease_until<now()) ORDER BY update_id FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE bot_updates u SET status='running',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes' FROM picked WHERE u.update_id=picked.update_id RETURNING u.*`,
  );
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
