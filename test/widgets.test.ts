import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { UserFromGetMe } from 'grammy/types';
import { database } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { loadConfig } from '../src/config.js';
import { allowedUpdates, createBot } from '../src/telegram/bot.js';
import { providerRichCard, providerKeyboard, richButtons } from '../src/telegram/format.js';
import {
  widgetDocument,
  widgetHtml,
  widgetPages,
  widgetState,
  type WidgetDocument,
} from '../src/telegram/widget-card.js';
import {
  clearReviewButtons,
  dispatchNotifications,
  enqueue,
  TelegramError,
} from '../src/telegram/notifications.js';
import { editWidget, sendCard, updateWidgetData } from '../src/telegram/widgets.js';

const config = loadConfig({
  APP_KEY: randomBytes(32).toString('base64'),
  TELEGRAM_BOT_TOKEN: '123:test-token',
  TELEGRAM_WEBHOOK_SECRET: 'widget_test_webhook_secret_1234567890',
  PUBLIC_URL: 'https://deadstick.example',
  TELEGRAM_BOT_USERNAME: 'deadstick_test_bot',
});
const botInfo = {
  id: 123,
  is_bot: true,
  first_name: 'Deadstick',
  username: 'deadstick_test_bot',
} as UserFromGetMe;
const user = { id: 42, is_bot: false, first_name: 'Tester' };
const chat = { id: 42, type: 'private' as const, first_name: 'Tester' };

