import type { DB } from '../db.js';
import type { Config } from '../config.js';

export async function enqueue(
  db: DB,
  key: string,
  chatId: string,
  payload: object,
  topicId: number | null = null,
) {
  await db.query(
    'INSERT INTO notifications(dedupe_key,chat_id,topic_id,payload) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
    [key, chatId, topicId, JSON.stringify(payload)],
  );
}
export async function broadcast(
  db: DB,
  _config: Config,
  providerId: string,
  key: string,
  text: string,
  incidentId?: string,
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
    const reply_markup =
      incidentId && chat.kind === 'admin'
        ? { inline_keyboard: [[{ text: '二次核验', callback_data: `review:${incidentId}` }]] }
        : undefined;
    await enqueue(
      db,
      `${key}:${chat.id}`,
      chat.id,
      { text, reply_markup, link_preview_options: { is_disabled: true } },
      chat.topic_id,
    );
  }
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
      await sender.send('sendMessage', {
        ...n.payload,
        chat_id: n.chat_id,
        ...(n.topic_id ? { message_thread_id: n.topic_id } : {}),
      });
      await db.query(
        "UPDATE notifications SET status='sent',sent_at=now(),lease_until=NULL WHERE id=$1 AND lease_token=$2",
        [n.id, n.lease_token],
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
