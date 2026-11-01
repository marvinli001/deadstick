import type { DB } from '../db.js';
import type { Config } from '../config.js';
import type { InlineKeyboardMarkup } from 'grammy/types';
import { commandsFor } from './commands.js';
import {
  clip,
  compactId,
  escape,
  markup,
  miniAppLink,
  miniAppButton,
  reviewKeyboard,
  startLink,
  tributeRow,
} from './format.js';

export async function enqueue(
  db: DB,
  key: string,
  chatId: string,
  payload: object,
  topicId: number | null = null,
  options: { method?: string; subject?: string } = {},
) {
  await db.query(
    'INSERT INTO notifications(dedupe_key,chat_id,topic_id,payload,method,subject) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
    [
      key,
      chatId,
      topicId,
      JSON.stringify(payload),
      options.method ?? 'sendMessage',
      options.subject ?? null,
    ],
  );
}
interface Outgoing {
  text: string;
  reply_markup?: InlineKeyboardMarkup;
}
const html = (message: Outgoing) => ({
  text: message.text,
  parse_mode: 'HTML',
  link_preview_options: { is_disabled: true },
  ...(message.reply_markup?.inline_keyboard.length ? { reply_markup: message.reply_markup } : {}),
});
const reviewerChats = (db: DB) =>
  db.query<{ id: string }>(
    "SELECT c.id FROM telegram_chats c JOIN users u ON u.telegram_id=c.id WHERE c.kind='admin' AND c.enabled AND u.role IN ('admin','moderator') AND NOT u.disabled",
  );

/** Bound groups, reviewers and followers. Reviewers get `review` buttons tagged with its subject. */
async function broadcast(
  db: DB,
  providerId: string,
  key: string,
  message: Outgoing,
  review?: { subject: string; reply_markup: InlineKeyboardMarkup },
) {
  const chats = await db.query<{ id: string; topic_id: number | null; kind: string }>(
    "SELECT c.id,c.topic_id,c.kind FROM telegram_chats c WHERE c.enabled AND (c.kind='group' OR EXISTS(SELECT 1 FROM users u WHERE u.telegram_id=c.id AND u.role IN ('admin','moderator') AND NOT u.disabled))",
  );
  const followers = await db.query<{ id: string; topic_id: null; kind: string }>(
    "SELECT u.telegram_id AS id,NULL AS topic_id,'follower' AS kind FROM follows f JOIN users u ON u.id=f.user_id WHERE f.provider_id=$1 AND u.telegram_id IS NOT NULL AND NOT u.disabled",
    [providerId],
  );
  const seen = new Set<string>();
  for (const chat of [...chats, ...followers]) {
    if (seen.has(chat.id)) continue;
    seen.add(chat.id);
    const reviewer = chat.kind === 'admin' && review;
    await enqueue(
      db,
      `${key}:${chat.id}`,
      chat.id,
      html(reviewer ? { text: message.text, reply_markup: review.reply_markup } : message),
      chat.topic_id,
      { subject: reviewer ? review.subject : undefined },
    );
  }
}
async function notifyReviewers(db: DB, key: string, subject: string, message: Outgoing) {
  for (const chat of await reviewerChats(db))
    await enqueue(db, `${key}:${chat.id}`, chat.id, html(message), null, { subject });
}
/** Chat binding is an administrator action, so these alerts skip moderators. */
export async function notifyAdmins(db: DB, key: string, message: Outgoing) {
  const chats = await db.query<{ id: string }>(
    "SELECT c.id FROM telegram_chats c JOIN users u ON u.telegram_id=c.id WHERE c.kind='admin' AND c.enabled AND u.role='admin' AND NOT u.disabled",
  );
  for (const chat of chats) await enqueue(db, `${key}:${chat.id}`, chat.id, html(message));
}
/** Removes the action buttons from review messages that were already delivered. */
export async function clearReviewButtons(db: DB, subject: string) {
  const sent = await db.query<{ chat_id: string; message_id: string }>(
    "SELECT chat_id,message_id FROM notifications WHERE subject=$1 AND status='sent' AND message_id IS NOT NULL AND method='sendMessage'",
    [subject],
  );
  for (const row of sent)
    await enqueue(
      db,
      `clear:${subject}:${row.chat_id}:${row.message_id}`,
      row.chat_id,
      { message_id: Number(row.message_id), reply_markup: { inline_keyboard: [] } },
      null,
      { method: 'editMessageReplyMarkup' },
    );
}

export interface ProviderRef {
  id: string;
  name: string;
  slug: string;
}
const headline = (p: ProviderRef) => `${escape(p.name)} · <code>${escape(p.slug)}</code>`;
const detailUrl = (config: Config, p: ProviderRef) =>
  miniAppLink(config, `p_${compactId(p.id)}`) ??
  startLink(config.botUsername, `p_${compactId(p.id)}`);