describe('Bot API 10.4 widget presentation', () => {
  it('retains row headers and every value when converting vertical review tables', () => {
    const document = widgetDocument({
      text: '',
      rich: '<table><tr><th>官网</th><td>airport.example</td></tr><tr><th>订阅</th><td>2 个</td></tr><tr><th>投稿人</th><td>Tester</td></tr></table>',
    });
    expect(document.caption).toContain('官网');
    expect(document.caption).toContain('airport.example');
    expect(document.caption).toContain('订阅');
    expect(document.caption).toContain('2 个');
    expect(document.caption).toContain('投稿人');
    expect(document.caption).toContain('Tester');
  });
  it('accepts unchanged state responses while surfacing unrelated Telegram errors', async () => {
    await expect(
      updateWidgetData(
        {
          send: async () => {
            throw new TelegramError(400, undefined, true);
          },
        },
        {},
      ),
    ).resolves.toBe(true);
    await expect(
      updateWidgetData(
        {
          send: async () => {
            throw new TelegramError(400);
          },
        },
        {},
      ),
    ).rejects.toThrow('Telegram API error 400');
    const document = widgetDocument({ text: '<a href="http://example.com">资料</a>' });
    expect(document.blocks.join('')).not.toContain('href=');
    expect(JSON.stringify(document.keyboard)).toContain('http://example.com');
  });
  it('fits the native HTML limits and subscribes to pushed state without external resources', () => {
    const html = widgetHtml('123456789abc');
    expect(Buffer.byteLength(html)).toBeLessThanOrEqual(32768);
    expect(deflateSync(Buffer.from(html), { level: 9 }).length).toBeLessThanOrEqual(4096);
    expect(html).toContain("onEvent('chatDataChanged'");
    expect(html).toContain('W.request(');
    expect(html).toContain('--tg-theme-text-color');
    expect(html).toContain('prefers-reduced-motion');
    expect(html).not.toMatch(/fetch\(|<script src|@import|https?:\/\//);
    expect(allowedUpdates).toEqual(expect.arrayContaining(['widget_query', 'shared_widget_query']));
  });
  it('separates native sharing and Mini App actions from in-widget callbacks and escapes catalog data', () => {
    const p = {
      id: '12345678-1234-1234-1234-123456789012',
      name: '</script><b>机场</b>',
      slug: 'test',
      lifecycle: 'dead',
      health: 'down',
      epitaph: '内部审核说明',
      description: '公开介绍',
    };
    const keyboard = providerKeyboard(p, config, { interactive: true });
    const document = widgetDocument({
      text: '',
      rich: providerRichCard(p) + richButtons(keyboard),
    });
    expect(document.blocks.join('')).toContain('&lt;/script&gt;&lt;b&gt;机场&lt;/b&gt;');
    expect(document.blocks.join('')).not.toContain('<script>');
    expect(document.caption).not.toContain('内部审核说明');
    expect(document.buttons.some((b) => b.data === `flower:${p.id}`)).toBe(true);
    expect(document.keyboard.inline_keyboard.flat().every((b) => !('callback_data' in b))).toBe(
      true,
    );
    expect(JSON.stringify(document.keyboard)).toContain('switch_inline_query');
    expect(JSON.stringify(document.keyboard)).toContain('startapp=');
  });
  it('paginates long Chinese content and button lists within the 1024-byte state budget', () => {
    const document = widgetDocument({
      text: `<b>记录</b>\n${'测试机场与相关公开资料\\"'.repeat(500)}`,
      markup: {
        inline_keyboard: Array.from({ length: 18 }, (_, i) => [
          { text: '这是一家名字很长的机场'.repeat(6), callback_data: `p:${i}` },
        ]),
      },
    });
    expect(widgetPages(document).length).toBeGreaterThan(1);
    for (const [page] of widgetPages(document).entries()) {
      expect(Buffer.byteLength(widgetState(document, '123456789abc', page))).toBeLessThanOrEqual(
        1024,
      );
    }
    expect(Array.from(document.caption).length).toBeLessThanOrEqual(1024);
    expect(
      widgetDocument({ text: '<a href="javascript:alert(1)">链接</a>' }).blocks.join(''),
    ).not.toContain('javascript:');
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('Widget business flows with PostgreSQL', () => {
  const connection = process.env.TEST_DATABASE_URL!;
  const name = `deadstick_widgets_${randomBytes(6).toString('hex')}`;
  let root: pg.Pool, storage: ReturnType<typeof database>, bot: ReturnType<typeof createBot>;
  let providerId: string, sequence: number, messageId: number;
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const sender = {
    send: async (method: string, payload: Record<string, unknown>): Promise<unknown> => {
      calls.push({ method, payload });
      return method.startsWith('send') ? { message_id: ++messageId, date: 1, chat } : true;
    },
  };
  function instance() {
    const result = createBot(storage.db, config, botInfo);
    result.api.config.use(
      async (_previous, method, payload) =>
        ({
          ok: true,
          result: await sender.send(method, payload as Record<string, unknown>),
        }) as never,
    );
    return result;
  }
  async function command(text: string) {
    await bot.handleUpdate({
      update_id: ++sequence,
      message: {
        message_id: sequence,
        date: 1,
        from: user,
        chat,
        text,
        entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }],
      },
    });
  }
  async function card() {
    const call = calls.findLast((c) => c.method === 'sendWidget')!;
    const id = /K="([0-9a-f]{12})"/.exec(String(call.payload.html))![1];
    return (
      await storage.db.query<{
        id: string;
        revision: string;
        message_id: string;
        document: WidgetDocument;
      }>('SELECT * FROM telegram_widgets WHERE id=$1', [id])
    )[0]!;
  }
  async function tap(data: string, message: string, extra: object = {}, target = bot) {
    await target.handleUpdate({
      update_id: ++sequence,
      widget_query: {
        id: `wq${sequence}`,
        from: user,
        chat,
        message_id: Number(message),
        chat_instance: 'test',
        type: { type: 'data' },
        data,
        ...extra,
      },
    } as never);
  }
  const action = (row: Awaited<ReturnType<typeof card>>, prefix: string) =>
    `w:${row.id}:${row.revision}:a:${row.document.buttons.findIndex((b) => b.data.startsWith(prefix))}`;
  const answer = () => calls.findLast((c) => c.method === 'answerWidgetQuery')!.payload.data;

  beforeAll(async () => {
    root = new pg.Pool({ connectionString: connection });
    await root.query(`CREATE DATABASE "${name}"`);
    const url = new URL(connection);
    url.pathname = `/${name}`;
    storage = database(url.href);
    await migrate(storage.db);
  });
  afterAll(async () => {
    await storage?.close();
    if (root) {
      await root.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await root.end();
    }
  });
  beforeEach(async () => {
    await storage.db.query(
      'TRUNCATE users,providers,notifications,telegram_widgets,bot_rate_limits CASCADE',
    );
    const [p] = await storage.db.query<{ id: string }>(
      "INSERT INTO providers(name,slug,lifecycle,health,death_at) VALUES ('测试云','test-cloud','dead','down',now()) RETURNING id",
    );
    providerId = p!.id;
    sequence = 0;
    messageId = 50;
    calls.length = 0;
    bot = instance();
  });
  it('confirms follow actions in place across worker instances and rejects reused revisions', async () => {
    await command('/status test-cloud');
    let row = await card();
    expect(calls.find((c) => c.method === 'sendWidget')!.payload.caption).toContain('测试云');
    const follow = action(row, 'fo:');
    await tap(follow, row.message_id);
    expect(await storage.db.query('SELECT * FROM follows')).toHaveLength(0);
    expect(calls.some((c) => c.method === 'editMessageWidgetData')).toBe(true);
    row = await card();
    const confirm = action(row, 'cv:');
    await tap(confirm, row.message_id, {}, instance());
    expect(await storage.db.query('SELECT * FROM follows')).toHaveLength(1);
    await tap(confirm, row.message_id);
    expect(answer()).toContain('已更新');
    expect(await storage.db.query('SELECT * FROM follows')).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'sendWidget')).toHaveLength(1);
  });
  it('rejects forged actions, other users, other messages, wallet queries and disabled accounts', async () => {
    await command('/status test-cloud');
    const row = await card(),
      follow = action(row, 'fo:');
    await tap(follow, row.message_id, { from: { ...user, id: 43 } });
    expect(answer()).toContain('私聊');
    await tap(follow, '999');
    expect(answer()).toContain('过期');
    await tap(`w:${row.id}:${row.revision}:a:999`, row.message_id);
    expect(answer()).toContain('失效');
    await tap(follow, row.message_id, { type: { type: 'sign_data' } });
    expect(answer()).toContain('私聊');
    await storage.db.query("UPDATE users SET disabled=true WHERE telegram_id='42'");
    await tap(follow, row.message_id);
    expect(answer()).toContain('停用');
    expect(await storage.db.query('SELECT * FROM follows')).toHaveLength(0);
  });
  it('updates tribute totals and keeps repeated daily tributes idempotent', async () => {
    await command('/ceremony test-cloud');
    let row = await card();
    await tap(action(row, 'flower:'), row.message_id);
    expect(answer()).toContain('心意已送达');
    row = await card();
    expect(row.document.caption).toContain('1');
    await tap(action(row, 'flower:'), row.message_id);
    expect(answer()).toContain('今天已经');
    expect(await storage.db.query('SELECT * FROM tributes')).toHaveLength(1);
  });
  it('rechecks reviewer permissions when an old workbench widget is tapped', async () => {
    await command('/start');
    await storage.db.query("UPDATE users SET role='moderator' WHERE telegram_id='42'");
    await command('/admin');
    const row = await card();
    await storage.db.query("UPDATE users SET role='user' WHERE telegram_id='42'");
    const count = calls.filter((c) => c.method === 'editMessageWidgetData').length;
    await tap(action(row, 'pd'), row.message_id);
    expect(answer()).toContain('需要后台审核权限');
    expect(calls.filter((c) => c.method === 'editMessageWidgetData')).toHaveLength(count);
  });
  it('delivers private notifications as widgets, keeps group rich messages and clears sent review actions', async () => {
    await command('/start');
    await storage.db.query("UPDATE users SET role='moderator' WHERE telegram_id='42'");
    calls.length = 0;
    await enqueue(storage.db, 'private', '42', {
      text: '<b>通知</b>',
      reply_markup: { inline_keyboard: [[{ text: '审核', callback_data: 'pd' }]] },
    });
    await enqueue(
      storage.db,
      'group',
      '-100123',
      { rich_message: { html: '<h2>群通报</h2>' } },
      12,
      { method: 'sendRichMessage' },
    );
    await dispatchNotifications(storage.db, sender);
    expect(calls.some((c) => c.method === 'sendWidget' && c.payload.chat_id === '42')).toBe(true);
    expect(
      calls.some((c) => c.method === 'sendRichMessage' && c.payload.message_thread_id === 12),
    ).toBe(true);
    await sendCard(
      storage.db,
      sender,
      'sendMessage',
      {
        chat_id: '42',
        text: '待审核',
        reply_markup: { inline_keyboard: [[{ text: '审核', callback_data: 'pd' }]] },
      },
      `incident:${providerId}`,
    );
    const row = await card();
    await clearReviewButtons(storage.db, `incident:${providerId}`);
    await dispatchNotifications(storage.db, sender);
    expect((await card()).document.buttons).toHaveLength(0);
    await tap(action(row, 'pd'), row.message_id);
    expect(answer()).toContain('已更新');
  });
  it('paginates long cards without exposing arbitrary callback data or changing the message', async () => {
    await sendCard(storage.db, sender, 'sendMessage', {
      chat_id: '42',
      text: '公开记录'.repeat(400),
    });
    const row = await card();
    await tap(`w:${row.id}:${row.revision}:p:1`, row.message_id);
    const state = calls.findLast((c) => c.method === 'editMessageWidgetData')!.payload.chat_data;
    expect(JSON.parse(String(state)).p).toBe(1);
    expect(Buffer.byteLength(String(state))).toBeLessThanOrEqual(1024);
    expect(calls.filter((c) => c.method === 'sendWidget')).toHaveLength(1);
    await tap('rv:d:00000000-0000-0000-0000-000000000000', row.message_id);
    expect(answer()).toContain('无效');
  });
  it('keeps the newest completion state when a queued review-button cleanup arrives later', async () => {
    const subject = `submission:${providerId}`;
    await sendCard(
      storage.db,
      sender,
      'sendMessage',
      {
        chat_id: '42',
        text: '待审核',
        reply_markup: { inline_keyboard: [[{ text: '审核', callback_data: 'pd' }]] },
      },
      subject,
    );
    const row = await card();
    await clearReviewButtons(storage.db, subject);
    await editWidget(
      storage.db,
      sender,
      { ...row, chat_id: '42' },
      { ...row.document, blocks: ['<p>已通过</p>'], buttons: [], caption: '已通过' },
    );
    await dispatchNotifications(storage.db, sender);
    const payload = calls.findLast((c) => c.method === 'editMessageWidgetData')!.payload;
    const state = JSON.parse(String(payload.chat_data));
    expect(state.h).toContain('已通过');
    expect(state.r).toBe((await card()).revision);
    expect(payload).not.toHaveProperty('widget_record_id');
  });
  it('preserves private forum topics through widget navigation and native review prompts', async () => {
    await command('/start');
    await storage.db.query("UPDATE users SET role='moderator' WHERE telegram_id='42'");
    const [incident] = await storage.db.query<{ id: string }>(
      "INSERT INTO incidents(provider_id,summary) VALUES ($1,'检测异常') RETURNING id",
      [providerId],
    );
    await sendCard(storage.db, sender, 'sendMessage', {
      chat_id: '42',
      message_thread_id: 17,
      text: '待复核',
      reply_markup: {
        inline_keyboard: [[{ text: '打开事件', callback_data: `ri:${incident!.id}` }]],
      },
    });
    let row = await card();
    await tap(action(row, 'ri:'), row.message_id);
    row = await card();
    expect(row.document.threadId).toBe(17);
    await tap(action(row, 'rv:d:'), row.message_id);
    expect(calls.findLast((c) => c.method === 'sendMessage')!.payload).toMatchObject({
      message_thread_id: 17,
      reply_markup: { force_reply: true },
    });
  });
});
