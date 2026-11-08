import type { DB } from '../db.js';
import type { Config } from '../config.js';
import type { InlineKeyboardMarkup } from 'grammy/types';
import { commandsFor } from './commands.js';
import { dispatchPolicyNotifications, type NotificationEvent } from './policy-delivery.js';
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
  time,
} from './format.js';

type Audience = 'public' | 'group' | 'follower' | 'reviewer' | 'admin';

export async function enqueue(
  db: DB,
  key: string,
  chatId: string,
  payload: object,
  topicId: number | null = null,
  options: {
    method?: string;
    subject?: string;
    audience?: Audience;
    event?: NotificationEvent;
  } = {},
) {
  await db.query(
    'INSERT INTO notifications(dedupe_key,chat_id,topic_id,payload,method,subject,audience,event_meta) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING',
    [
      key,
      chatId,
      topicId,
      JSON.stringify(payload),
      options.method ?? 'sendMessage',
      options.subject ?? null,
      options.audience ?? 'public',
      options.event ? JSON.stringify(options.event) : null,
    ],
  );
}
interface Outgoing {
  text: string;
  rich?: string;
  reply_markup?: InlineKeyboardMarkup;
}
const html = (message: Outgoing) => ({
  ...(message.rich
    ? { rich_message: { html: message.rich, skip_entity_detection: true } }
    : {
        text: message.text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      }),
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
  event: NotificationEvent,
  review?: { subject: string; reply_markup: InlineKeyboardMarkup; message?: Outgoing },
) {
  const chats = await db.query<{ id: string; topic_id: number | null; kind: string }>(
    "SELECT c.id,c.topic_id,c.kind FROM telegram_chats c WHERE c.enabled AND (c.kind='group' AND c.approval_status='approved' AND c.bot_can_send OR c.kind='admin' AND EXISTS(SELECT 1 FROM users u WHERE u.telegram_id=c.id AND u.role IN ('admin','moderator') AND NOT u.disabled))",
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
    const outgoing = reviewer ? (review.message ?? message) : message;
    await enqueue(
      db,
      `${key}:${chat.id}`,
      chat.id,
      html(reviewer ? { ...outgoing, reply_markup: review.reply_markup } : outgoing),
      chat.topic_id,
      {
        subject: reviewer ? review.subject : undefined,
        method: outgoing.rich ? 'sendRichMessage' : 'sendMessage',
        audience: chat.kind === 'admin' ? 'reviewer' : (chat.kind as Audience),
        event: chat.kind === 'admin' ? undefined : { ...event, providerId },
      },
    );
  }
}
async function notifyReviewers(db: DB, key: string, subject: string, message: Outgoing) {
  for (const chat of await reviewerChats(db))
    await enqueue(db, `${key}:${chat.id}`, chat.id, html(message), null, {
      subject,
      method: message.rich ? 'sendRichMessage' : 'sendMessage',
      audience: 'reviewer',
    });
}
/** Chat binding is an administrator action, so these alerts skip moderators. */
export async function notifyAdmins(db: DB, key: string, message: Outgoing) {
  const chats = await db.query<{ id: string }>(
    "SELECT c.id FROM telegram_chats c JOIN users u ON u.telegram_id=c.id WHERE c.kind='admin' AND c.enabled AND u.role='admin' AND NOT u.disabled",
  );
  for (const chat of chats)
    await enqueue(db, `${key}:${chat.id}`, chat.id, html(message), null, {
      method: message.rich ? 'sendRichMessage' : 'sendMessage',
      audience: 'admin',
    });
}
/** Removes the action buttons from review messages that were already delivered. */
export async function clearReviewButtons(db: DB, subject: string) {
  await db.query(
    "UPDATE notifications SET payload=payload-'reply_markup' WHERE subject=$1 AND status='pending' AND method IN ('sendMessage','sendRichMessage')",
    [subject],
  );
  const sent = await db.query<{ chat_id: string; message_id: string }>(
    "SELECT chat_id,message_id FROM notifications WHERE subject=$1 AND status='sent' AND message_id IS NOT NULL AND method IN ('sendMessage','sendRichMessage')",
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
const noticeRich = (title: string, p: ProviderRef, body: string) =>
  `<h2>${title}</h2><p>${headline(p)}</p>${body}<footer>Deadstick · ${time(new Date())}</footer>`;
const detailUrl = (config: Config, p: ProviderRef) =>
  miniAppLink(config, `p_${compactId(p.id)}`) ??
  startLink(config.botUsername, `p_${compactId(p.id)}`);
const detailRow = (config: Config, p: ProviderRef, text = '📱 详情') => {
  const href = detailUrl(config, p);
  return href ? [{ text, url: href }] : [];
};
const evidence = (urls: string[]) =>
  urls
    .map((u, i) => `<a href="${escape(u).replace(/"/g, '&quot;')}">资料 ${i + 1}</a>`)
    .join(' · ');

export async function notifyIncidentOpened(
  db: DB,
  config: Config,
  p: ProviderRef,
  incidentId: string,
  summary: string,
) {
  await broadcast(
    db,
    p.id,
    `incident:${incidentId}`,
    {
      text: `⚠️ <b>检测异常</b>\n${headline(p)}\n待核验`,
      rich: noticeRich('⚠️ 检测异常', p, '<p>待核验</p>'),
      reply_markup: markup([detailRow(config, p)]),
    },
    { type: 'anomaly', incidentId },
    {
      subject: `incident:${incidentId}`,
      reply_markup: reviewKeyboard(incidentId, miniAppLink(config, `i_${compactId(incidentId)}`)),
      message: {
        text: `⚠️ <b>检测异常</b>\n${headline(p)}\n${escape(clip(summary, 1500))}`,
        rich: noticeRich(
          '⚠️ 检测异常',
          p,
          `<details open><summary>异常记录</summary><p>${escape(clip(summary, 1500))}</p></details>`,
        ),
      },
    },
  );
}
export async function notifyRecovery(db: DB, config: Config, p: ProviderRef, incidentId: string) {
  await clearReviewButtons(db, `incident:${incidentId}`);
  await broadcast(
    db,
    p.id,
    `recovery:${incidentId}`,
    {
      text: `✅ <b>检测恢复</b>\n${headline(p)}`,
      rich: noticeRich('✅ 检测恢复', p, ''),
      reply_markup: markup([detailRow(config, p)]),
    },
    { type: 'recovery', incidentId },
  );
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
    ? '🪦 <b>已跑路</b>'
    : resolution.action === 'dismissed'
      ? '✅ <b>异常解除</b>'
      : '✅ <b>服务恢复</b>';
  const ceremony = startLink(config.botUsername, `c_${compactId(p.id)}`);
  await broadcast(
    db,
    p.id,
    `resolution:${incidentId}`,
    {
      text: `${title}\n${headline(p)}\n${evidence(resolution.evidenceUrls)}`,
      rich: noticeRich(
        title.replace(/<[^>]+>/g, ''),
        p,
        `<details><summary>相关资料 · ${resolution.evidenceUrls.length} 项</summary><ul>${resolution.evidenceUrls.map((u, i) => `<li><a href="${escape(u)}">资料 ${i + 1}</a></li>`).join('')}</ul></details>`,
      ),
      reply_markup: dead
        ? markup([
            tributeRow(p.id),
            [
              ...(ceremony ? [{ text: '🕯 电子追悼会', url: ceremony }] : []),
              ...detailRow(config, p, '🌐 墓碑'),
            ],
          ])
        : markup([detailRow(config, p)]),
    },
    {
      type: dead ? 'dead' : resolution.action === 'dismissed' ? 'dismissed' : 'recovery',
      incidentId,
      evidenceUrls: resolution.evidenceUrls,
      manual: true,
    },
  );
}
export async function notifyRevival(db: DB, config: Config, p: ProviderRef) {
  await broadcast(
    db,
    p.id,
    `revival:${p.id}:${Date.now()}`,
    {
      text: `🌱 <b>恢复运营</b>\n${headline(p)}`,
      rich: noticeRich('🌱 恢复运营', p, ''),
      reply_markup: markup([detailRow(config, p)]),
    },
    { type: 'revival', manual: true },
  );
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
    revision?: number;
    kind?: string;
  },
) {
  await notifyReviewers(
    db,
    `submission:${submission.id}:${submission.revision ?? 1}`,
    `submission:${submission.id}`,
    {
      rich: `<h2>📮 新投稿待审核</h2><p><b>${escape(submission.name)}</b> · <code>${escape(submission.slug)}</code></p><table bordered compact><tr><th>官网</th><td>${escape(clip(submission.hosts.join('、') || '—', 1500))}</td></tr><tr><th>订阅</th><td>${submission.subscriptions} 个 · 加密保存</td></tr><tr><th>投稿人</th><td>${escape(submission.author)}</td></tr></table>`,
      text: [
        submission.kind ? '<b>新线索待审核</b>' : '<b>新投稿待审核</b>',
        `${escape(submission.name)} · <code>${escape(submission.slug)}</code>`,
        `官网：${escape(submission.hosts.join('、') || '—')}`,
        `订阅：${submission.subscriptions} 个（加密保存，不在消息中显示）`,
        `投稿人：${escape(submission.author)}`,
      ].join('\n'),
      reply_markup: markup([
        ...(submission.kind
          ? []
          : [
              [
                {
                  text: '✅ 通过',
                  callback_data: `sb:a:${submission.id}:${submission.revision ?? 1}`,
                  style: 'success' as const,
                },
                {
                  text: '❌ 驳回',
                  callback_data: `sb:r:${submission.id}:${submission.revision ?? 1}`,
                  style: 'danger' as const,
                },
              ],
            ]),
        miniAppButton(config, '🗂 打开审核台', `s_${compactId(submission.id)}`),
      ]),
    },
  );
}
export async function notifySubmissionResult(
  db: DB,
  config: Config,
  submission: {
    id: string;
    userId: string;
    name: string;
    approved: boolean;
    reason: string;
    status?: string;
    revision?: number;
  },
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
    `submission-result:${submission.id}:${submission.revision ?? 1}:${submission.status ?? (submission.approved ? 'approved' : 'rejected')}`,
    user.telegram_id,
    html({
      text: `${submission.status === 'needs_info' ? '<b>投稿待补充</b>' : submission.approved ? '<b>投稿已通过</b>' : '<b>投稿未通过</b>'}\n${escape(submission.name)}\n<blockquote>${escape(clip(submission.reason, 1000))}</blockquote>`,
      rich: `<h2>${submission.status === 'needs_info' ? '投稿待补充' : submission.approved ? '投稿已通过' : '投稿未通过'}</h2><p>${escape(submission.name)}</p><blockquote>${escape(clip(submission.reason, 1000))}</blockquote>`,
      reply_markup:
        submission.status === 'needs_info'
          ? markup([miniAppButton(config, '补交资料', 'submissions', true)])
          : provider
            ? markup([detailRow(config, provider)])
            : undefined,
    }),
    null,
    { method: 'sendRichMessage', audience: 'follower' },
  );
}
export async function notifyMemorial(
  db: DB,
  memorial: { id: string; body: string; provider: string; author: string },
) {
  await notifyReviewers(db, `memorial:${memorial.id}`, `memorial:${memorial.id}`, {
    text: `🕯 <b>追悼留言待审核</b>\n${escape(memorial.provider)}\n<blockquote>${escape(clip(memorial.body, 1000))}</blockquote>\n作者：${escape(memorial.author)}`,
    rich: `<h2>🕯 追悼留言待审核</h2><p>${escape(memorial.provider)}</p><blockquote expandable>${escape(clip(memorial.body, 1000))}</blockquote><footer>作者：${escape(memorial.author)}</footer>`,
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
  const policyCount = await dispatchPolicyNotifications(db, sender, limit);
  const rows = await db.query<{
    id: string;
    chat_id: string;
    topic_id: number | null;
    method: string;
    payload: Record<string, unknown>;
    lease_token: string;
    attempts: number;
    audience: Audience;
    subject: string | null;
  }>(
    `WITH picked AS (SELECT id FROM notifications WHERE event_meta IS NULL AND attempts<8 AND available_at<=now() AND (status='pending' OR status='running' AND lease_until<now()) ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT $1) UPDATE notifications n SET status='running',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '5 minutes' FROM picked WHERE n.id=picked.id RETURNING n.*`,
    [limit],
  );
  // Sequential delivery keeps each worker comfortably below Telegram's global rate limit.
  for (const n of rows) {
    try {
      if (n.audience !== 'public') {
        const [recipient] = await db.query<{ allowed: boolean }>(
          `SELECT CASE WHEN $2='group' THEN EXISTS(SELECT 1 FROM telegram_chats WHERE id=$1 AND kind='group' AND enabled AND approval_status='approved' AND bot_can_send AND notification_policy->>'enabled'='true')
           ELSE EXISTS(SELECT 1 FROM users u WHERE u.telegram_id=$1 AND NOT u.disabled AND
             ($2='follower' OR u.role=ANY(CASE WHEN $2='admin' THEN ARRAY['admin'] ELSE ARRAY['admin','moderator'] END)
              AND EXISTS(SELECT 1 FROM telegram_chats c WHERE c.id=$1 AND c.kind='admin' AND c.enabled))) END AS allowed`,
          [n.chat_id, n.audience],
        );
        if (!recipient!.allowed) {
          await db.query(
            "UPDATE notifications SET status='failed',error_code='RECIPIENT_REVOKED',lease_until=NULL WHERE id=$1 AND lease_token=$2",
            [n.id, n.lease_token],
          );
          continue;
        }
      }
      let parameters: Record<string, unknown> = { ...n.payload, chat_id: n.chat_id };
      if (n.subject && ['sendMessage', 'sendRichMessage'].includes(n.method)) {
        const [kind, id] = n.subject.split(':');
        const [open] = await db.query<{ pending: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM incidents WHERE $1='incident' AND id=$2 AND status='open')
            OR EXISTS(SELECT 1 FROM submissions WHERE $1='submission' AND id=$2 AND status='pending')
            OR EXISTS(SELECT 1 FROM memorials WHERE $1='memorial' AND id=$2 AND status='pending') AS pending`,
          [kind, id],
        );
        if (!open!.pending) delete parameters.reply_markup;
      }
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
        ...(n.topic_id && ['sendMessage', 'sendRichMessage'].includes(n.method)
          ? { message_thread_id: n.topic_id }
          : {}),
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
  return rows.length + policyCount;
}
