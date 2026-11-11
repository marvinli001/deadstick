import type { DB } from '../db.js';
import { AppError } from '../errors.js';
import { escape, time } from './format.js';
import { isGroupAdministrator, requireBotMembership } from './group-settings.js';
import {
  deliveryTime,
  eventLabels,
  isQuiet,
  matchesPolicy,
  policyWithDefaults,
  type EventType,
  type NotificationPolicy,
} from './notification-policy.js';
import { TelegramError, type TelegramSender } from './notifications.js';
import { sendCard } from './widgets.js';

export interface NotificationEvent {
  providerId?: string;
  incidentId?: string;
  type?: EventType;
  summary?: string;
  manual?: boolean;
  evidenceUrls?: string[];
  test?: boolean;
}
interface EventRow {
  id: string;
  chat_id: string;
  audience: string;
  topic_id: number | null;
  method: string;
  payload: Record<string, unknown>;
  event_meta: NotificationEvent;
  created_at: Date;
  attempts: number;
}
export function eventTitle(event: NotificationEvent) {
  return event.type === 'recovery' && event.manual ? '服务恢复' : eventLabels[event.type!];
}
export async function dispatchPolicyNotifications(db: DB, sender: TelegramSender, limit: number) {
  const recipients = await db.query<{ chat_id: string; audience: string }>(
    `SELECT chat_id,audience FROM notifications WHERE event_meta IS NOT NULL AND attempts<8 AND available_at<=now()
      AND (status='pending' OR status='running' AND lease_until<now())
      GROUP BY chat_id,audience ORDER BY min(available_at) LIMIT $1`,
    [limit],
  );
  let delivered = 0;
  for (const recipient of recipients)
    await db.transaction(async (tx) => {
      // Hold the recipient lock through delivery so several workers cannot split a digest or bypass its frequency limit.
      const [lock] = await tx.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_xact_lock(hashtextextended($1,7)) AS locked',
        [recipient.chat_id],
      );
      if (!lock!.locked) return;
      const [cooldown] = await tx.query<{ until: Date | null }>(
        `SELECT max(available_at) AS until FROM notifications WHERE chat_id=$1
          AND status IN ('pending','failed') AND error_code IN ('TELEGRAM_429','RETRIES_EXHAUSTED')
          AND available_at>now()`,
        [recipient.chat_id],
      );
      if (cooldown!.until) {
        await tx.query(
          `UPDATE notifications SET available_at=GREATEST(available_at,$2) WHERE chat_id=$1
            AND event_meta IS NOT NULL AND status='pending' AND available_at<$2`,
          [recipient.chat_id, cooldown!.until],
        );
        return;
      }
      const rows = await tx.query<EventRow>(
        `SELECT * FROM notifications WHERE chat_id=$1 AND audience=$2 AND event_meta IS NOT NULL
      AND attempts<8 AND (available_at<=now() OR attempts=0) AND (status='pending' OR status='running' AND lease_until<now())
      ORDER BY created_at,id FOR UPDATE`,
        [recipient.chat_id, recipient.audience],
      );
      if (!rows.length) return;
      let policy: NotificationPolicy,
        topic: number | null = null;
      const cancel = async (ids: string[], code: string) => {
        if (ids.length)
          await tx.query(
            "UPDATE notifications SET status='failed',error_code=$2,lease_until=NULL WHERE id=ANY($1::uuid[])",
            [ids, code],
          );
      };
      try {
        if (recipient.audience === 'group') {
          const [chat] = await tx.query<{
            enabled: boolean;
            approval_status: string;
            bot_can_send: boolean;
            topic_id: number | null;
            notification_policy: Partial<NotificationPolicy>;
            manager_telegram_id: string | null;
          }>("SELECT * FROM telegram_chats WHERE id=$1 AND kind='group' FOR UPDATE", [
            recipient.chat_id,
          ]);
          if (!chat?.enabled || chat.approval_status !== 'approved' || !chat.bot_can_send)
            return cancel(
              rows.map((r) => r.id),
              'RECIPIENT_REVOKED',
            );
          await requireBotMembership(sender, recipient.chat_id);
          if (chat.manager_telegram_id) {
            if (!(await isGroupAdministrator(sender, recipient.chat_id, chat.manager_telegram_id)))
              return cancel(
                rows.map((r) => r.id),
                'GROUP_ADMIN_REVOKED',
              );
          }
          policy = policyWithDefaults(chat.notification_policy);
          topic = chat.topic_id;
        } else {
          const [user] = await tx.query<{ id: string; policy: Partial<NotificationPolicy> | null }>(
            'SELECT u.id,p.policy FROM users u LEFT JOIN notification_preferences p ON p.user_id=u.id WHERE u.telegram_id=$1 AND NOT u.disabled',
            [recipient.chat_id],
          );
          if (!user)
            return cancel(
              rows.map((r) => r.id),
              'RECIPIENT_REVOKED',
            );
          policy = policyWithDefaults(user.policy, true);
        }
        const [last] = await tx.query<{ sent_at: Date }>(
          "SELECT max(sent_at) AS sent_at FROM notifications WHERE chat_id=$1 AND event_meta IS NOT NULL AND NOT (event_meta ? 'test') AND status='sent'",
          [recipient.chat_id],
        );
        const eligible: Array<EventRow & { name: string; slug: string; due: Date }> = [];
        for (const row of rows) {
          if (row.event_meta.test) {
            eligible.push({ ...row, name: '', slug: '', due: new Date(0) });
            continue;
          }
          const [provider] = await tx.query<{
            id: string;
            name: string;
            slug: string;
            tags: string[];
            following: boolean;
          }>(
            `SELECT p.id,p.name,p.slug,p.tags,EXISTS(SELECT 1 FROM follows f JOIN users u ON u.id=f.user_id WHERE f.provider_id=p.id AND u.telegram_id=$2) AS following FROM providers p WHERE p.id=$1`,
            [row.event_meta.providerId, recipient.chat_id],
          );
          if (
            !provider ||
            (recipient.audience === 'follower' && !provider.following) ||
            !matchesPolicy(policy, row.event_meta.type!, provider, row.event_meta.manual)
          ) {
            await cancel([row.id], 'RULE_CHANGED');
            continue;
          }
          let due = deliveryTime(policy, row.created_at, last?.sent_at);
          if (isQuiet(policy, new Date()))
            due = deliveryTime(
              { ...policy, mode: 'realtime', mergeSeconds: 0 },
              new Date(),
              last?.sent_at,
            );
          if (due.getTime() > Date.now()) {
            await tx.query(
              "UPDATE notifications SET status='pending',available_at=$2,lease_until=NULL WHERE id=$1",
              [row.id, due],
            );
          }
          eligible.push({ ...row, name: provider.name, slug: provider.slug, due });
        }
        if (!eligible.some((row) => row.due.getTime() <= Date.now())) return;
        const due = eligible.filter((row) => row.due.getTime() <= Date.now());
        const coalesce =
          policy.mode === 'digest' || policy.mergeSeconds > 0 || policy.minIntervalSeconds > 0;
        const ready = policy.mode === 'realtime' && coalesce ? eligible : due;
        // Test messages never combine with real events.
        const firstReady = due[0]!;
        const batch = firstReady.event_meta.test
          ? [firstReady]
          : coalesce
            ? ready.filter((r) => !r.event_meta.test)
            : [firstReady];
        const ids = batch.map((r) => r.id);
        await tx.query(
          "UPDATE notifications SET status='running',attempts=attempts+1,lease_until=now()+interval '5 minutes' WHERE id=ANY($1::uuid[])",
          [ids],
        );
        const first = batch[0]!;
        let method = first.method;
        let payload: Record<string, unknown> = { ...first.payload };
        if (batch.length > 1) {
          method = 'sendMessage';
          const counts = new Map<string, number>();
          for (const row of batch) {
            const title = eventTitle(row.event_meta);
            counts.set(title, (counts.get(title) ?? 0) + 1);
          }
          payload = {
            text: `<b>机场动态 · ${batch.length} 条</b>\n${[...counts].map(([title, count]) => `${title} ${count}`).join(' · ')}\n\n${batch
              .slice(0, 8)
              .map(
                (r) =>
                  `<b>${eventTitle(r.event_meta)}</b>\n${escape(r.name)} · <code>${escape(r.slug)}</code>${r.event_meta.evidenceUrls?.length ? `\n相关资料 ${r.event_meta.evidenceUrls.length} 项` : ''}\n${time(r.created_at)}`,
              )
              .join('\n\n')}${batch.length > 8 ? `\n\n另有 ${batch.length - 8} 条` : ''}`,
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
          };
          const links = new Map<string, { text: string; url: string }>();
          for (const row of batch.slice(0, 8)) {
            const buttons =
              (
                row.payload.reply_markup as
                  { inline_keyboard?: Array<Array<{ url?: string }>> } | undefined
              )?.inline_keyboard?.flat() ?? [];
            const detail = buttons.filter((b) => b.url).at(-1);
            if (detail?.url)
              links.set(detail.url, { text: row.name.slice(0, 60), url: detail.url });
          }
          if (links.size)
            payload.reply_markup = { inline_keyboard: [...links.values()].map((link) => [link]) };
        }
        const incident = first.event_meta.incidentId;
        if (batch.length === 1 && incident && first.event_meta.type !== 'anomaly') {
          const [original] = await tx.query<{ message_id: string }>(
            `SELECT message_id FROM notifications WHERE chat_id=$1 AND status='sent' AND message_id IS NOT NULL
          AND event_meta->>'incidentId'=$2 AND topic_id IS NOT DISTINCT FROM $3 ORDER BY sent_at LIMIT 1`,
            [recipient.chat_id, incident, topic],
          );
          if (original)
            payload.reply_parameters = {
              message_id: Number(original.message_id),
              allow_sending_without_reply: true,
            };
        }
        let result: unknown;
        try {
          const send = () =>
            sendCard(tx, sender, method, {
              ...payload,
              chat_id: recipient.chat_id,
              ...(topic ? { message_thread_id: topic } : {}),
            });
          try {
            result = await send();
          } catch (error) {
            if (
              !(error instanceof TelegramError) ||
              error.code !== 400 ||
              !payload.reply_parameters
            )
              throw error;
            delete payload.reply_parameters;
            result = await send();
          }
          const messageId =
            result && typeof result === 'object' && 'message_id' in result
              ? Number(result.message_id)
              : null;
          await tx.query(
            "UPDATE notifications SET status='sent',sent_at=now(),lease_until=NULL,message_id=$2,topic_id=$3 WHERE id=ANY($1::uuid[])",
            [ids, messageId || null, topic],
          );
          delivered += batch.length;
        } catch (error) {
          const permanent = error instanceof TelegramError && [400, 401, 403].includes(error.code);
          const delay =
            error instanceof TelegramError && error.retryAfter
              ? error.retryAfter
              : Math.min(3600, 2 ** (first.attempts + 1) * 15);
          await tx.query(
            "UPDATE notifications SET status=$2,error_code=$3,available_at=now()+$4*interval '1 second',lease_until=NULL WHERE id=ANY($1::uuid[])",
            [
              ids,
              permanent || first.attempts + 1 >= 8 ? 'failed' : 'pending',
              error instanceof TelegramError ? `TELEGRAM_${error.code}` : 'NETWORK_ERROR',
              delay,
            ],
          );
          if (
            error instanceof TelegramError &&
            error.code === 403 &&
            recipient.audience === 'group'
          )
            await tx.query("UPDATE telegram_chats SET enabled=false WHERE id=$1 AND kind='group'", [
              recipient.chat_id,
            ]);
        }
      } catch (error) {
        if (
          (error instanceof AppError && ['BOT_NOT_MEMBER', 'GROUP_ADMIN'].includes(error.code)) ||
          (error instanceof TelegramError && [400, 403].includes(error.code))
        ) {
          await cancel(
            rows.map((r) => r.id),
            'RECIPIENT_REVOKED',
          );
          if (recipient.audience === 'group')
            await tx.query('UPDATE telegram_chats SET enabled=false WHERE id=$1', [
              recipient.chat_id,
            ]);
        } else {
          const delay = error instanceof TelegramError && error.retryAfter ? error.retryAfter : 60;
          await tx.query(
            "UPDATE notifications SET status='pending',attempts=attempts+1,available_at=now()+$2*interval '1 second',lease_until=NULL,error_code=$3 WHERE id=ANY($1::uuid[])",
            [
              rows.map((r) => r.id),
              delay,
              error instanceof TelegramError && error.code === 429
                ? 'TELEGRAM_429'
                : 'PERMISSION_CHECK_FAILED',
            ],
          );
        }
      }
    });
  return delivered;
}
