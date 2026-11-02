import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Update, UserFromGetMe, InlineKeyboardMarkup } from 'grammy/types';
import { database } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { loadConfig } from '../src/config.js';
import { createBot } from '../src/telegram/bot.js';
import { conversationIntent } from '../src/telegram/conversation.js';
import { cleanup } from '../src/monitor/queue.js';
import { encrypt } from '../src/crypto.js';
import { miniAppPath } from '../web/src/lib/telegram.js';

describe('private conversation intents', () => {
  it.each([
    ['某某云', 'search', '某某云'],
    ['https://example.com/path?q=1', 'search', 'https://example.com/path?q=1'],
    ['example.com', 'search', 'example.com'],
    ['某某云还活着吗？', 'search', '某某云'],
    ['查一下某某云', 'search', '某某云'],
    ['查查 Cloud Airport', 'search', 'Cloud Airport'],
    ['关注某某云', 'follow', '某某云'],
    ['蹲一下这家', 'follow', ''],
    ['取消关注', 'unfollow', ''],
    ['退订某某云', 'unfollow', '某某云'],
    ['我来报个信', 'report', ''],
    ['给某某云补线索', 'report', '某某云'],
    ['活着云', 'search', '活着云'],
    ['Example?Cloud', 'search', 'Example?Cloud'],
  ])('parses %s without rewriting airport names', (input, action, query) => {
    expect(conversationIntent(input)).toEqual({ action, query });
  });
  it('leaves all slash commands alone and recognizes cancellation', () => {
    expect(conversationIntent('/unknown 某某云')).toBeUndefined();
    expect(conversationIntent('/start p_123')).toBeUndefined();
    expect(conversationIntent('取消')).toEqual({ action: 'cancel' });
  });
});

