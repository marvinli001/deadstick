import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { database } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { digest, encrypt, decrypt, hashPassword } from '../src/crypto.js';
import { claimChecks, monitorSettings, runCheck, schedule } from '../src/monitor/queue.js';
import {
  createProvider,
  prepareProvider,
  resolveIncident,
  addTribute,
} from '../src/catalog/service.js';
import { telegramUser } from '../src/auth/service.js';
import { createBot, processBotUpdates } from '../src/telegram/bot.js';
import { dispatchNotifications, enqueue, TelegramError } from '../src/telegram/notifications.js';
import type { CheckEndpoint } from '../src/monitor/check.js';

const connection = process.env.TEST_DATABASE_URL;
describe.skipIf(!connection)('PostgreSQL integration', () => {
  let app: FastifyInstance, storage: ReturnType<typeof database>, root: pg.Pool;
  const config = loadConfig({
    APP_KEY: randomBytes(32).toString('base64'),
    TELEGRAM_BOT_TOKEN: '123:test-token',
    TELEGRAM_WEBHOOK_SECRET: 'test_webhook_secret_123456789012345',
    PUBLIC_URL: 'http://localhost:3000',
  });
  const dbName = `deadstick_it_${randomBytes(6).toString('hex')}`;
  const sender = {
    send: vi.fn(async () => ({ type: 'supergroup', title: 'Test group' }) as unknown),
  };
  let adminId: string, userId: string, passwordHash: string;
  const admin = { cookie: 'session=admin-token', 'x-csrf-token': 'admin-csrf' };
  const member = { cookie: 'session=user-token', 'x-csrf-token': 'user-csrf' };
  const input = {
    name: '测试机场',
    slug: 'test-airport',
    endpoints: [
      { kind: 'website' as const, url: 'https://www.example.com' },
      {
        kind: 'subscription' as const,
        url: 'https://sub.example.com/sub?token=subscription-secret',
      },
    ],
  };
  beforeAll(async () => {
    root = new pg.Pool({ connectionString: connection });
    await root.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(connection!);
    url.pathname = `/${dbName}`;
    storage = database(url.href);
    await migrate(storage.db);
    await migrate(storage.db);
    passwordHash = await hashPassword('test-password-long');
    app = await buildApp(storage.db, config, { logger: false, sender });
    await app.ready();
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
    await storage.db.query(
      'TRUNCATE users,providers,telegram_chats,notifications,bot_updates,auth_replays,worker_heartbeats RESTART IDENTITY CASCADE',
    );
    adminId = (
      await storage.db.query<{ id: string }>(
        "INSERT INTO users(email,password_hash,display_name,role,telegram_id) VALUES ('admin@example.com',$1,'Admin','admin','100') RETURNING id",
        [passwordHash],
      )
    )[0]!.id;
    userId = (
      await storage.db.query<{ id: string }>(
        "INSERT INTO users(email,password_hash,display_name) VALUES ('user@example.com',$1,'User') RETURNING id",
        [passwordHash],
      )
    )[0]!.id;
    await storage.db.query(
      "INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES ($1,$2,'admin-csrf',now()+interval '1 day'),($3,$4,'user-csrf',now()+interval '1 day')",
      [digest('admin-token'), adminId, digest('user-token'), userId],
    );
    sender.send.mockReset().mockResolvedValue({ type: 'supergroup', title: 'Test group' });
  });
  async function provider() {
    return storage.db.transaction((tx) =>
      createProvider(tx, prepareProvider(input, config), adminId),
    );
  }
  const fakeCheck =
    (ok: boolean): CheckEndpoint =>
    async (e) => ({
      endpointId: e.id,
      kind: e.kind,
      ok,
      latencyMs: 1,
      errorCode: ok ? undefined : 'HTTP_503',
    });
  async function check(providerId: string, ok: boolean) {
    await storage.db.query('INSERT INTO check_jobs(provider_id,dedupe_key) VALUES ($1,$2)', [
      providerId,
      randomUUID(),
    ]);
    const jobs = await claimChecks(storage.db, 1);
    expect(jobs).toHaveLength(1);
    await runCheck(storage.db, config, jobs[0]!, await monitorSettings(storage.db), fakeCheck(ok));
    expect(
      (await storage.db.query('SELECT status FROM check_jobs WHERE id=$1', [jobs[0]!.id]))[0]!
        .status,
    ).toBe('done');
  }
  it('registers, logs in, enforces CSRF and revokes logout sessions', async () => {
    const register = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'new@example.com',
        password: 'long-test-password',
        displayName: 'New user',
      },
    });
    expect(register.statusCode, register.body).toBe(201);
    expect(register.json().user.role).toBe('user');
    const cookie = register.cookies.find((c) => c.name === 'session')!;
    const headers = { cookie: `session=${cookie.value}` };
    expect((await app.inject({ url: '/auth/me', headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/auth/logout', headers })).statusCode).toBe(
      403,
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/auth/logout',
          headers: { ...headers, 'x-csrf-token': register.json().csrfToken },
        })
      ).statusCode,
    ).toBe(200);
    expect((await app.inject({ url: '/auth/me', headers })).statusCode).toBe(401);
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'new@example.com', password: 'long-test-password' },
    });
    expect(login.statusCode, login.body).toBe(200);
    expect(login.body).not.toContain('password_hash');
    expect(login.body).not.toContain('scrypt:');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/auth/register',
          remoteAddress: '127.0.0.2',
          payload: {
            email: 'admin2@example.com',
            password: 'long-test-password',
            displayName: 'No',
            role: 'admin',
          },
        })
      ).statusCode,
    ).toBe(400);
  });
  it('rejects forbidden origins, expired sessions and privilege escalation', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/admin/providers',
          headers: member,
          payload: input,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/admin/providers',
          headers: { ...admin, origin: 'https://evil.example.com' },
          payload: input,
        })
      ).statusCode,
    ).toBe(403);
    await storage.db.query("UPDATE sessions SET expires_at=now()-interval '1 second'");
    expect((await app.inject({ url: '/auth/me', headers: admin })).statusCode).toBe(401);
  });
  it('stores encrypted subscriptions and never returns credentials publicly', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/providers',
      headers: admin,
      payload: input,
    });
    expect(response.statusCode, response.body).toBe(201);
    const id = response.json().id;
    const row = (
      await storage.db.query(
        "SELECT * FROM endpoints WHERE provider_id=$1 AND kind='subscription'",
        [id],
      )
    )[0]!;
    expect(JSON.stringify(row)).not.toContain('subscription-secret');
    expect(decrypt(row.url_ciphertext, config.appKey)).toContain('subscription-secret');
    for (const url of [`/providers/${id}`, '/providers', '/graveyard', `/providers/${id}/checks`]) {
      const result = await app.inject({ url });
      expect(result.statusCode).toBe(200);
      expect(result.body).not.toContain('subscription-secret');
      expect(result.body).not.toContain('sub.example.com');
    }
  });
  it('approves a submission once and preserves encrypted inputs', async () => {
    const submitted = await app.inject({
      method: 'POST',
      url: '/submissions',
      headers: member,
      payload: input,
    });
    expect(submitted.statusCode, submitted.body).toBe(201);
    const url = `/admin/submissions/${submitted.json().id}/review`,
      payload = { approve: true, reason: '已核对' };
    const approved = await app.inject({ method: 'POST', url, headers: admin, payload });
    expect(approved.statusCode, approved.body).toBe(200);
    expect((await app.inject({ method: 'POST', url, headers: admin, payload })).statusCode).toBe(
      409,
    );
    expect((await storage.db.query('SELECT * FROM providers')).length).toBe(1);
  });
  it('detects failure, deduplicates alerts, requires evidence, and supports cemetery interactions', async () => {
    const p = await provider();
    await storage.db.query(
      "INSERT INTO telegram_chats(id,title,kind) VALUES ('-100123','Allowed','group'),('100','Admin','admin')",
    );
    await check(p.id, false);
    expect(
      (await storage.db.query('SELECT lifecycle FROM providers WHERE id=$1', [p.id]))[0]!.lifecycle,
    ).toBe('active');
    await check(p.id, false);
    await check(p.id, false);
    const incidents = await storage.db.query<{ id: string }>('SELECT id FROM incidents');
    expect(incidents).toHaveLength(1);
    expect(await storage.db.query('SELECT id FROM notifications')).toHaveLength(2);
    const url = `/admin/incidents/${incidents[0]!.id}/resolve`;
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: admin,
          payload: { action: 'dead', reason: '人工核验' },
        })
      ).statusCode,
    ).toBe(400);
    const resolved = await app.inject({
      method: 'POST',
      url,
      headers: admin,
      payload: {
        action: 'dead',
        reason: '人工核验确认停止运营',
        evidenceUrls: ['https://evidence.example.com/announcement'],
      },
    });
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect((await app.inject({ url: '/graveyard' })).json().items).toHaveLength(1);
    const tributeUrl = `/providers/${p.id}/tributes`;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: tributeUrl,
          headers: member,
          payload: { kind: 'flower' },
        })
      ).json().created,
    ).toBe(true);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: tributeUrl,
          headers: member,
          payload: { kind: 'flower' },
        })
      ).json().created,
    ).toBe(false);
    const memorial = await app.inject({
      method: 'POST',
      url: `/providers/${p.id}/memorials`,
      headers: member,
      payload: { body: '电子上坟' },
    });
    expect(memorial.statusCode, memorial.body).toBe(201);
    expect((await app.inject({ url: `/providers/${p.id}/memorials` })).json().items).toHaveLength(
      0,
    );
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/admin/memorials/${memorial.json().id}`,
          headers: admin,
          payload: { visible: true },
        })
      ).statusCode,
    ).toBe(200);
    expect((await app.inject({ url: `/providers/${p.id}/memorials` })).json().items).toHaveLength(
      1,
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/admin/providers/${p.id}/revive`,
          headers: admin,
          payload: {
            reason: '已恢复运营并核验',
            evidenceUrls: ['https://evidence.example.com/recovery'],
          },
        })
      ).statusCode,
    ).toBe(200);
    expect((await app.inject({ url: '/graveyard' })).json().items).toHaveLength(0);
  });
  it('closes an unconfirmed incident automatically on recovery', async () => {
    const p = await provider();
    await check(p.id, false);
    await check(p.id, false);
    await check(p.id, true);
    expect((await storage.db.query('SELECT lifecycle,health FROM providers'))[0]).toEqual({
      lifecycle: 'active',
      health: 'healthy',
    });
    expect((await storage.db.query('SELECT status FROM incidents'))[0]!.status).toBe('resolved');
    await expect(addTribute(storage.db, p.id, userId, 'flower')).rejects.toThrow(
      'manual confirmation',
    );
  });
  it('schedules once per interval and claims one job per provider across workers', async () => {
    const p = await provider(),
      settings = await monitorSettings(storage.db);
    expect(await schedule(storage.db, settings)).toBe(1);
    expect(await schedule(storage.db, settings)).toBe(0);
    await storage.db.query('INSERT INTO check_jobs(provider_id,dedupe_key) VALUES ($1,$2)', [
      p.id,
      'second',
    ]);
    const [a, b] = await Promise.all([claimChecks(storage.db, 4), claimChecks(storage.db, 4)]);
    expect(a.length + b.length).toBe(1);
    const first = [...a, ...b][0]!;
    await storage.db.query(
      "UPDATE check_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",
      [first.id],
    );
    const reclaimed = await claimChecks(storage.db, 4);
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]!.lease_token).not.toBe(first.lease_token);
    await runCheck(storage.db, config, first, settings, fakeCheck(false));
    expect(await storage.db.query('SELECT * FROM check_runs')).toHaveLength(0);
    await runCheck(storage.db, config, reclaimed[0]!, settings, fakeCheck(true));
    expect(await storage.db.query('SELECT * FROM check_runs')).toHaveLength(1);
  });
  it('discards checks after configuration changes and retries worker failures', async () => {
    const p = await provider(),
      settings = await monitorSettings(storage.db);
    await storage.db.query('INSERT INTO check_jobs(provider_id,dedupe_key) VALUES ($1,$2)', [
      p.id,
      randomUUID(),
    ]);
    const [job] = await claimChecks(storage.db, 1);
    let updated = false;
    await runCheck(storage.db, config, job!, settings, async (e) => {
      if (!updated) {
        await storage.db.query('UPDATE providers SET config_version=config_version+1 WHERE id=$1', [
          p.id,
        ]);
        updated = true;
      }
      return fakeCheck(false)(e, settings);
    });
    expect(await storage.db.query('SELECT * FROM check_runs')).toHaveLength(0);
    expect((await storage.db.query('SELECT error_code FROM check_jobs'))[0]!.error_code).toBe(
      'CONFIG_CHANGED',
    );
    await storage.db.query('INSERT INTO check_jobs(provider_id,dedupe_key) VALUES ($1,$2)', [
      p.id,
      randomUUID(),
    ]);
    const [failing] = await claimChecks(storage.db, 1);
    await runCheck(storage.db, config, failing!, settings, async () => {
      throw new Error('worker crashed');
    });
    expect(
      (await storage.db.query('SELECT status FROM check_jobs WHERE id=$1', [failing!.id]))[0]!
        .status,
    ).toBe('pending');
  });
  it('persists and deduplicates all Telegram updates, including unknown new fields', async () => {
    const payload = {
      update_id: 123,
      stopped_message_generation: { chat: { id: 42, type: 'private' }, draft_id: 8 },
      future_feature: { value: 'kept' },
    };
    expect(
      (await app.inject({ method: 'POST', url: '/telegram/webhook', payload })).statusCode,
    ).toBe(401);
    for (let i = 0; i < 2; i++)
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/telegram/webhook',
            headers: { 'x-telegram-bot-api-secret-token': config.webhookSecret! },
            payload,
          })
        ).statusCode,
      ).toBe(200);
    const rows = await storage.db.query('SELECT * FROM bot_updates');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(decrypt(rows[0]!.payload_ciphertext, config.appKey))).toEqual(payload);
  });
  it('does not trust forwarded user IDs or allow Telegram identity takeover', async () => {
    const one = await telegramUser(storage.db, { id: '42', name: 'Telegram' });
    expect(
      (await telegramUser(storage.db, { id: '42', name: 'Telegram', subject: 'opaque-sub' })).id,
    ).toBe(one.id);
    await expect(
      telegramUser(storage.db, { id: '42', name: 'Telegram', subject: 'other-sub' }),
    ).rejects.toThrow('mismatch');
    await expect(telegramUser(storage.db, { id: '42', name: 'Telegram' }, userId)).rejects.toThrow(
      'already linked',
    );
  });
  it('retries notification rate limits and honors Telegram forum topics', async () => {
    await enqueue(storage.db, 'key', '-100123', { text: 'Test' }, 9);
    await enqueue(storage.db, 'key', '-100123', { text: 'Test' }, 9);
    sender.send.mockRejectedValueOnce(new TelegramError(429, 3));
    await dispatchNotifications(storage.db, sender);
    expect((await storage.db.query('SELECT status,attempts FROM notifications'))[0]).toEqual({
      status: 'pending',
      attempts: 1,
    });
    await storage.db.query('UPDATE notifications SET available_at=now()');
    await dispatchNotifications(storage.db, sender);
    expect(sender.send).toHaveBeenLastCalledWith('sendMessage', {
      text: 'Test',
      chat_id: '-100123',
      message_thread_id: 9,
    });
    expect((await storage.db.query('SELECT status FROM notifications'))[0]!.status).toBe('sent');
    expect(await dispatchNotifications(storage.db, sender)).toBe(0);
  });
  it('restricts bot commands to allowed groups and deduplicates tribute callbacks', async () => {
    const p = await provider();
    await storage.db.query("UPDATE providers SET lifecycle='dead' WHERE id=$1", [p.id]);
    const bot = createBot(storage.db, config, {
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
    });
    const calls: string[] = [];
    bot.api.config.use(async (_prev, method, _payload) => {
      calls.push(method);
      return { ok: true, result: true } as never;
    });
    const command = {
      update_id: 1,
      message: {
        message_id: 1,
        date: 1,
        chat: { id: -100123, type: 'supergroup' as const, title: 'Test' },
        from: { id: 42, is_bot: false, first_name: 'Tester' },
        text: '/graveyard',
        entities: [{ type: 'bot_command' as const, offset: 0, length: 10 }],
      },
    };
    await bot.handleUpdate(command);
    expect(calls).toHaveLength(0);
    await storage.db.query(
      "INSERT INTO telegram_chats(id,title,kind) VALUES ('-100123','Allowed','group')",
    );
    await bot.handleUpdate({ ...command, update_id: 2 });
    expect(calls).toContain('sendMessage');
    const callback = {
      update_id: 3,
      callback_query: {
        id: 'cb',
        from: { id: 42, is_bot: false, first_name: 'Tester' },
        chat_instance: 'test',
        data: `flower:${p.id}`,
        message: command.message,
      },
    };
    await bot.handleUpdate(callback);
    await bot.handleUpdate({ ...callback, update_id: 4 });
    expect(await storage.db.query('SELECT id FROM tributes')).toHaveLength(1);
    await storage.db.query('INSERT INTO bot_updates(update_id,payload_ciphertext) VALUES ($1,$2)', [
      10,
      encrypt(JSON.stringify({ ...command, update_id: 10 }), config.appKey),
    ]);
    expect(await processBotUpdates(storage.db, config, bot)).toBe(1);
    expect((await storage.db.query('SELECT status FROM bot_updates'))[0]!.status).toBe('done');
  });
  it('protects the last admin and forwards current Bot API fields unchanged', async () => {
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/admin/users/${adminId}`,
          headers: admin,
          payload: { role: 'user', disabled: false },
        })
      ).statusCode,
    ).toBe(409);
    const parameters = {
      chat_id: '-100123',
      text: 'hello',
      ephemeral_message_parameters: { receiver_user_id: 42, replace_callback_query_message: true },
    };
    const result = await app.inject({
      method: 'POST',
      url: '/admin/telegram/api/sendMessage',
      headers: admin,
      payload: parameters,
    });
    expect(result.statusCode, result.body).toBe(200);
    expect(sender.send).toHaveBeenLastCalledWith('sendMessage', parameters);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/admin/telegram/api/sendMessage',
          headers: member,
          payload: parameters,
        })
      ).statusCode,
    ).toBe(403);
  });
  it('publishes a valid OpenAPI description and DB readiness', async () => {
    const response = await app.inject({ url: '/openapi.json' });
    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.json().paths).length).toBeGreaterThan(35);
    expect((await app.inject({ url: '/health/ready' })).json()).toEqual({ ok: true });
  });
});
