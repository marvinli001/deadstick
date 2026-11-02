import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { database } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { digest } from '../src/crypto.js';
import { createBot } from '../src/telegram/bot.js';
import {
  dispatchNotifications,
  enqueue,
  notifyIncidentOpened,
  notifyResolution,
  TelegramError,
} from '../src/telegram/notifications.js';
import { defaultPolicy, type NotificationPolicy } from '../src/telegram/notification-policy.js';
import type { NotificationEvent } from '../src/telegram/policy-delivery.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('group notification business behavior', () => {
  const connection = process.env.TEST_DATABASE_URL!;
  const dbName = `deadstick_groups_${randomBytes(6).toString('hex')}`;
  const config = loadConfig({
    APP_KEY: randomBytes(32).toString('base64'),
    TELEGRAM_BOT_TOKEN: '123:test-token',
    TELEGRAM_WEBHOOK_SECRET: 'test_webhook_secret_123456789012345',
    PUBLIC_URL: 'https://deadstick.example',
    TELEGRAM_BOT_USERNAME: 'deadstick_test_bot',
  });
  let root: pg.Pool, storage: ReturnType<typeof database>, app: FastifyInstance;
  let userId: string, providerId: string, otherId: string;
  let memberStatus = 'administrator',
    botStatus = 'member';
  const member = { authorization: 'Bearer group-user' };
  const admin = { authorization: 'Bearer site-admin' };
  const group = '/telegram/groups/-100123';
  const defaultSend = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (method === 'getMe') return { id: 123 };
    if (method === 'getChat') return { type: 'supergroup', title: '<本群>' };
    if (method === 'getChatMember') {
      if (params.user_id !== 123) throw new Error('Bot is not a group administrator');
      return { status: botStatus };
    }
    if (method === 'getChatAdministrators')
      return params.chat_id === '-100123' && ['creator', 'administrator'].includes(memberStatus)
        ? [{ user: { id: 42 } }]
        : [];
    return { message_id: 55 };
  };
  const sender = { send: vi.fn(defaultSend) };
  const sent = () => sender.send.mock.calls.filter(([method]) => method.startsWith('send'));
  const policy = (extra: Partial<NotificationPolicy> = {}) => ({
    ...defaultPolicy,
    enabled: true,
    ...extra,
  });
  const save = (value = policy(), headers = member) =>
    app.inject({
      method: 'PUT',
      url: group,
      headers,
      payload: { queryEnabled: true, topicId: 12, policy: value },
    });
  async function event(key: string, value: NotificationEvent = { type: 'anomaly' }) {
    await enqueue(
      storage.db,
      key,
      '-100123',
      { text: '<b>真实状态</b>', parse_mode: 'HTML' },
      null,
      { audience: 'group', event: { providerId, ...value } },
    );
  }
  beforeAll(async () => {
    root = new pg.Pool({ connectionString: connection });
    await root.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(connection);
    url.pathname = `/${dbName}`;
    storage = database(url.href);
    await migrate(storage.db);
    await migrate(storage.db);
  });
  afterAll(async () => {
    await app?.close();
    await storage?.close();
    if (root) {
      await root.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await root.end();
    }
  });
  beforeEach(async () => {
    await app?.close();
    app = await buildApp(storage.db, config, { logger: false, sender });
    await app.ready();
    await storage.db.query(
      'TRUNCATE users,providers,telegram_chats,notifications,bot_updates RESTART IDENTITY CASCADE',
    );
    const [u] = await storage.db.query<{ id: string }>(
      "INSERT INTO users(display_name,telegram_id) VALUES ('User','42') RETURNING id",
    );
    userId = u!.id;
    const [a] = await storage.db.query<{ id: string }>(
      "INSERT INTO users(display_name,role,telegram_id) VALUES ('Admin','admin','100') RETURNING id",
    );
    await storage.db.query(
      "INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES ($1,$2,'csrf',now()+interval '1 day'),($3,$4,'csrf',now()+interval '1 day')",
      [digest('group-user'), userId, digest('site-admin'), a!.id],
    );
    const p = await storage.db.query<{ id: string }>(
      "INSERT INTO providers(name,slug,tags) VALUES ('机场 <甲>','airport-one',ARRAY['月付']),('机场乙','airport-two',ARRAY['年付']) RETURNING id",
    );
    providerId = p[0]!.id;
    otherId = p[1]!.id;
    memberStatus = 'administrator';
    botStatus = 'member';
    sender.send.mockReset().mockImplementation(defaultSend);
  });
  it('lets current ordinary group admins manage only their own group and checks permissions again on every read/write/test', async () => {
    expect((await app.inject({ url: group, headers: member })).statusCode).toBe(200);
    expect((await save()).statusCode).toBe(200);
    expect(
      (await app.inject({ url: '/telegram/groups/-100999', headers: member })).statusCode,
    ).toBe(403);
    expect((await app.inject({ url: '/admin/telegram/chats', headers: member })).statusCode).toBe(
      403,
    );
    expect((await app.inject({ url: '/admin/incidents', headers: member })).statusCode).toBe(403);
    memberStatus = 'member';
    expect((await app.inject({ url: group, headers: member })).statusCode).toBe(403);
    expect((await save()).statusCode).toBe(403);
    expect(
      (await app.inject({ url: `${group}/test`, method: 'POST', headers: member, payload: {} }))
        .statusCode,
    ).toBe(403);
    expect((await app.inject({ url: '/telegram/groups/-100999', headers: admin })).statusCode).toBe(
      200,
    );
    expect((await storage.db.query('SELECT role FROM users WHERE id=$1', [userId]))[0]!.role).toBe(
      'user',
    );
    botStatus = 'left';
    expect((await save(policy(), admin)).statusCode).toBe(403);
  });
  it('migrates old opt-in bindings conservatively while keeping newly bound groups out of broadcasts', async () => {
    await storage.db.transaction(async (tx) => {
      await tx.query('CREATE SCHEMA legacy_group_policy');
      await tx.query('SET LOCAL search_path TO legacy_group_policy');
      await tx.query('CREATE TABLE users(id uuid PRIMARY KEY)');
      await tx.query('CREATE TABLE telegram_chats(id text PRIMARY KEY,kind text,enabled boolean)');
      await tx.query(
        'CREATE TABLE notifications(chat_id text,available_at timestamptz,status text)',
      );
      await tx.query("INSERT INTO telegram_chats VALUES ('-1','group',true),('-2','group',false)");
      await tx.query(
        await readFile(
          new URL('../migrations/007_group_notifications.sql', import.meta.url),
          'utf8',
        ),
      );
      await tx.query("INSERT INTO telegram_chats(id,kind,enabled) VALUES ('-3','group',true)");
      expect(
        await tx.query('SELECT id,enabled,notification_policy FROM telegram_chats ORDER BY id'),
      ).toEqual([
        { id: '-1', enabled: true, notification_policy: { enabled: true } },
        { id: '-2', enabled: false, notification_policy: { enabled: true } },
        { id: '-3', enabled: true, notification_policy: { enabled: false } },
      ]);
      await tx.query('DROP SCHEMA legacy_group_policy CASCADE');
    });
  });
  it('keeps querying independent of notification opt-in and sends only explicit labelled tests while disabled', async () => {
    await save(policy({ enabled: false }));
    await event('disabled');
    expect(
      (await app.inject({ url: `${group}/test`, method: 'POST', headers: member, payload: {} }))
        .statusCode,
    ).toBe(200);
    await dispatchNotifications(storage.db, sender);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]![1].text).toContain('通知测试');
    expect((await storage.db.query('SELECT query_enabled,enabled FROM telegram_chats'))[0]).toEqual(
      { query_enabled: true, enabled: true },
    );
  });
  it('rechecks current provider/tag/event rules for already queued data and preserves facts in playful digests', async () => {
    await save(policy());
    await event('filtered-provider');
    await save(policy({ scope: 'providers', providerIds: [otherId] }));
    await dispatchNotifications(storage.db, sender);
    expect(sent()).toHaveLength(0);
    await save(policy({ scope: 'tags', tags: ['年付'] }));
    await event('filtered-tag');
    await dispatchNotifications(storage.db, sender);
    expect(sent()).toHaveLength(0);
    await save(policy({ events: ['dead'], tone: 'playful', mergeSeconds: 10 }));
    await event('filtered-event');
    await event('dead', {
      type: 'dead',
      manual: true,
      summary: '<人工结论>',
      evidenceUrls: ['https://evidence.example'],
    });
    await event('dead-two', { type: 'dead', manual: true, summary: '人工证据核验' });
    await storage.db.query(
      "UPDATE notifications SET created_at=now()-interval '2 minutes',available_at=now() WHERE status='pending'",
    );
    await dispatchNotifications(storage.db, sender);
    expect(sent()).toHaveLength(1);
    const text = sent()[0]![1].text as string;
    expect(text).toContain('人工核验：确认跑路');
    expect(text).toContain('&lt;人工结论&gt;');
    expect(text).toContain('机场 &lt;甲&gt;');
    expect(text).toContain('机场有新剧情');
    expect(text).toContain('核验证据 1 项');
    await dispatchNotifications(storage.db, sender);
    expect(sent()).toHaveLength(1);
  });
  it('actually defers summaries and merges due changes once, with no empty daily message', async () => {
    await save(policy({ mode: 'digest', timezone: 'UTC', digestAt: '09:00' }));
    await dispatchNotifications(storage.db, sender);
    expect(sent()).toHaveLength(0);
    await event('digest-one');
    await event('digest-two', { type: 'recovery' });
    await dispatchNotifications(storage.db, sender);
    const rows = await storage.db.query<{ available_at: Date }>(
      'SELECT available_at FROM notifications',
    );
    // Move the events back across the scheduled boundary; no real-time clock or network is needed.
    await storage.db.query(
      "UPDATE notifications SET created_at=now()-interval '2 days',available_at=now()",
    );
    await Promise.all([
      dispatchNotifications(storage.db, sender),
      dispatchNotifications(storage.db, sender),
    ]);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]![1].text).toContain('2 条');
    await dispatchNotifications(storage.db, sender);
    expect(sent()).toHaveLength(1);
    expect(rows).toHaveLength(2);
  });
  it('consumes a whole daily window above eight events without leaking leftovers into hourly sends', async () => {
    await save(
      policy({ mode: 'digest', timezone: 'UTC', digestAt: '09:00', minIntervalSeconds: 3600 }),
    );
    for (let i = 0; i < 12; i++)
      await event(`large-digest-${i}`, { type: i % 2 ? 'recovery' : 'anomaly' });
    await storage.db.query(
      "UPDATE notifications SET created_at=now()-interval '2 days',available_at=now()",
    );
    await dispatchNotifications(storage.db, sender);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]![1].text).toContain('12 条');
    expect(sent()[0]![1].text).toContain('另有 4 条');
    expect(sent()[0]![1].text).toContain('检测恢复 6');
    expect(await storage.db.query("SELECT id FROM notifications WHERE status='sent'")).toHaveLength(
      12,
    );
    await storage.db.query(
      "UPDATE notifications SET sent_at=now()-interval '2 hours',available_at=now()",
    );
    await dispatchNotifications(storage.db, sender);
    expect(sent()).toHaveLength(1);
  });
  it('enforces the current merge window, overnight quiet hours and minimum interval without consuming retry attempts', async () => {
    await save(policy({ mergeSeconds: 60 }));
    await event('merge');
    await dispatchNotifications(storage.db, sender);
    expect(sent()).toHaveLength(0);
    await storage.db.query(
      "UPDATE notifications SET created_at=now()-interval '2 minutes',available_at=now()",
    );
    await event('merge-later', { type: 'recovery' });
    await dispatchNotifications(storage.db, sender);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]![1].text).toContain('2 条');
    await save(policy({ minIntervalSeconds: 300 }));
    await event('rate');
    await dispatchNotifications(storage.db, sender);
    expect(sent()).toHaveLength(1);
    expect(
      (await storage.db.query("SELECT attempts FROM notifications WHERE dedupe_key='rate'"))[0]!
        .attempts,
    ).toBe(0);
    const hour = new Date().getUTCHours();
    const start = `${String(hour).padStart(2, '0')}:00`;
    const end = `${String((hour + 2) % 24).padStart(2, '0')}:00`;
    await save(policy({ timezone: 'UTC', quietStart: start, quietEnd: end }));
    await event('quiet');
    await dispatchNotifications(storage.db, sender);
    expect(sent()).toHaveLength(1);
    expect(
      (await storage.db.query("SELECT attempts FROM notifications WHERE dedupe_key='quiet'"))[0]!
        .attempts,
    ).toBe(0);
  });
  it('stops queued delivery when the configuring admin loses permission or the bot leaves', async () => {
    await save();
    await event('revoked-admin');
    memberStatus = 'member';
    await dispatchNotifications(storage.db, sender);
    expect(sent()).toHaveLength(0);
    expect((await storage.db.query('SELECT error_code FROM notifications'))[0]!.error_code).toBe(
      'GROUP_ADMIN_REVOKED',
    );
    memberStatus = 'administrator';
    await save();
    await event('left');
    botStatus = 'left';
    await dispatchNotifications(storage.db, sender);
    expect(sent()).toHaveLength(0);
    expect((await storage.db.query('SELECT enabled FROM telegram_chats'))[0]!.enabled).toBe(false);
  });
  it('replies to the original incident, falls back once for an unavailable reply and fails a closed topic without infinite retry', async () => {
    await save();
    const incidentId = randomUUID();
    await event('incident', { type: 'anomaly', incidentId });
    await dispatchNotifications(storage.db, sender);
    await event('recovery', { type: 'recovery', incidentId });
    // Override only send methods while retaining membership checks.
    const impl = sender.send.getMockImplementation()!;
    let failedReply = false;
    sender.send.mockImplementation(async (method, params) => {
      if (method.startsWith('send') && params.reply_parameters && !failedReply) {
        failedReply = true;
        throw new TelegramError(400);
      }
      return impl(method, params);
    });
    await dispatchNotifications(storage.db, sender);
    expect(failedReply).toBe(true);
    expect(sent().filter(([, params]) => params.reply_parameters)).toHaveLength(1);
    expect(sent().at(-1)![1].reply_parameters).toBeUndefined();
    await event('closed-topic', { type: 'revival', manual: true });
    sender.send.mockImplementation(async (method, params) => {
      if (method.startsWith('send')) throw new TelegramError(400);
      return impl(method, params);
    });
    await dispatchNotifications(storage.db, sender);
    const count = sent().length;
    await dispatchNotifications(storage.db, sender);
    expect(sent()).toHaveLength(count);
    expect(
      (
        await storage.db.query("SELECT status FROM notifications WHERE dedupe_key='closed-topic'")
      )[0]!.status,
    ).toBe('failed');
    sender.send.mockImplementation(impl);
  });
  it('uses outbox deduplication and 429 retry with current settings at retry time', async () => {
    await save();
    await event('duplicate');
    await event('duplicate');
    const impl = sender.send.getMockImplementation()!;
    sender.send.mockImplementation(async (method, params) => {
      if (method.startsWith('send')) throw new TelegramError(429, 60);
      return impl(method, params);
    });
    await dispatchNotifications(storage.db, sender);
    expect((await storage.db.query('SELECT status,attempts FROM notifications'))[0]).toEqual({
      status: 'pending',
      attempts: 1,
    });
    sender.send.mockImplementation(impl);
    await save(policy({ scope: 'providers', providerIds: [otherId] }));
    await storage.db.query("UPDATE notifications SET available_at=now() WHERE status='pending'");
    await dispatchNotifications(storage.db, sender);
    expect(sent()).toHaveLength(1);
    expect((await storage.db.query('SELECT error_code FROM notifications'))[0]!.error_code).toBe(
      'RULE_CHANGED',
    );
  });
  it('honors 429 during permission checks and ends exhausted retries in a visible failed state', async () => {
    await save();
    await event('permission-rate-limit');
    const impl = sender.send.getMockImplementation()!;
    sender.send.mockImplementation(async (method, params) => {
      if (method === 'getChatAdministrators') throw new TelegramError(429, 120);
      return impl(method, params);
    });
    await dispatchNotifications(storage.db, sender);
    const [row] = await storage.db.query<{ status: string; attempts: number; available_at: Date }>(
      'SELECT status,attempts,available_at FROM notifications',
    );
    expect(row!.status).toBe('pending');
    expect(row!.attempts).toBe(1);
    expect(row!.available_at.getTime()).toBeGreaterThan(Date.now() + 110000);
    await dispatchNotifications(storage.db, sender);
    expect(sent()).toHaveLength(0);
    await storage.db.query('UPDATE notifications SET attempts=7,available_at=now()');
    await dispatchNotifications(storage.db, sender);
    await dispatchNotifications(storage.db, sender);
    expect((await storage.db.query('SELECT status,error_code FROM notifications'))[0]).toEqual({
      status: 'failed',
      error_code: 'RETRIES_EXHAUSTED',
    });
  });
  it.each(['sendMessage', 'getChatAdministrators'])(
    'keeps new events behind a recipient cooldown after %s is rate limited',
    async (limitedMethod) => {
      await save();
      await event('rate-limited');
      const impl = sender.send.getMockImplementation()!;
      sender.send.mockImplementation(async (method, params) => {
        if (method === limitedMethod && params.chat_id === '-100123')
          throw new TelegramError(429, 120);
        return impl(method, params);
      });
      await dispatchNotifications(storage.db, sender);
      await event('arrived-during-cooldown');
      sender.send.mockImplementation(impl);
      expect((await save(policy({ tone: 'playful' }))).statusCode).toBe(200);
      await storage.db.query('INSERT INTO follows(user_id,provider_id) VALUES ($1,$2)', [
        userId,
        providerId,
      ]);
      await enqueue(storage.db, 'other-recipient', '42', { text: '个人动态' }, null, {
        audience: 'follower',
        event: { providerId, type: 'anomaly' },
      });
      sender.send.mockClear();
      await dispatchNotifications(storage.db, sender);
      expect(sender.send.mock.calls.some(([, params]) => params.chat_id === '-100123')).toBe(false);
      expect(sender.send.mock.calls).toEqual([
        ['sendMessage', { text: '个人动态', chat_id: '42' }],
      ]);
      expect(
        (
          await storage.db.query(
            "SELECT status,attempts FROM notifications WHERE dedupe_key='arrived-during-cooldown'",
          )
        )[0],
      ).toEqual({ status: 'pending', attempts: 0 });
      await storage.db.query("UPDATE notifications SET available_at=now() WHERE status='pending'");
      await dispatchNotifications(storage.db, sender);
      await dispatchNotifications(storage.db, sender);
      expect(
        await storage.db.query("SELECT id FROM notifications WHERE status='sent'"),
      ).toHaveLength(3);
    },
  );
  it('applies personal manual-only and schedule preferences and rechecks unfollows', async () => {
    await storage.db.query('INSERT INTO follows(user_id,provider_id) VALUES ($1,$2)', [
      userId,
      providerId,
    ]);
    const endpoint = '/telegram/notifications/preferences';
    expect(
      (
        await app.inject({
          url: endpoint,
          method: 'PUT',
          headers: member,
          payload: policy({ conclusionsOnly: true }),
        })
      ).statusCode,
    ).toBe(200);
    const p = { id: providerId, name: '机场甲', slug: 'airport-one' },
      incidentId = randomUUID();
    await notifyIncidentOpened(storage.db, config, p, incidentId, '网站异常');
    await notifyResolution(storage.db, config, p, incidentId, {
      action: 'recovered',
      reason: '人工核验恢复',
      evidenceUrls: ['https://evidence.example'],
    });
    await dispatchNotifications(storage.db, sender);
    expect(sent()).toHaveLength(1);
    expect(JSON.stringify(sent()[0]![1])).toContain('人工核验：服务恢复');
    await notifyIncidentOpened(storage.db, config, p, randomUUID(), '新异常');
    await app.inject({
      url: endpoint,
      method: 'PUT',
      headers: member,
      payload: policy({ mode: 'digest', timezone: 'UTC' }),
    });
    await dispatchNotifications(storage.db, sender);
    expect(sent()).toHaveLength(1);
    await storage.db.query('DELETE FROM follows');
    await storage.db.query("UPDATE notifications SET available_at=now() WHERE status='pending'");
    await dispatchNotifications(storage.db, sender);
    expect(sent()).toHaveLength(1);
  });
  it('supports ordinary admin bind/setup, group migration and membership removal through real bot handlers', async () => {
    const bot = createBot(storage.db, config);
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    bot.api.config.use(async (_prev, method, params) => {
      calls.push({ method, params: params as Record<string, unknown> });
      const result =
        method === 'getMe'
          ? { id: 123, is_bot: true, first_name: 'Bot', username: 'deadstick_test_bot' }
          : method === 'getChatAdministrators'
            ? [{ status: 'administrator', user: { id: 42 } }]
            : method.startsWith('send')
              ? { message_id: 55, date: 1, chat: { id: -100123, type: 'supergroup' } }
              : true;
      return { ok: true, result } as never;
    });
    await bot.init();
    const chat = { id: -100123, type: 'supergroup', title: '本群' };
    const from = { id: 42, is_bot: false, first_name: 'User' };
    const text = (update_id: number, command: string) => ({
      update_id,
      message: {
        message_id: update_id,
        date: 1,
        chat,
        from,
        text: command,
        entities: [{ type: 'bot_command', offset: 0, length: command.split(' ')[0]!.length }],
      },
    });
    await bot.handleUpdate(text(1, '/bind') as never);
    expect(
      (await storage.db.query('SELECT notification_policy,query_enabled FROM telegram_chats'))[0],
    ).toMatchObject({ notification_policy: { enabled: false }, query_enabled: true });
    await bot.handleUpdate(text(2, '/status airport-one') as never);
    const afterQuery = calls.filter((c) => c.method.startsWith('send')).length;
    expect(afterQuery).toBe(2);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: group,
          headers: member,
          payload: { queryEnabled: false, topicId: null, policy: policy({ enabled: false }) },
        })
      ).statusCode,
    ).toBe(200);
    await bot.handleUpdate(text(3, '/status airport-one') as never);
    expect(calls.filter((c) => c.method.startsWith('send'))).toHaveLength(afterQuery);
    await bot.handleUpdate(text(4, '/groupsetup') as never);
    expect(JSON.stringify(calls)).toContain('startapp=group_100123');
    await save(policy({ quietStart: '23:00', quietEnd: '08:00' }));
    await event('migration');
    await bot.handleUpdate({
      update_id: 5,
      message: {
        message_id: 3,
        date: 1,
        chat,
        from: { id: 123, is_bot: true, first_name: 'Bot' },
        migrate_to_chat_id: -100999,
      },
    } as never);
    expect(
      (await storage.db.query('SELECT id,topic_id,notification_policy FROM telegram_chats'))[0],
    ).toMatchObject({
      id: '-100999',
      topic_id: null,
      notification_policy: { quietStart: '23:00' },
    });
    expect((await storage.db.query('SELECT chat_id,topic_id FROM notifications'))[0]).toEqual({
      chat_id: '-100999',
      topic_id: null,
    });
    await bot.handleUpdate({
      update_id: 6,
      my_chat_member: {
        chat: { ...chat, id: -100999 },
        from,
        date: 1,
        old_chat_member: { status: 'member', user: { id: 123, is_bot: true, first_name: 'Bot' } },
        new_chat_member: { status: 'left', user: { id: 123, is_bot: true, first_name: 'Bot' } },
      },
    } as never);
    expect((await storage.db.query('SELECT enabled FROM telegram_chats'))[0]!.enabled).toBe(false);
    await dispatchNotifications(storage.db, sender);
    expect(sent()).toHaveLength(0);
  });
});