const detailRow = (config: Config, p: ProviderRef, text = '📱 详情') => {
  const href = detailUrl(config, p);
  return href ? [{ text, url: href }] : [];
};
const evidence = (urls: string[]) =>
  urls
    .map((u, i) => `<a href="${escape(u).replace(/"/g, '&quot;')}">证据 ${i + 1}</a>`)
    .join(' · ');

export async function notifyIncidentOpened(
  db: DB,
  config: Config,
  p: ProviderRef,
  incidentId: string,
  summary: string,
) {
  const text = `⚠️ <b>检测异常 · 尚未确认跑路</b>\n${headline(p)}\n${escape(clip(summary, 1500))}`;
  await broadcast(
    db,
    p.id,
    `incident:${incidentId}`,
    { text, reply_markup: markup([detailRow(config, p)]) },
    {
      subject: `incident:${incidentId}`,
      reply_markup: reviewKeyboard(incidentId, detailUrl(config, p)),
    },
  );
}
export async function notifyRecovery(db: DB, config: Config, p: ProviderRef, incidentId: string) {
  await clearReviewButtons(db, `incident:${incidentId}`);
  await broadcast(db, p.id, `recovery:${incidentId}`, {
    text: `✅ <b>检测恢复</b>\n${headline(p)}\n网站和订阅已通过当前检测，本次异常自动关闭。`,
    reply_markup: markup([detailRow(config, p)]),
  });
}
export async function notifyResolution(
  db: DB,
  config: Config,
  p: ProviderRef,
  incidentId: string,
  resolution: {
    action: 'dead' | 'recovered' | 'dismissed';
    reason: string;
    evidenceUrls: string[];
  },
) {
  await clearReviewButtons(db, `incident:${incidentId}`);
  const dead = resolution.action === 'dead';
  const title = dead
    ? '🪦 <b>人工核验：确认跑路</b>'
    : resolution.action === 'dismissed'
      ? '✅ <b>管理员排除本次异常</b>'
      : '✅ <b>人工核验：服务恢复</b>';
  const ceremony = startLink(config.botUsername, `c_${compactId(p.id)}`);
  await broadcast(db, p.id, `resolution:${incidentId}`, {
    text: `${title}\n${headline(p)}\n<blockquote>${escape(clip(resolution.reason, 1500))}</blockquote>\n${evidence(resolution.evidenceUrls)}`,
    reply_markup: dead
      ? markup([
          tributeRow(p.id),
          [
            ...(ceremony ? [{ text: '🕯 电子追悼会', url: ceremony }] : []),
            ...detailRow(config, p, '🌐 墓碑'),
          ],
        ])
      : markup([detailRow(config, p)]),
  });
}
export async function notifyRevival(db: DB, config: Config, p: ProviderRef, reason: string) {
  await broadcast(db, p.id, `revival:${p.id}:${Date.now()}`, {
    text: `🌱 <b>墓碑复活</b>\n${headline(p)}\n经人工核验仍在运营，已移出墓园并重新开始监测。\n<blockquote>${escape(clip(reason, 1500))}</blockquote>`,
    reply_markup: markup([detailRow(config, p)]),
  });
}
export async function notifySubmission(
  db: DB,
  config: Config,
  submission: {
    id: string;
    name: string;
    slug: string;
    hosts: string[];
    subscriptions: number;
    author: string;
  },
) {
  await notifyReviewers(db, `submission:${submission.id}`, `submission:${submission.id}`, {
    text: [
      '📮 <b>新投稿待审核</b>',
      `${escape(submission.name)} · <code>${escape(submission.slug)}</code>`,
      `官网：${escape(submission.hosts.join('、') || '—')}`,
      `订阅：${submission.subscriptions} 个（加密保存，不在消息中显示）`,
      `投稿人：${escape(submission.author)}`,
    ].join('\n'),
    reply_markup: markup([
      [
        { text: '✅ 通过', callback_data: `sb:a:${submission.id}`, style: 'success' },
        { text: '❌ 驳回', callback_data: `sb:r:${submission.id}`, style: 'danger' },
      ],
      miniAppButton(config, '🗂 打开审核台', 'review_submissions'),
    ]),
  });
}
export async function notifySubmissionResult(
  db: DB,
  config: Config,
  submission: { id: string; userId: string; name: string; approved: boolean; reason: string },
  provider?: ProviderRef,
) {
  await clearReviewButtons(db, `submission:${submission.id}`);
  const [user] = await db.query<{ telegram_id: string }>(
    'SELECT telegram_id FROM users WHERE id=$1 AND telegram_id IS NOT NULL AND NOT disabled',
    [submission.userId],
  );
  if (!user) return;
  await enqueue(
    db,
    `submission-result:${submission.id}`,
    user.telegram_id,
    html({
      text: `${submission.approved ? '✅ <b>投稿已通过</b>' : '❌ <b>投稿未通过</b>'}\n${escape(submission.name)}\n<blockquote>${escape(clip(submission.reason, 1000))}</blockquote>`,
      reply_markup: provider ? markup([detailRow(config, provider)]) : undefined,
    }),
  );
}
export async function notifyMemorial(
  db: DB,
  memorial: { id: string; body: string; provider: string; author: string },
) {
  await notifyReviewers(db, `memorial:${memorial.id}`, `memorial:${memorial.id}`, {
    text: `🕯 <b>追悼留言待审核</b>\n${escape(memorial.provider)}\n<blockquote>${escape(clip(memorial.body, 1000))}</blockquote>\n作者：${escape(memorial.author)}`,
    reply_markup: markup([
      [
        { text: '👁 公开', callback_data: `mm:v:${memorial.id}`, style: 'success' },
        { text: '🙈 隐藏', callback_data: `mm:h:${memorial.id}` },
      ],
    ]),
  });
}

