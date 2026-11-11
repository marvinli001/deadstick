import { randomBytes } from 'node:crypto';
import { GrammyError, type Context } from 'grammy';
import type { Chat, Update, User } from 'grammy/types';
import type { DB } from '../db.js';
import { TelegramError, type TelegramSender } from './notifications.js';
import { escape } from './format.js';
import {
  widgetDocument,
  widgetHtml,
  widgetPages,
  widgetState,
  type CardMessage,
  type WidgetDocument,
} from './widget-card.js';

// grammY 1.46 types predate Bot API 10.4; keep the new wire fields at this boundary.
interface WidgetQuery {
  id: string;
  from: User;
  chat?: Chat;
  message_id?: number;
  chat_instance: string;
  type: { type: string };
  data: string;
}
type WidgetUpdate = Update & { widget_query?: WidgetQuery; shared_widget_query?: WidgetQuery };
interface WidgetRow {
  id: string;
  chat_id: string;
  message_id: string;
  revision: string;
  document: WidgetDocument;
}
const nonce = () => randomBytes(6).toString('hex');
const current = new WeakMap<Context, WidgetRow>();
const answered = new WeakSet<Context>();
export const widgetQuery = (ctx: Context) => (ctx.update as WidgetUpdate).widget_query;
export const isWidget = (ctx: Context) => current.has(ctx);

export function contextSender(ctx: Context): TelegramSender {
  return {
    send: (method, parameters) =>
      (ctx.api.raw as unknown as Record<string, (p: Record<string, unknown>) => Promise<unknown>>)[
        method
      ]!(parameters),
  };
}

export async function sendCard(
  db: DB,
  sender: TelegramSender,
  method: string,
  parameters: Record<string, unknown>,
  subject?: string | null,
  requiredRole?: 'reviewer' | 'admin',
) {
  if (method === 'editMessageWidgetData') {
    const { widget_record_id, ...wire } = parameters;
    if (widget_record_id) {
      const [row] = await db.query<WidgetRow>(
        'SELECT * FROM telegram_widgets WHERE id=$1 AND chat_id=$2 AND message_id=$3',
        [widget_record_id, String(wire.chat_id), wire.message_id],
      );
      if (!row) return true;
      wire.chat_data = widgetState(row.document, row.revision);
    }
    return updateWidgetData(sender, wire);
  }
  const chatId = String(parameters.chat_id);
  const keyboard = parameters.reply_markup as { force_reply?: boolean } | undefined;
  if (
    !['sendMessage', 'sendRichMessage'].includes(method) ||
    !/^[1-9]\d*$/.test(chatId) ||
    keyboard?.force_reply ||
    parameters.ephemeral_message_parameters
  )
    return sender.send(method, parameters);
  const rich = parameters.rich_message as { html?: string } | undefined;
  const document = widgetDocument({
    text: String(parameters.text ?? ''),
    rich: rich?.html,
    markup: parameters.reply_markup as CardMessage['markup'],
  });
  document.requiredRole = requiredRole ?? document.requiredRole;
  document.threadId = parameters.message_thread_id as number | undefined;
  const id = nonce(),
    revision = nonce();
  await db.query(
    'INSERT INTO telegram_widgets(id,chat_id,revision,document,subject) VALUES ($1,$2,$3,$4,$5)',
    [id, chatId, revision, document, subject ?? null],
  );
  const {
    text: _text,
    rich_message: _rich,
    parse_mode: _mode,
    link_preview_options: _preview,
    entities: _entities,
    reply_markup: _markup,
    ...extra
  } = parameters;
  try {
    const result = (await sender.send('sendWidget', {
      ...extra,
      html: widgetHtml(id),
      chat_data: widgetState(document, revision),
      caption: document.caption,
      allow_queries: true,
      ...(document.keyboard.inline_keyboard.length ? { reply_markup: document.keyboard } : {}),
    })) as { message_id: number };
    await db.query('UPDATE telegram_widgets SET message_id=$2 WHERE id=$1', [
      id,
      result.message_id,
    ]);
    return result;
  } catch (error) {
    await db.query('DELETE FROM telegram_widgets WHERE id=$1', [id]);
    throw error;
  }
}

async function answerQuery(sender: TelegramSender, id: string, text = '') {
  const characters = Array.from(text);
  while (Buffer.byteLength(characters.join('')) > 1024) characters.pop();
  try {
    await sender.send('answerWidgetQuery', { widget_query_id: id, data: characters.join('') });
  } catch (error) {
    if (
      !(error instanceof GrammyError && error.error_code === 400) &&
      !(error instanceof TelegramError && error.code === 400)
    )
      throw error;
  }
}
export async function answerWidget(ctx: Context, text = '') {
  if (answered.has(ctx)) return;
  await answerQuery(contextSender(ctx), widgetQuery(ctx)!.id, text);
  answered.add(ctx);
}

export async function updateWidgetData(
  sender: TelegramSender,
  parameters: Record<string, unknown>,
) {
  try {
    return await sender.send('editMessageWidgetData', parameters);
  } catch (error) {
    if (
      (error instanceof GrammyError &&
        error.error_code === 400 &&
        error.description.includes('not modified')) ||
      (error instanceof TelegramError && error.notModified)
    )
      return true;
    throw error;
  }
}