const connection = process.env.TEST_DATABASE_URL;
describe.skipIf(!connection)('private Bot conversations with PostgreSQL', () => {
  let root: pg.Pool, storage: ReturnType<typeof database>;
  const dbName = `deadstick_conversation_${randomBytes(6).toString('hex')}`;
  const config = loadConfig({
    APP_KEY: randomBytes(32).toString('base64'),
    TELEGRAM_BOT_TOKEN: '123:test-token',
    TELEGRAM_WEBHOOK_SECRET: 'test_webhook_secret_123456789012345',
    TELEGRAM_BOT_USERNAME: 'deadstick_test_bot',
    PUBLIC_URL: 'https://deadstick.example',
  });
  const botInfo: UserFromGetMe = {
    id: 123,
    is_bot: true,
    first_name: 'Deadstick',
    username: 'deadstick_test_bot',
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: true,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  };
  let bot: ReturnType<typeof createBot>, otherBot: ReturnType<typeof createBot>;
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  let sequence: number, providerId: string;
  const chat = (id: number) => ({ id, type: 'private' as const, first_name: 'Tester' });
  const user = (id: number) => ({ id, is_bot: false, first_name: 'Tester' });
  async function text(body: string, id = 42, extra: object = {}, instance = bot) {
    const updateId = ++sequence;
    await instance.handleUpdate({
      update_id: updateId,
      message: {
        message_id: updateId,
        date: 1,
        chat: chat(id),
        from: user(id),
        text: body,
        ...(body.startsWith('/')
          ? {
              entities: [{ type: 'bot_command', offset: 0, length: body.split(' ')[0]!.length }],
            }
          : {}),
        ...extra,
      },
    } as Update);
  }
  async function press(data: string, id = 42, group = false, instance = bot) {
    const updateId = ++sequence;
    await instance.handleUpdate({
      update_id: updateId,
      callback_query: {
        id: `cb${updateId}`,
        from: user(id),
        chat_instance: 'test',
        data,
        message: {
          message_id: 55,
          date: 1,
          text: 'card',
          chat: group ? { id: -100123, type: 'supergroup', title: 'Allowed' } : chat(id),
        },
      },
    });
  }
  function button(label: string) {
    const keyboard = calls.at(-1)!.payload.reply_markup as InlineKeyboardMarkup;
    const found = keyboard.inline_keyboard.flat().find((b) => b.text === label);
    expect(found).toBeDefined();
    return found && 'callback_data' in found ? found.callback_data : '';
  }
  const output = () => JSON.stringify(calls);
  const follows = () => storage.db.query('SELECT user_id,provider_id FROM follows');
  beforeAll(async () => {
    root = new pg.Pool({ connectionString: connection });
    await root.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(connection!);
    url.pathname = `/${dbName}`;
    storage = database(url.href);
    await migrate(storage.db);
  });
  afterAll(async () => {
    await storage?.close();
    if (root) {
      await root.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await root.end();
    }
  });
  beforeEach(async () => {
    await storage.db.query(
      'TRUNCATE users,providers,telegram_chats,bot_conversations,bot_rate_limits CASCADE',
    );
    const [provider] = await storage.db.query<{ id: string }>(
      "INSERT INTO providers(name,slug,lifecycle,health,last_checked_at) VALUES ('测试云','test-cloud','suspected','down','2026-10-01T00:00:00Z') RETURNING id",
    );
    providerId = provider!.id;
    bot = createBot(storage.db, config, botInfo);
    otherBot = createBot(storage.db, config, botInfo);
    calls.length = 0;
    sequence = 0;
    for (const instance of [bot, otherBot])
      instance.api.config.use(async (_prev, method, payload) => {
        calls.push({ method, payload: payload as Record<string, unknown> });
        return {
          ok: true,
          result: method.startsWith('send') ? { message_id: 55, date: 1, chat: chat(42) } : true,
        } as never;
      });
  });
  it('searches ordinary names and explicit questions with factual suspected status', async () => {
    for (const query of ['测试云', '测试云还活着吗', '查一下测试云']) {
      calls.length = 0;
      await text(query);
      expect(calls.some((call) => call.method === 'sendRichMessage')).toBe(true);
      expect(output()).toContain('疑似跑路');
      expect(output()).toContain('尚未确认跑路');
      expect(output()).toContain('2026-10-01');
    }
    calls.length = 0;
    await text('/unknown 测试云');
    expect(calls).toHaveLength(0);
    await text(`/start p_${providerId.replace(/-/g, '')}`);
    expect(output()).toContain('测试云');
  });
  it('connects public-domain search, alias lookup, follow confirmation and provider lead navigation', async () => {
    await storage.db.query("UPDATE providers SET aliases=ARRAY['旧机场名'] WHERE id=$1", [
      providerId,
    ]);
    await storage.db.query(
      `INSERT INTO endpoints(provider_id,kind,label,display_host,public_url,url_ciphertext)
        VALUES ($1,'website','官网','www.airport.example','https://www.airport.example/',$2)`,
      [providerId, encrypt('https://www.airport.example/', config.appKey)],
    );
    await text('https://www.airport.example/private/path?token=never-publish');
    expect(calls.at(-1)!.method).toBe('sendRichMessage');
    expect(output()).toContain('测试云');
    expect(output()).not.toContain('never-publish');
    expect(output()).not.toContain('/private/path');
    await text('蹲一下这家');
    await press(button('确认关注'), 42, false, otherBot);
    expect((await follows())[0]!.provider_id).toBe(providerId);
    await text('给旧机场名补线索');
    const keyboard = calls.at(-1)!.payload.reply_markup as InlineKeyboardMarkup;
    const launch = keyboard.inline_keyboard.flat().find((b) => 'web_app' in b)!;
    const payload = new URL(launch.web_app.url).searchParams.get('tgWebAppStartParam');
    expect(miniAppPath(payload)).toBe(`/submit?provider=${providerId}`);
  });
  it('asks users to choose when a shared alias identifies several providers', async () => {
    await storage.db.query("UPDATE providers SET aliases=ARRAY['共同旧名'] WHERE id=$1", [
      providerId,
    ]);
    await storage.db.query(
      "INSERT INTO providers(name,slug,aliases) VALUES ('另一家机场','another-airport',ARRAY['共同旧名'])",
    );
    await text('共同旧名');
    const keyboard = calls.at(-1)!.payload.reply_markup as InlineKeyboardMarkup;
    expect(
      keyboard.inline_keyboard
        .flat()
        .filter((b) => 'callback_data' in b && b.callback_data.includes(':pick:')),
    ).toHaveLength(2);
    expect(await follows()).toHaveLength(0);
  });
  it('remembers command/card context and requires confirmation before following or unfollowing', async () => {
    await text('/status test-cloud');
    await text('蹲一下这家');
    expect(output()).toContain('关注 <b>测试云</b>');
    expect(await follows()).toHaveLength(0);
    const confirm = button('确认关注');
    await press(confirm);
    expect(await follows()).toHaveLength(1);
    await press(confirm);
    expect(calls.at(-1)!.payload.text).toContain('这轮对话已结束');
    expect(await follows()).toHaveLength(1);
    await text('取消关注');
    expect(await follows()).toHaveLength(1);
    await press(button('确认取消关注'));
    expect(await follows()).toHaveLength(0);
    await press(`fo:${providerId}`);
    expect(button('确认关注')).toMatch(/^cv:/);
    expect(await follows()).toHaveLength(0);
  });
  it('resolves ambiguous names before confirmation and rejects forged candidates', async () => {
    const [other] = await storage.db.query<{ id: string }>(
      "INSERT INTO providers(name,slug) VALUES ('测试云二号','test-cloud-two') RETURNING id",
    );
    await text('关注测试');
    const keyboard = calls.at(-1)!.payload.reply_markup as InlineKeyboardMarkup;
    const choices = keyboard.inline_keyboard
      .flat()
      .filter((b) => 'callback_data' in b && b.callback_data.includes(':pick:'));
    expect(choices).toHaveLength(2);
    const selection = choices.find(
      (b) => 'callback_data' in b && b.callback_data.endsWith(other!.id.replace(/-/g, '')),
    )!;
    const data = 'callback_data' in selection ? selection.callback_data : '';
    await press(data.replace(/[0-9a-f]{32}$/, '0'.repeat(32)));
    expect(calls.at(-1)!.payload.text).toContain('目标已变化');
    expect(await follows()).toHaveLength(0);
    await press(data);
    expect(output()).toContain('测试云二号');
    expect(await follows()).toHaveLength(0);
    await press(button('确认关注'));
    expect((await follows())[0]!.provider_id).toBe(other!.id);
  });
  it('isolates users, clarifies missing context, and expires buttons and context', async () => {
    await text('关注测试云');
    const confirm = button('确认关注');
    await press(confirm, 43);
    expect(calls.at(-1)!.payload.text).toContain('这轮对话已结束');
    await text('蹲一下这家', 43);
    expect(calls.at(-1)!.payload.text).toContain('蹲哪家');
    expect(await follows()).toHaveLength(0);
    await storage.db.query("UPDATE bot_conversations SET expires_at=now()-interval '1 second'");
    await press(confirm);
    expect(calls.at(-1)!.payload.text).toContain('这轮对话已结束');
    await text('退订');
    expect(calls.at(-1)!.payload.text).toContain('哪家');
    expect(await follows()).toHaveLength(0);
  });
  it.each(['取消', '/cancel'])('cancels with %s and invalidates old buttons', async (cancel) => {
    await text('关注测试云');
    const confirm = button('确认关注');
    await text(cancel);
    await press(confirm);
    expect(calls.at(-1)!.payload.text).toContain('这轮对话已结束');
    expect(await follows()).toHaveLength(0);
    await text('退订');
    expect(calls.at(-1)!.payload.text).toContain('哪家');
    await press(button('取消'));
    expect(calls.at(-1)!.payload.text).toBe('已取消。');
  });
  it('carries missing targets forward and lets an explicit query replace a pending action', async () => {
    await text('关注');
    await text('测试云');
    expect(button('确认关注')).toMatch(/^cv:/);
    await text('取消');
    await text('关注');
    await text('查一下测试云');
    expect(calls.at(-1)!.method).toBe('sendRichMessage');
    expect(await follows()).toHaveLength(0);
  });
  it('offers new submissions and sends existing-provider evidence to the agreed Mini App route', async () => {
    await text('我来报个信');
    expect(output()).toContain('tgWebAppStartParam=submit');
    await press(button('给已有机场补线索'));
    await text('测试云');
    expect(output()).toContain(`tgWebAppStartParam=report_${providerId.replace(/-/g, '')}`);
    expect(output()).toContain('填写线索');
    await press(button('取消'));
    expect(await storage.db.query('SELECT id FROM submissions')).toHaveLength(0);
  });
  it('does not listen to group chatter and rejects private conversation callbacks in groups', async () => {
    await storage.db.query(
      "INSERT INTO telegram_chats(id,title,kind) VALUES ('-100123','Allowed','group')",
    );
    await text('测试云', 42, { chat: { id: -100123, type: 'supergroup', title: 'Allowed' } });
    expect(calls).toHaveLength(0);
    await text('关注测试云');
    await press(button('确认关注'), 42, true);
    expect(calls.at(-1)!.payload.text).toContain('请在私聊里操作');
    expect(await follows()).toHaveLength(0);
  });
  it('escapes all new confirmation text and preserves exact intent-like catalog names', async () => {
    await storage.db.query("UPDATE providers SET name='<b>测试</b> & 云' WHERE id=$1", [
      providerId,
    ]);
    await text('关注test-cloud');
    expect(calls.at(-1)!.payload.text).toContain('&lt;b&gt;测试&lt;/b&gt; &amp; 云');
    await press(button('确认关注'));
    expect(calls.at(-1)!.payload.text).not.toContain('<b>测试</b>');
    await storage.db.query("UPDATE providers SET slug='关注test-cloud' WHERE id=$1", [providerId]);
    await text('关注test-cloud');
    expect(calls.at(-1)!.method).toBe('sendRichMessage');
  });
  it('continues selection, confirmation and cancellation across workers and consumes confirmation once', async () => {
    await storage.db.query(
      "INSERT INTO providers(name,slug) VALUES ('测试云二号','test-cloud-two')",
    );
    await text('关注测试');
    const choice = button('测试云 · test-cloud · 疑似跑路');
    await press(choice, 42, false, otherBot);
    const confirm = button('确认关注');
    calls.length = 0;
    await Promise.all([press(confirm), press(confirm, 42, false, otherBot)]);
    expect(await follows()).toHaveLength(1);
    expect(
      calls.filter((call) => call.payload.text === '已关注 <b>测试云</b>，状态变化会私信你。'),
    ).toHaveLength(1);
    await text('退订', 42, {}, otherBot);
    const unfollow = button('确认取消关注');
    await press(button('取消'));
    await press(unfollow, 42, false, otherBot);
    expect(calls.at(-1)!.payload.text).toContain('这轮对话已结束');
    expect(await follows()).toHaveLength(1);
    await text('/status test-cloud');
    await text('蹲一下这家', 42, {}, otherBot);
    expect(button('确认关注')).toMatch(/^cv:/);
  });
  it('cleans expired personal context while retaining active conversations', async () => {
    await text('关注测试云');
    await storage.db.query("UPDATE bot_conversations SET expires_at=now()-interval '1 second'");
    await text('关注', 43);
    await cleanup(storage.db, 30);
    expect(await storage.db.query('SELECT user_id FROM bot_conversations')).toEqual([
      { user_id: '43' },
    ]);
  });
  it('does not echo or persist paths and tokens from pasted URLs', async () => {
    await text('https://not-found.example/private/path?token=private-url-token');
    expect(output()).not.toContain('private-url-token');
    expect(output()).not.toContain('/private/path');
    expect(
      JSON.stringify(await storage.db.query('SELECT state FROM bot_conversations')),
    ).not.toContain('private-url-token');
  });
  it('gives review force-replies priority and rechecks reviewer permissions', async () => {
    await text('/start');
    const [incident] = await storage.db.query<{ id: string }>(
      "INSERT INTO incidents(provider_id,summary) VALUES ($1,'检测异常') RETURNING id",
      [providerId],
    );
    const prompt = {
      message_id: 55,
      date: 1,
      chat: chat(42),
      from: botInfo,
      text: `复核单：dead ${incident!.id}`,
    };
    await text('关注测试云');
    await text('https://evidence.example\n人工核验确认', 42, { reply_to_message: prompt });
    expect(calls.at(-1)!.payload.text).toContain('需要后台审核权限');
    expect((await storage.db.query('SELECT status FROM incidents'))[0]!.status).toBe('open');
    await storage.db.query("UPDATE users SET role='moderator' WHERE telegram_id='42'");
    await text('https://evidence.example\n人工核验确认', 42, { reply_to_message: prompt });
    expect((await storage.db.query('SELECT status FROM incidents'))[0]!.status).toBe(
      'confirmed_dead',
    );
    expect((await storage.db.query('SELECT lifecycle FROM providers'))[0]!.lifecycle).toBe('dead');
    expect(await follows()).toHaveLength(0);
  });
});