export interface TelegramSender {
  send(method: string, parameters: Record<string, unknown>): Promise<unknown>;
}
export class TelegramError extends Error {
  constructor(
    public code: number,
    public retryAfter?: number,
  ) {
    super(`Telegram API error ${code}`);
  }
}
export function telegramSender(token: string): TelegramSender {
  return {
    async send(method, parameters) {
      const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parameters),
        signal: AbortSignal.timeout(20000),
      });
      const data = (await response.json()) as {
        ok: boolean;
        result?: unknown;
        error_code: number;
        parameters?: { retry_after?: number };
      };
      if (!data.ok) throw new TelegramError(data.error_code, data.parameters?.retry_after);
      return data.result;
    },
  };
}
export async function dispatchNotifications(db: DB, sender: TelegramSender, limit = 10) {
  await db.query(
    "UPDATE notifications SET status='failed',error_code='RETRIES_EXHAUSTED' WHERE attempts>=8 AND (status='pending' OR status='running' AND lease_until<now())",
  );
  const rows = await db.query<{
    id: string;
    chat_id: string;
    topic_id: number | null;
    method: string;
    payload: Record<string, unknown>;
    lease_token: string;
    attempts: number;
  }>(
    `WITH picked AS (SELECT id FROM notifications WHERE attempts<8 AND available_at<=now() AND (status='pending' OR status='running' AND lease_until<now()) ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT $1) UPDATE notifications n SET status='running',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '5 minutes' FROM picked WHERE n.id=picked.id RETURNING n.*`,
    [limit],
  );
  // Sequential delivery keeps each worker comfortably below Telegram's global rate limit.
  for (const n of rows) {
    try {
      let parameters: Record<string, unknown> = { ...n.payload, chat_id: n.chat_id };
      if (n.method === 'setMyCommands') {
        const [user] = await db.query<{ role: string; disabled: boolean }>(
          'SELECT role,disabled FROM users WHERE telegram_id=$1',
          [n.chat_id],
        );
        parameters = {
          scope: { type: 'chat', chat_id: n.chat_id },
          commands: commandsFor(user?.role, user?.disabled),
        };
      }
      const result = await sender.send(n.method, {
        ...parameters,
        ...(n.topic_id && n.method === 'sendMessage' ? { message_thread_id: n.topic_id } : {}),
      });
      const messageId =
        result && typeof result === 'object' && 'message_id' in result
          ? Number(result.message_id)
          : null;
      await db.query(
        "UPDATE notifications SET status='sent',sent_at=now(),lease_until=NULL,message_id=$3 WHERE id=$1 AND lease_token=$2",
        [n.id, n.lease_token, messageId || null],
      );
    } catch (error) {
      const permanent = error instanceof TelegramError && [400, 401, 403].includes(error.code);
      const delay =
        error instanceof TelegramError && error.retryAfter
          ? error.retryAfter
          : Math.min(3600, 2 ** n.attempts * 15);
      await db.query(
        "UPDATE notifications SET status=$1,error_code=$2,available_at=now()+$3*interval '1 second',lease_until=NULL WHERE id=$4 AND lease_token=$5",
        [
          permanent || n.attempts >= 8 ? 'failed' : 'pending',
          error instanceof TelegramError ? `TELEGRAM_${error.code}` : 'NETWORK_ERROR',
          delay,
          n.id,
          n.lease_token,
        ],
      );
    }
  }
  return rows.length;
}