export async function editWidget(
  db: DB,
  sender: TelegramSender,
  row: WidgetRow,
  document: WidgetDocument,
  page = 0,
) {
  document.threadId = row.document.threadId;
  const revision = nonce();
  await updateWidgetData(sender, {
    chat_id: row.chat_id,
    message_id: Number(row.message_id),
    chat_data: widgetState(document, revision, page),
  });
  await db.query(
    'UPDATE telegram_widgets SET document=$2,revision=$3,updated_at=now() WHERE id=$1',
    [row.id, document, revision],
  );
  if (
    row.document.caption !== document.caption ||
    JSON.stringify(row.document.keyboard) !== JSON.stringify(document.keyboard)
  )
    await sender.send('editMessageCaption', {
      chat_id: row.chat_id,
      message_id: Number(row.message_id),
      caption: document.caption,
      reply_markup: document.keyboard,
    });
  row.document = document;
  row.revision = revision;
}

export async function showWidget(db: DB, ctx: Context, message: CardMessage, notice?: string) {
  await editWidget(db, contextSender(ctx), current.get(ctx)!, widgetDocument(message));
  await answerWidget(ctx, notice);
}
export async function finishWidget(db: DB, ctx: Context, label: string) {
  const row = current.get(ctx)!;
  await editWidget(db, contextSender(ctx), row, {
    ...row.document,
    buttons: [],
    keyboard: { inline_keyboard: [] },
    blocks: [...row.document.blocks, `<p>${escape(label)}</p>`],
  });
}

export async function clearWidgetActions(db: DB, subject: string) {
  const rows = await db.query<WidgetRow>('SELECT * FROM telegram_widgets WHERE subject=$1', [
    subject,
  ]);
  for (const row of rows) {
    const document = { ...row.document, buttons: [] };
    const revision = nonce();
    await db.query(
      'UPDATE telegram_widgets SET document=$2,revision=$3,updated_at=now() WHERE id=$1',
      [row.id, document, revision],
    );
    if (row.message_id)
      await db.query(
        `INSERT INTO notifications(dedupe_key,chat_id,payload,method) VALUES ($1,$2,$3,'editMessageWidgetData') ON CONFLICT DO NOTHING`,
        [
          `widget-clear:${row.id}:${revision}`,
          row.chat_id,
          { message_id: Number(row.message_id), widget_record_id: row.id },
        ],
      );
  }
}

export async function routeWidget(db: DB, ctx: Context, next: () => Promise<void>) {
  const update = ctx.update as WidgetUpdate;
  const query = update.widget_query ?? update.shared_widget_query;
  if (!query) return next();
  const send = contextSender(ctx);
  const reject = (data: string) => answerQuery(send, query.id, data);
  if (
    update.shared_widget_query ||
    query.chat?.type !== 'private' ||
    query.chat.id !== query.from.id ||
    query.type?.type !== 'data'
  )
    return void (await reject('请在机器人私聊中打开卡片。'));
  const match = /^w:([0-9a-f]{12}):([0-9a-f]{12}):(a|p):(\d{1,4})$/.exec(query.data);
  if (!match) return void (await reject('操作无效，请重新打开卡片。'));
  const [row] = await db.query<WidgetRow>(
    'SELECT * FROM telegram_widgets WHERE id=$1 AND chat_id=$2 AND message_id=$3',
    [match[1], String(query.chat.id), query.message_id],
  );
  if (!row) return void (await reject('卡片已过期，请重新查询。'));
  current.set(ctx, row);
  const [user] = await db.query<{ disabled: boolean; role: string }>(
    'SELECT disabled,role FROM users WHERE telegram_id=$1',
    [String(query.from.id)],
  );
  if (user?.disabled) return void (await answerWidget(ctx, '账号已停用。'));
  if (
    row.document.requiredRole &&
    (!user ||
      !['admin', ...(row.document.requiredRole === 'reviewer' ? ['moderator'] : [])].includes(
        user.role,
      ))
  )
    return void (await answerWidget(ctx, '需要后台审核权限。'));
  if (row.revision !== match[2]) {
    await updateWidgetData(send, {
      chat_id: row.chat_id,
      message_id: Number(row.message_id),
      chat_data: widgetState(row.document, row.revision),
    });
    return void (await answerWidget(ctx, '卡片已更新，请重试。'));
  }
  const index = Number(match[4]);
  if (match[3] === 'p') {
    if (index >= widgetPages(row.document).length)
      return void (await answerWidget(ctx, '页码无效。'));
    await updateWidgetData(send, {
      chat_id: row.chat_id,
      message_id: Number(row.message_id),
      chat_data: widgetState(row.document, row.revision, index),
    });
    return void (await answerWidget(ctx));
  }
  const action = row.document.buttons[index];
  if (!action) return void (await answerWidget(ctx, '操作已失效，请刷新卡片。'));
  update.callback_query = {
    id: query.id,
    from: query.from,
    chat_instance: query.chat_instance,
    data: action.data,
    message: {
      message_id: query.message_id!,
      date: 1,
      chat: query.chat,
      from: ctx.me,
      text: row.document.caption,
      ...(row.document.threadId
        ? { is_topic_message: true, message_thread_id: row.document.threadId }
        : {}),
    },
  };
  try {
    await next();
  } finally {
    if (!answered.has(ctx)) await answerWidget(ctx);
  }
}
