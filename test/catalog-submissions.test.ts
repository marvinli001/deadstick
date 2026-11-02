import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { database } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { decrypt, digest } from '../src/crypto.js';
import { createBot } from '../src/telegram/bot.js';
import { views } from '../src/telegram/views.js';
import { claimChecks, monitorSettings, runCheck } from '../src/monitor/queue.js';
import type { CheckEndpoint } from '../src/monitor/check.js';
import { createProvider, prepareProvider } from '../src/catalog/service.js';

const connection = process.env.TEST_DATABASE_URL;
describe.skipIf(!connection)('catalog search and submission workflows', () => {
  let app: FastifyInstance, storage: ReturnType<typeof database>, root: pg.Pool;
  let userId: string, otherId: string, adminId: string;
  const config = loadConfig({
    APP_KEY: randomBytes(32).toString('base64'),
    PUBLIC_URL: 'https://deadstick.example',
    TELEGRAM_BOT_USERNAME: 'test_bot',
    TELEGRAM_BOT_TOKEN: '123:test-token',
    TELEGRAM_WEBHOOK_SECRET: 'test_webhook_secret_123456789012345',
  });
  const dbName = `deadstick_catalog_${randomBytes(6).toString('hex')}`;
  const member = { authorization: 'Bearer user-token' };
  const other = { authorization: 'Bearer other-token' };
  const admin = { authorization: 'Bearer admin-token' };
  const website = 'https://new.example.com';
  const subscription = 'https://private-sub.example.com/sub?token=YOUR_PRIVATE_TOKEN';
  const input = (name = '全中文机场') => ({
    name,
    endpoints: [
      { kind: 'website', url: website },
      { kind: 'subscription', url: subscription },
    ],
  });
  const post = (url: string, payload: unknown, headers = member) =>
    app.inject({ method: 'POST', url, headers, payload: payload as never });
  const review = (id: string, action: string, reason = '已核对公开资料', revision?: number) =>
    post(
      `/admin/submissions/${id}/review`,
      { action, reason, ...(revision === undefined ? {} : { revision }) },
      admin,
    );
  async function provider(
    name = '白菊机场',
    slug = 'white-cloud',
    host = 'https://www.white.example.com',
    aliases: string[] = [],
  ) {
    return storage.db.transaction((tx) =>
      createProvider(
        tx,
        prepareProvider(
          {
            name,
            slug,
            aliases,
            endpoints: [
              { kind: 'website', url: host },
              { kind: 'subscription', url: subscription },
            ],
          },
          config,
        ),
        adminId,
      ),
    );
  }
  async function check(providerId: string, ok: boolean) {
    await storage.db.query('INSERT INTO check_jobs(provider_id,dedupe_key) VALUES ($1,$2)', [
      providerId,
      randomUUID(),
    ]);
    const [job] = await claimChecks(storage.db, 1);
    const endpointCheck: CheckEndpoint = async (endpoint) => ({
      endpointId: endpoint.id,
      kind: endpoint.kind,
      ok,
      latencyMs: 1,
      errorCode: ok ? undefined : 'HTTP_503',
    });
    await runCheck(storage.db, config, job!, await monitorSettings(storage.db), endpointCheck);
    expect(
      (await storage.db.query('SELECT status FROM check_jobs WHERE id=$1', [job!.id]))[0]!.status,
    ).toBe('done');
  }
  beforeAll(async () => {
    root = new pg.Pool({ connectionString: connection });
    await root.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(connection!);
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
    app = await buildApp(storage.db, config, { logger: false });
    await app.ready();
    await storage.db.query(
      'TRUNCATE users,providers,telegram_chats,notifications RESTART IDENTITY CASCADE',
    );
    const rows = await storage.db.query<{ id: string }>(
      "INSERT INTO users(display_name,role,telegram_id) VALUES ('投稿人','user','200'),('其他人','user','201'),('审核员','admin','100') RETURNING id",
    );
    [userId, otherId, adminId] = rows.map((r) => r.id) as [string, string, string];
    for (const [token, id] of [
      ['user-token', userId],
      ['other-token', otherId],
      ['admin-token', adminId],
    ])
      await storage.db.query(
        "INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES ($1,$2,'test-csrf',now()+interval '1 day')",
        [digest(token!), id],
      );
    await storage.db.query(
      "INSERT INTO telegram_chats(id,title,kind) VALUES ('100','审核','admin')",
    );
  });
  it('orders exact names, aliases, domains and partial matches identically in REST and bot views', async () => {
    const exact = await provider('白菊', 'bai-ju', 'https://one.example.com');
    const alias = await provider('别名机场', 'alias-cloud', 'https://two.example.com', [
      '白菊',
      '旧机场',
    ]);
    await provider('白菊后援会', 'fan-cloud', 'https://three.example.com');
    await storage.db.query(
      "UPDATE providers SET lifecycle='dead',death_at=now() WHERE slug='fan-cloud'",
    );
    const result = await app.inject({ url: '/providers?q=' + encodeURIComponent('白菊') });
    const ids = result.json().items.map((p: { id: string }) => p.id);
    expect(ids.slice(0, 2)).toEqual([exact.id, alias.id]);
    const v = views(storage.db, config);
    expect((await v.search('白菊', 20)).map((p) => p.id)).toEqual(ids);
    expect(await v.find('白菊')).toBeUndefined();
    expect((await v.find('旧机场'))?.id).toBe(alias.id);
    const url = 'https://www.one.example.com/sub?token=YOUR_PRIVATE_TOKEN';
    const domain = await app.inject({ url: '/providers?q=' + encodeURIComponent(url) });
    expect(domain.json().items.map((p: { id: string }) => p.id)).toEqual([exact.id]);
    expect((await v.find(url))?.id).toBe(exact.id);
    const shared = await provider('同官网', 'shared-cloud', 'https://one.example.com');
    expect(await v.find(url)).toBeUndefined();
    expect((await v.search(url, 20)).map((p) => p.id).sort()).toEqual([exact.id, shared.id].sort());
    for (const query of ['private-sub.example.com', 'YOUR_PRIVATE_TOKEN', '%']) {
      const response = await app.inject({ url: '/providers?q=' + encodeURIComponent(query) });
      expect(response.json().items).toEqual([]);
      expect(await v.search(query, 20)).toEqual([]);
    }
    expect(result.body).not.toContain('YOUR_PRIVATE_TOKEN');
    expect(result.body).not.toContain('private-sub');
  });
  it('never echoes URL paths or tokens in search replies, buttons, deep links or guest results, and keeps ambiguous guests unselected', async () => {
    await provider('白菊一号', 'white-one', 'https://white.example.com');
    await provider('白菊二号', 'white-two', 'https://white.example.com');
    const bot = createBot(storage.db, config, {
      id: 123,
      is_bot: true,
      first_name: 'Test',
      username: 'test_bot',
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: true,
      can_connect_to_business: false,
      has_main_web_app: true,
      has_topics_enabled: false,
      allows_users_to_create_topics: false,
      can_manage_bots: false,
      supports_join_request_queries: false,
    });
    const calls: { method: string; payload: unknown }[] = [];
    bot.api.config.use(async (_prev, method, payload) => {
      calls.push({ method, payload });
      return {
        ok: true,
        result: method.startsWith('send')
          ? { message_id: 1, date: 1, chat: { id: 200, type: 'private' } }
          : true,
      } as never;
    });
    const from = { id: 200, is_bot: false, first_name: 'Test' };
    const raw = 'https://white.example.com/private/path?token=YOUR_PRIVATE_TOKEN';
    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 1,
        from,
        chat: { id: 200, type: 'private' },
        text: `/search ${raw}`,
        entities: [{ type: 'bot_command', offset: 0, length: 7 }],
      },
    } as never);
    await bot.handleUpdate({
      update_id: 2,
      guest_message: {
        message_id: 2,
        date: 1,
        guest_query_id: 'guest-multi',
        from,
        chat: { id: -100123, type: 'supergroup', title: 'Test' },
        text: `@test_bot ${raw}`,
      },
    } as never);
    await bot.handleUpdate({
      update_id: 3,
      guest_message: {
        message_id: 3,
        date: 1,
        guest_query_id: 'guest-none',
        from,
        chat: { id: -100123, type: 'supergroup', title: 'Test' },
        text: '@test_bot https://not-found.example.com/private/path?token=YOUR_PRIVATE_TOKEN',
      },
    } as never);
    const serialized = JSON.stringify(calls);
    expect(serialized).not.toContain('YOUR_PRIVATE_TOKEN');
    expect(serialized).not.toContain('/private/path');
    expect(serialized).not.toContain(Buffer.from(raw).toString('base64url'));
    expect(serialized).toContain(Buffer.from('white.example.com').toString('base64url'));
    const multi = calls.find(
      (call) =>
        call.method === 'answerGuestQuery' &&
        (call.payload as { guest_query_id: string }).guest_query_id === 'guest-multi',
    )!;
    expect(JSON.stringify(multi.payload)).toContain('找到多个机场');
    expect(JSON.stringify(multi.payload)).not.toContain('white-one');
    expect(JSON.stringify(multi.payload)).not.toContain('white-two');
  });
  it('generates unique valid slugs for Chinese-only submissions and preserves old API slugs', async () => {
    const a = await post('/submissions', input());
    expect(a.statusCode, a.body).toBe(201);
    const stored = (
      await storage.db.query<{
        payload: { slug: string; endpoints: { kind: string; url_ciphertext: string }[] };
      }>('SELECT payload FROM submissions WHERE id=$1', [a.json().id])
    )[0]!.payload;
    expect(stored.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(stored.endpoints.find((e) => e.kind === 'subscription')!.url_ciphertext).not.toContain(
      'YOUR_PRIVATE_TOKEN',
    );
    expect(
      decrypt(
        stored.endpoints.find((e) => e.kind === 'subscription')!.url_ciphertext,
        config.appKey,
      ),
    ).toBe(subscription);
    const approved = await review(a.json().id, 'approved');
    expect(approved.statusCode, approved.body).toBe(200);
    const b = await post('/submissions', {
      name: '另一中文机场',
      endpoints: [{ kind: 'website', url: 'https://another.example.com' }],
    });
    expect(b.statusCode, b.body).toBe(201);
    const second = (
      await storage.db.query<{ payload: { slug: string } }>(
        'SELECT payload FROM submissions WHERE id=$1',
        [b.json().id],
      )
    )[0]!.payload;
    expect(second.slug).not.toBe(stored.slug);
    const legacy = await post('/submissions', {
      name: '旧接口',
      slug: 'legacy-cloud',
      endpoints: [{ kind: 'website', url: 'https://legacy.example.com' }],
    });
    expect(legacy.statusCode, legacy.body).toBe(201);
    expect(
      (
        await storage.db.query<{ payload: { slug: string } }>(
          'SELECT payload FROM submissions WHERE id=$1',
          [legacy.json().id],
        )
      )[0]!.payload.slug,
    ).toBe('legacy-cloud');
  });
  it('identifies existing names, maintained aliases and public domains before submission and blocks pending duplicates', async () => {
    const p = await provider('已有机场', 'existing-cloud', website, ['以前的名字']);
    for (const body of [
      { name: '以前的名字' },
      { name: '另一名字', website: website + '/path?token=YOUR_PRIVATE_TOKEN' },
    ]) {
      const checked = await post('/submissions/check', body);
      expect(checked.statusCode, checked.body).toBe(200);
      expect(checked.json().items.map((p: { id: string }) => p.id)).toEqual([p.id]);
      expect(checked.body).not.toContain('token=');
    }
    const duplicate = await post('/submissions', input('已有机场'));
    expect(duplicate.statusCode, duplicate.body).toBe(409);
    const first = await post('/submissions', {
      name: '排队机场',
      endpoints: [{ kind: 'website', url: 'https://pending.example.com' }],
    });
    expect(first.statusCode, first.body).toBe(201);
    const pending = await post('/submissions', {
      name: '排队机场',
      endpoints: [{ kind: 'website', url: 'https://different.example.com' }],
    });
    expect(pending.statusCode, pending.body).toBe(409);
  });
  function revisionBot() {
    const bot = createBot(storage.db, config, {
      id: 123,
      is_bot: true,
      first_name: 'Test',
      username: 'test_bot',
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: true,
      can_connect_to_business: false,
      has_main_web_app: true,
      has_topics_enabled: false,
      allows_users_to_create_topics: false,
      can_manage_bots: false,
      supports_join_request_queries: false,
    });
    const calls: { method: string; payload: Record<string, unknown> }[] = [];
    bot.api.config.use(async (_prev, method, payload) => {
      calls.push({ method, payload: payload as Record<string, unknown> });
      return {
        ok: true,
        result: method.startsWith('send')
          ? { message_id: 1, date: 1, chat: { id: 100, type: 'private' } }
          : true,
      } as never;
    });
    let updateId = 1;
    const from = { id: 100, is_bot: false, first_name: 'Reviewer' };
    const chat = { id: 100, type: 'private', first_name: 'Reviewer' };
    return {
      calls,
      press: (data: string) =>
        bot.handleUpdate({
          update_id: updateId++,
          callback_query: {
            id: `cb${updateId}`,
            from,
            chat_instance: 'test',
            data,
            message: { message_id: 1, date: 1, chat, text: 'card' },
          },
        } as never),
      reply: (prompt: string, body = '旧资料不完整') =>
        bot.handleUpdate({
          update_id: updateId++,
          message: {
            message_id: updateId,
            date: 1,
            from,
            chat,
            text: body,
            reply_to_message: {
              message_id: 1,
              date: 1,
              chat,
              from: { id: 123, is_bot: true, first_name: 'Test' },
              text: prompt,
            },
          },
        } as never),
    };
  }
  async function supplement(id: string, revision = 1) {
    const request = await post(
      `/admin/submissions/${id}/review`,
      { action: 'needs_info', reason: '请补充资料', ...(revision === 1 ? {} : { revision }) },
      admin,
    );
    expect(request.statusCode, request.body).toBe(200);
    const response = await app.inject({
      method: 'PUT',
      url: `/submissions/${id}`,
      headers: member,
      payload: input('补交后的机场'),
    });
    expect(response.statusCode, response.body).toBe(200);
  }
  const submissionState = async (id: string) =>
    (await app.inject({ url: `/admin/submissions?id=${id}`, headers: admin })).json().items[0];
  it.each([{ approve: true }, { action: 'approved' }])(
    'keeps initial reviews without revision compatible with %j',
    async (decision) => {
      const submitted = await post('/submissions', input());
      const response = await post(
        `/admin/submissions/${submitted.json().id}/review`,
        { ...decision, reason: '首次审核通过' },
        admin,
      );
      expect(response.statusCode, response.body).toBe(200);
    },
  );
  it('rejects stale and omitted revisions in both API review shapes, while a current version can be reviewed', async () => {
    const submitted = await post('/submissions', input());
    const id = submitted.json().id;
    await supplement(id);
    const stalePage = await submissionState(id);
    expect(stalePage).toMatchObject({ status: 'pending', revision: 2 });
    for (const decision of [
      { approve: true },
      { approve: false },
      { action: 'approved' },
      { action: 'rejected' },
      { action: 'needs_info' },
    ]) {
      for (const version of [{}, { revision: 1 }]) {
        const response = await post(
          `/admin/submissions/${id}/review`,
          { ...decision, ...version, reason: '基于旧资料的意见' },
          admin,
        );
        expect(response.statusCode, response.body).toBe(409);
        expect(response.json().error.message).toContain('刷新审核');
      }
    }
    expect(await submissionState(id)).toMatchObject({ status: 'pending', revision: 2 });
    expect(await storage.db.query('SELECT id FROM providers')).toHaveLength(0);
    const response = await post(
      `/admin/submissions/${id}/review`,
      { action: 'approved', reason: '看过补交资料', revision: stalePage.revision },
      admin,
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(await submissionState(id)).toMatchObject({ status: 'approved', revision: 2 });
  });
  it('keeps a new revision cached on an earlier page stale after another supplement', async () => {
    const submitted = await post('/submissions', input());
    const id = submitted.json().id;
    await supplement(id);
    await supplement(id, 2);
    const stale = await post(
      `/admin/submissions/${id}/review`,
      { approve: false, reason: '第二版的旧意见', revision: 2 },
      admin,
    );
    expect(stale.statusCode, stale.body).toBe(409);
    expect(await submissionState(id)).toMatchObject({ status: 'pending', revision: 3 });
    const current = await post(
      `/admin/submissions/${id}/review`,
      { approve: false, reason: '看过第三版', revision: 3 },
      admin,
    );
    expect(current.statusCode, current.body).toBe(200);
  });
  it('encodes the seen revision in reviewer notifications and views, and rejects old approval or rejection buttons', async () => {
    const submitted = await post('/submissions', input());
    const id = submitted.json().id;
    const initialView = await views(storage.db, config).submission(0);
    expect(JSON.stringify(initialView.markup)).toContain(`sb:a:${id}:1`);
    expect(JSON.stringify(initialView.markup)).toContain(`sb:r:${id}:1`);
    await supplement(id);
    const currentView = await views(storage.db, config).submission(0);
    expect(JSON.stringify(currentView.markup)).toContain(`sb:a:${id}:2`);
    const [notice] = await storage.db.query<{ payload: unknown }>(
      'SELECT payload FROM notifications WHERE dedupe_key=$1',
      [`submission:${id}:2:100`],
    );
    expect(JSON.stringify(notice!.payload)).toContain(`sb:a:${id}:2`);
    const bot = revisionBot();
    for (const action of ['a', 'r'])
      for (const suffix of ['', ':1']) {
        const start = bot.calls.length;
        await bot.press(`sb:${action}:${id}${suffix}`);
        expect(await submissionState(id)).toMatchObject({ status: 'pending', revision: 2 });
        expect(bot.calls.slice(start)).toContainEqual(
          expect.objectContaining({
            method: 'answerCallbackQuery',
            payload: expect.objectContaining({ text: expect.stringContaining('刷新审核') }),
          }),
        );
        expect(
          bot.calls
            .slice(start)
            .some((call) => call.method === 'sendMessage' && call.payload.reply_markup),
        ).toBe(false);
      }
    await bot.press(`sb:a:${id}:2`);
    expect(await submissionState(id)).toMatchObject({ status: 'approved', revision: 2 });
  });
  it('still accepts a legacy initial approval button', async () => {
    const submitted = await post('/submissions', input());
    const id = submitted.json().id;
    await revisionBot().press(`sb:a:${id}`);
    expect(await submissionState(id)).toMatchObject({ status: 'approved', revision: 1 });
  });
  it('binds force-reply rejection to its original revision, including prompts from legacy buttons', async () => {
    const submitted = await post('/submissions', input());
    const id = submitted.json().id;
    const bot = revisionBot();
    await bot.press(`sb:r:${id}`);
    const firstPrompt = String(
      bot.calls.find((call) => call.method === 'sendMessage')!.payload.text,
    ).replace(/<[^>]+>/g, '');
    await supplement(id);
    for (const prompt of [firstPrompt, `驳回单：${id}`]) {
      const start = bot.calls.length;
      await bot.reply(prompt);
      expect(await submissionState(id)).toMatchObject({ status: 'pending', revision: 2 });
      expect(JSON.stringify(bot.calls.slice(start))).toContain('刷新审核');
    }
    expect(firstPrompt).toContain(`驳回单：${id} 1`);
    bot.calls.length = 0;
    await bot.press(`sb:r:${id}:2`);
    const secondPrompt = String(
      bot.calls.find((call) => call.method === 'sendMessage')!.payload.text,
    ).replace(/<[^>]+>/g, '');
    expect(secondPrompt).toContain(`驳回单：${id} 2`);
    await supplement(id, 2);
    await bot.reply(secondPrompt);
    expect(await submissionState(id)).toMatchObject({ status: 'pending', revision: 3 });
    bot.calls.length = 0;
    await bot.press(`sb:r:${id}:3`);
    const currentPrompt = String(
      bot.calls.find((call) => call.method === 'sendMessage')!.payload.text,
    ).replace(/<[^>]+>/g, '');
    await bot.reply(currentPrompt, '第三版仍需驳回');
    expect(await submissionState(id)).toMatchObject({
      status: 'rejected',
      revision: 3,
      reason: '第三版仍需驳回',
    });
  });
  it('supports needs-info, private owner reads, owner-only supplement, repeated reviews and result notifications', async () => {
    const submitted = await post('/submissions', input());
    const id = submitted.json().id;
    const response = await review(id, 'needs_info', '<补一下> 官网信息');
    expect(response.statusCode, response.body).toBe(200);
    const mine = await app.inject({ url: '/submissions/mine', headers: member });
    expect(mine.json().items[0]).toMatchObject({
      id,
      status: 'needs_info',
      reason: '<补一下> 官网信息',
      subscription_count: 1,
    });
    for (const text of [
      mine.body,
      (await app.inject({ url: `/submissions/${id}`, headers: member })).body,
      (await app.inject({ url: `/admin/submissions?id=${id}`, headers: admin })).body,
    ]) {
      expect(text).not.toContain('url_ciphertext');
      expect(text).not.toContain('private-sub');
      expect(text).not.toContain('YOUR_PRIVATE_TOKEN');
    }
    expect((await app.inject({ url: `/submissions/${id}`, headers: other })).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/submissions/${id}`,
          headers: other,
          payload: input(),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await post(
          `/admin/submissions/${id}/review`,
          { action: 'approved', reason: '越权' },
          member,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ url: `/admin/submissions?id=${id}`, headers: member })).statusCode,
    ).toBe(403);
    expect((await app.inject({ url: '/submissions/mine', headers: other })).json().items).toEqual(
      [],
    );
    const update = await app.inject({
      method: 'PUT',
      url: `/submissions/${id}`,
      headers: member,
      payload: { name: '补好资料的机场', endpoints: [{ kind: 'website', url: website }] },
    });
    expect(update.statusCode, update.body).toBe(200);
    const again = await review(id, 'needs_info', '再补一条', 2);
    expect(again.statusCode, again.body).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/submissions/${id}`,
          headers: member,
          payload: input(),
        })
      ).statusCode,
    ).toBe(200);
    expect((await review(id, 'approved', '已核对公开资料', 3)).statusCode).toBe(200);
    expect((await review(id, 'approved', '已核对公开资料', 3)).statusCode).toBe(409);
    const notices = JSON.stringify(
      await storage.db.query('SELECT dedupe_key,payload FROM notifications'),
    );
    expect(notices).toContain('投稿待补充');
    expect(notices).toContain('投稿已通过');
    expect(notices).toContain('&lt;补一下&gt;');
    expect(notices).not.toContain('YOUR_PRIVATE_TOKEN');
    expect(notices).not.toContain('private-sub');
    const count = (
      await storage.db.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM notifications WHERE dedupe_key LIKE 'submission-result:%'",
      )
    )[0]!.count;
    expect(count).toBe(3);
    const endpoints = await storage.db.query(
      "SELECT kind FROM endpoints WHERE kind='subscription'",
    );
    expect(endpoints).toHaveLength(1);
  });
  it('holds website changes for review and protects lead targets and owner resubmission', async () => {
    const p = await provider();
    const lead = await post(`/providers/${p.id}/submissions`, {
      kind: 'website',
      body: '官网搬到了新域名',
      website: 'https://new-site.example.com/path?token=REMOVE_ME',
    });
    expect(lead.statusCode, lead.body).toBe(201);
    expect(
      await storage.db.query("SELECT id FROM endpoints WHERE display_host='new-site.example.com'"),
    ).toEqual([]);
    expect(
      (await storage.db.query('SELECT lifecycle FROM providers WHERE id=$1', [p.id]))[0]!.lifecycle,
    ).toBe('active');
    const id = lead.json().id;
    await review(id, 'needs_info', '补个公开来源');
    const update = {
      kind: 'website',
      body: '公开公告确认过了',
      website: 'https://new-site.example.com/path?token=REMOVE_ME',
      evidenceUrls: ['https://evidence.example.com/post?token=REMOVE_ME'],
    };
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/submissions/${id}`,
          headers: other,
          payload: update,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/submissions/${id}`,
          headers: member,
          payload: update,
        })
      ).statusCode,
    ).toBe(200);
    expect((await review(id, 'approved', '已核对公开资料', 2)).statusCode).toBe(200);
    expect(
      await storage.db.query(
        "SELECT public_url FROM endpoints WHERE display_host='new-site.example.com'",
      ),
    ).toEqual([{ public_url: 'https://new-site.example.com/path' }]);
    expect(
      (await storage.db.query('SELECT lifecycle FROM providers WHERE id=$1', [p.id]))[0]!.lifecycle,
    ).toBe('active');
    const audit = await storage.db.query('SELECT action FROM audit_log WHERE target_id=$1', [p.id]);
    expect(audit).toContainEqual({ action: 'provider.update' });
  });
  it.each(['abnormal', 'evidence', 'review'])(
    'keeps %s leads private until reviewer acceptance and explicit resolution',
    async (kind) => {
      const p = await provider();
      const evidence = 'https://evidence.example.com/public-post';
      const lead = await post(`/providers/${p.id}/submissions`, {
        kind,
        body: `连续两天无法连接，私有线索 ${subscription}`,
        evidenceUrls: [evidence],
      });
      expect(lead.statusCode, lead.body).toBe(201);
      const id = lead.json().id;
      const pendingView = await views(storage.db, config).submission(0);
      expect(pendingView.text).not.toContain('YOUR_PRIVATE_TOKEN');
      expect(pendingView.text).not.toContain('private-sub.example.com');
      expect((await app.inject({ url: `/providers/${p.id}` })).json().incidents).toEqual([]);
      expect((await review(id, 'approved')).statusCode).toBe(200);
      const detail = (await app.inject({ url: `/providers/${p.id}` })).json();
      expect(detail.lifecycle).toBe('suspected');
      expect(detail.incidents[0].evidence_urls).toEqual([]);
      expect(JSON.stringify(detail)).not.toContain(evidence);
      expect(JSON.stringify(detail)).not.toContain('YOUR_PRIVATE_TOKEN');
      expect(
        JSON.stringify(await storage.db.query('SELECT payload FROM notifications')),
      ).not.toContain('YOUR_PRIVATE_TOKEN');
      const resolve = await post(
        `/admin/incidents/${detail.incidents[0].id}/resolve`,
        { action: 'dead', reason: '人工核验属实', evidenceUrls: [evidence] },
        admin,
      );
      expect(resolve.statusCode, resolve.body).toBe(200);
      expect((await app.inject({ url: `/providers/${p.id}` })).json().lifecycle).toBe('dead');
      const queued = await storage.db.query<{ payload: unknown }>(
        'SELECT payload FROM notifications WHERE subject=$1',
        [`submission:${id}`],
      );
      expect(JSON.stringify(queued)).not.toContain('sb:a:');
    },
  );
  it('preserves manual incidents through healthy checks, links additional leads and resolves through the existing review action', async () => {
    const p = await provider();
    const first = await post(`/providers/${p.id}/submissions`, {
      kind: 'abnormal',
      body: '人工线索，请核对公告',
    });
    const accepted = await review(first.json().id, 'approved');
    const incidentId = accepted.json().incidentId;
    expect(incidentId).toBeTruthy();
    await check(p.id, true);
    const detail = (await app.inject({ url: `/providers/${p.id}` })).json();
    expect(detail).toMatchObject({ health: 'healthy', lifecycle: 'suspected' });
    expect(detail.incidents[0].status).toBe('open');
    const second = await post(`/providers/${p.id}/submissions`, {
      kind: 'evidence',
      body: '另一条补充线索',
    });
    expect((await review(second.json().id, 'approved')).json().incidentId).toBe(incidentId);
    expect(
      await storage.db.query('SELECT id FROM incidents WHERE provider_id=$1', [p.id]),
    ).toHaveLength(1);
    const queue = await app.inject({ url: `/admin/incidents?id=${incidentId}`, headers: admin });
    expect(
      queue
        .json()
        .items[0].leads.map((lead: { id: string }) => lead.id)
        .sort(),
    ).toEqual([first.json().id, second.json().id].sort());
    expect(
      (await app.inject({ url: `/admin/incidents?id=${incidentId}`, headers: other })).statusCode,
    ).toBe(403);
    const resolved = await post(
      `/admin/incidents/${incidentId}/resolve`,
      {
        action: 'dismissed',
        reason: '已人工排除异常',
        evidenceUrls: ['https://evidence.example.com/checked'],
      },
      admin,
    );
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect((await app.inject({ url: `/providers/${p.id}` })).json().lifecycle).toBe('active');
  });
  it('still automatically resolves monitor incidents and promotes an existing monitor incident when a lead is accepted', async () => {
    const p = await provider();
    await check(p.id, false);
    await check(p.id, false);
    let detail = (await app.inject({ url: `/providers/${p.id}` })).json();
    const automaticId = detail.incidents[0].id;
    await check(p.id, true);
    detail = (await app.inject({ url: `/providers/${p.id}` })).json();
    expect(detail.lifecycle).toBe('active');
    expect(detail.incidents[0].status).toBe('resolved');
    await check(p.id, false);
    await check(p.id, false);
    const [open] = await storage.db.query<{ id: string }>(
      "SELECT id FROM incidents WHERE provider_id=$1 AND status='open'",
      [p.id],
    );
    expect(open!.id).not.toBe(automaticId);
    const lead = await post(`/providers/${p.id}/submissions`, {
      kind: 'review',
      body: '健康以外还有线索',
    });
    expect((await review(lead.json().id, 'approved')).json().incidentId).toBe(open!.id);
    await check(p.id, true);
    expect(
      (
        await storage.db.query('SELECT status,manual_review FROM incidents WHERE id=$1', [open!.id])
      )[0],
    ).toEqual({ status: 'open', manual_review: true });
    expect(
      (await storage.db.query('SELECT health,lifecycle FROM providers WHERE id=$1', [p.id]))[0],
    ).toEqual({ health: 'healthy', lifecycle: 'suspected' });
  });
  it.each(['dismissed', 'dead', 'recovered', 'revive'])(
    'preserves confirmed death and only revives through an explicit manual action: %s',
    async (action) => {
      const p = await provider();
      const deathAt = '2026-01-02T03:04:05.000Z';
      await storage.db.query(
        "UPDATE providers SET lifecycle='dead',health='down',death_at=$2,epitaph='原墓志铭' WHERE id=$1",
        [p.id, deathAt],
      );
      await storage.db.query(
        `INSERT INTO telegram_chats(id,title,kind,notification_policy)
        VALUES ('-100123','通报群','group','{"enabled":true}')`,
      );
      const lead = await post(`/providers/${p.id}/submissions`, {
        kind: 'review',
        body: '官网重新开始营业了',
      });
      expect(lead.statusCode, lead.body).toBe(201);
      const accepted = await review(lead.json().id, 'approved');
      expect(accepted.statusCode, accepted.body).toBe(200);
      const incidentId = accepted.json().incidentId;
      const detail = (await app.inject({ url: `/providers/${p.id}` })).json();
      expect(detail.lifecycle).toBe('dead');
      expect(detail.incidents[0].status).toBe('open');
      const resolution = {
        reason: '人工核对本次线索',
        evidenceUrls: ['https://evidence.example.com/checked'],
      };
      const result =
        action === 'revive'
          ? await post(`/admin/providers/${p.id}/revive`, resolution, admin)
          : await post(`/admin/incidents/${incidentId}/resolve`, { ...resolution, action }, admin);
      expect(result.statusCode, result.body).toBe(200);
      const updated = (await app.inject({ url: `/providers/${p.id}` })).json();
      const revived = action === 'recovered' || action === 'revive';
      expect(updated.lifecycle).toBe(revived ? 'active' : 'dead');
      expect(updated.death_at).toBe(revived ? null : deathAt);
      expect(updated.epitaph).toBe(revived ? null : '原墓志铭');
      expect(
        updated.incidents.find((incident: { id: string }) => incident.id === incidentId).status,
      ).toBe(
        action === 'dismissed' ? 'dismissed' : action === 'dead' ? 'confirmed_dead' : 'resolved',
      );
      if (revived) {
        expect(updated.health).toBe('unknown');
        const notices = await storage.db.query<{ type: string }>(
          "SELECT event_meta->>'type' AS type FROM notifications WHERE chat_id='-100123' AND event_meta IS NOT NULL",
        );
        expect(notices).toContainEqual({ type: 'revival' });
        expect(notices).not.toContainEqual({ type: 'recovery' });
        await check(p.id, true);
        expect((await app.inject({ url: `/providers/${p.id}` })).json().lifecycle).toBe('active');
      }
    },
  );
  it('rejects status injection, internal URLs and malformed supplement kinds', async () => {
    const p = await provider();
    const invalid = await post(`/providers/${p.id}/submissions`, {
      kind: 'abnormal',
      body: '变更状态',
      lifecycle: 'dead',
    });
    expect(invalid.statusCode).toBe(400);
    const unsafe = await post(`/providers/${p.id}/submissions`, {
      kind: 'website',
      body: '内网地址',
      website: 'http://127.0.0.1',
    });
    expect(unsafe.statusCode).toBe(400);
    const blank = await post(`/providers/${p.id}/submissions`, { kind: 'review', body: '   ' });
    expect(blank.statusCode).toBe(400);
    const lead = await post(`/providers/${p.id}/submissions`, {
      kind: 'abnormal',
      body: '有异常情况',
    });
    await review(lead.json().id, 'needs_info');
    const mismatch = await app.inject({
      method: 'PUT',
      url: `/submissions/${lead.json().id}`,
      headers: member,
      payload: input(),
    });
    expect(mismatch.statusCode).toBe(400);
  });
});
