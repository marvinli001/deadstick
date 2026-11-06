import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { database } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { decrypt, digest, hashPassword } from '../src/crypto.js';

const connection = process.env.TEST_DATABASE_URL;
describe.skipIf(!connection)('administrator OAuth MCP', () => {
  let app: FastifyInstance, storage: ReturnType<typeof database>, root: pg.Pool;
  let adminId: string, memberId: string;
  let passwordHash: string;
  const dbName = `deadstick_mcp_${randomBytes(6).toString('hex')}`;
  const config = loadConfig({
    APP_KEY: randomBytes(32).toString('base64'),
    PUBLIC_URL: 'http://localhost:3000',
  });
  const admin = { cookie: 'session=mcp-admin', 'x-csrf-token': 'mcp-admin-csrf' };
  const member = { cookie: 'session=mcp-member', 'x-csrf-token': 'mcp-member-csrf' };
  const moderator = { cookie: 'session=mcp-moderator', 'x-csrf-token': 'mcp-moderator-csrf' };
  const callback = 'http://127.0.0.1:51431/callback';
  const provider = (slug: string) => ({
    name: `机场 ${slug}`,
    slug,
    endpoints: [
      { kind: 'website', url: `https://${slug}.example.com/` },
      {
        kind: 'subscription',
        url: `https://sub.example.com/${slug}?token=test-subscription-secret`,
      },
    ],
  });

  beforeAll(async () => {
    root = new pg.Pool({ connectionString: connection });
    await root.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(connection!);
    url.pathname = `/${dbName}`;
    storage = database(url.href);
    await migrate(storage.db);
    await migrate(storage.db);
    passwordHash = await hashPassword('test-password-long');
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
    await storage.db.query(
      'TRUNCATE mcp_clients,users,providers,notifications RESTART IDENTITY CASCADE',
    );
    for (const [name, role] of [
      ['admin', 'admin'],
      ['member', 'user'],
      ['moderator', 'moderator'],
    ] as const) {
      const [user] = await storage.db.query<{ id: string }>(
        'INSERT INTO users(email,password_hash,display_name,role) VALUES ($1,$2,$3,$4) RETURNING id',
        [`${name}@example.com`, passwordHash, name, role],
      );
      await storage.db.query(
        "INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES ($1,$2,$3,now()+interval '1 day')",
        [digest(`mcp-${name}`), user!.id, `mcp-${name}-csrf`],
      );
      if (role === 'admin') adminId = user!.id;
      if (role === 'user') memberId = user!.id;
    }
    app = await buildApp(storage.db, config, { logger: false });
    await app.ready();
  });

  async function register(redirect = callback) {
    const response = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: {
        client_name: 'MCP integration',
        redirect_uris: [redirect],
        token_endpoint_auth_method: 'none',
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json().client_id as string;
  }
  async function start(clientId: string, options: Record<string, string> = {}) {
    const verifier = randomBytes(32).toString('base64url');
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: callback,
      response_type: 'code',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state: 'client-state',
      resource: `${config.publicUrl}/mcp`,
      ...options,
    });
    const response = await app.inject({ url: `/oauth/authorize?${query}` });
    expect(response.statusCode).toBe(302);
    const request = new URL(response.headers.location!, config.publicUrl).searchParams.get(
      'request',
    )!;
    return { request, verifier };
  }
  async function form(path: string, body: Record<string, string>) {
    return app.inject({
      method: 'POST',
      url: path,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams(body).toString(),
    });
  }
  async function approve(request: string, approved = true) {
    const response = await app.inject({
      method: 'POST',
      url: `/auth/mcp/request/${request}`,
      headers: admin,
      payload: { approved },
    });
    expect(response.statusCode).toBe(200);
    return new URL(response.json().redirect as string);
  }
  async function grant() {
    const clientId = await register();
    const { request, verifier } = await start(clientId);
    const redirect = await approve(request);
    const response = await form('/oauth/token', {
      grant_type: 'authorization_code',
      client_id: clientId,
      code: redirect.searchParams.get('code')!,
      redirect_uri: callback,
      code_verifier: verifier,
      resource: `${config.publicUrl}/mcp`,
    });
    expect(response.statusCode).toBe(200);
    const credentials = response.json<{
      access_token: string;
      refresh_token: string;
    }>();
    return { ...credentials, clientId };
  }
  async function rpc(access: string, name: string, args: Record<string, unknown> = {}) {
    return app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: `Bearer ${access}`,
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
      },
      payload: {
        jsonrpc: '2.0',
        id: randomUUID(),
        method: 'tools/call',
        params: { name, arguments: args },
      },
    });
  }
  async function call<T = Record<string, unknown>>(
    access: string,
    name: string,
    args: Record<string, unknown> = {},
  ) {
    const response = await rpc(access, name, args);
    expect(response.statusCode).toBe(200);
    expect(response.json().error).toBeUndefined();
    return {
      failed: response.json().result.isError as boolean,
      data: response.json().result.structuredContent as T,
    };
  }

  it('advertises OAuth discovery and never accepts a browser session as an MCP token', async () => {
    const unauthorized = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: admin,
      payload: {},
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.headers['www-authenticate']).toContain(
      '/.well-known/oauth-protected-resource/mcp',
    );
    expect(unauthorized.headers['cache-control']).toBe('no-store');
    const metadata = await app.inject({
      url: '/.well-known/oauth-protected-resource/mcp',
      headers: { origin: 'https://agent.example.com' },
    });
    expect(metadata.json()).toMatchObject({
      resource: `${config.publicUrl}/mcp`,
      scopes_supported: ['deadstick:admin'],
    });
    expect(metadata.headers['access-control-allow-origin']).toBe('*');
    const issuer = await app.inject({ url: '/.well-known/oauth-authorization-server' });
    expect(issuer.json()).toMatchObject({
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
    for (const headers of [member, moderator])
      expect((await app.inject({ url: '/admin/mcp', headers })).statusCode).toBe(403);
  });

  it('rejects unsafe callbacks, unregistered redirects, scopes, resources and missing PKCE', async () => {
    for (const redirect of [
      'javascript:alert(1)',
      'http://remote.example.com/callback',
      'https://user:secret@example.com/cb',
      'https://example.com/cb#fragment',
    ]) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/oauth/register',
            payload: { redirect_uris: [redirect] },
          })
        ).statusCode,
      ).toBe(400);
    }
    const clientId = await register();
    const verifier = randomBytes(32).toString('base64url');
    const base = {
      client_id: clientId,
      redirect_uri: callback,
      response_type: 'code',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    };
    const invalid: Record<string, string>[] = [
      { redirect_uri: 'https://other.example.com/cb' },
      { code_challenge_method: 'plain' },
      { resource: 'https://other.example.com/mcp' },
      { scope: 'telegram:admin' },
    ];
    for (const changes of invalid) {
      const response = await app.inject({
        url: `/oauth/authorize?${new URLSearchParams({ ...base, ...changes })}`,
      });
      expect(response.statusCode).toBe(400);
      expect(response.headers.location).toBeUndefined();
    }
    const variablePort = await start(clientId, { redirect_uri: 'http://127.0.0.1:59999/callback' });
    expect(variablePort.request).toHaveLength(43);
  });

  it('requires administrator consent and CSRF, binds one-time codes to client, redirect and verifier', async () => {
    const clientId = await register();
    const { request, verifier } = await start(clientId);
    expect(
      (await app.inject({ url: `/auth/mcp/request/${request}`, headers: member })).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/auth/mcp/request/${request}`,
          headers: moderator,
          payload: { approved: true },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/auth/mcp/request/${request}`,
          headers: { cookie: admin.cookie },
          payload: { approved: true },
        })
      ).statusCode,
    ).toBe(403);
    const detail = await app.inject({ url: `/auth/mcp/request/${request}`, headers: admin });
    expect(detail.json().client_name).toBe('MCP integration');
    const redirect = await approve(request);
    expect(redirect.searchParams.get('state')).toBe('client-state');
    expect(redirect.searchParams.get('iss')).toBe(config.publicUrl);
    const body = {
      grant_type: 'authorization_code',
      client_id: clientId,
      code: redirect.searchParams.get('code')!,
      redirect_uri: callback,
      code_verifier: verifier,
    };
    for (const change of [
      { code_verifier: randomBytes(32).toString('base64url') },
      { client_id: 'another-client' },
      { redirect_uri: 'http://127.0.0.1:51999/callback' },
    ]) {
      expect((await form('/oauth/token', { ...body, ...change })).json().error).toBe(
        'invalid_grant',
      );
    }
    const issued = await form('/oauth/token', body);
    expect(issued.statusCode).toBe(200);
    expect(issued.headers['cache-control']).toBe('no-store');
    expect((await form('/oauth/token', body)).json().error).toBe('invalid_grant');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/auth/mcp/request/${request}`,
          headers: admin,
          payload: { approved: true },
        })
      ).statusCode,
    ).toBe(410);
    const stored = await storage.db.query('SELECT * FROM mcp_connections');
    expect(JSON.stringify(stored)).not.toContain(issued.json().access_token);
    expect(JSON.stringify(await storage.db.query('SELECT * FROM audit_log'))).not.toContain(
      body.code,
    );
  });

  it('returns denial to the registered client and expires consent requests and codes', async () => {
    const clientId = await register();
    const denied = await start(clientId);
    const redirect = await approve(denied.request, false);
    expect(redirect.searchParams.get('error')).toBe('access_denied');
    expect(redirect.searchParams.get('code')).toBeNull();
    const expired = await start(clientId);
    await storage.db.query("UPDATE mcp_authorizations SET expires_at=now()-interval '1 second'");
    expect(
      (await app.inject({ url: `/auth/mcp/request/${expired.request}`, headers: admin }))
        .statusCode,
    ).toBe(410);
    const pending = await start(clientId);
    const approved = await approve(pending.request);
    await storage.db.query("UPDATE mcp_codes SET expires_at=now()-interval '1 second'");
    expect(
      (
        await form('/oauth/token', {
          grant_type: 'authorization_code',
          client_id: clientId,
          code: approved.searchParams.get('code')!,
          redirect_uri: callback,
          code_verifier: pending.verifier,
        })
      ).json().error,
    ).toBe('invalid_grant');
  });

  it('rotates refresh tokens, detects replay, and enforces token expiry and resource binding', async () => {
    const auth = await grant();
    await storage.db.query(
      "UPDATE mcp_connections SET access_expires_at=now()-interval '1 second'",
    );
    expect((await rpc(auth.access_token, 'overview')).statusCode).toBe(401);
    const refresh = {
      grant_type: 'refresh_token',
      client_id: auth.clientId,
      refresh_token: auth.refresh_token,
      resource: `${config.publicUrl}/mcp`,
    };
    expect(
      (await form('/oauth/token', { ...refresh, resource: 'https://other.example.com/mcp' })).json()
        .error,
    ).toBe('invalid_target');
    const response = await form('/oauth/token', refresh);
    expect(response.statusCode).toBe(200);
    expect((await call(response.json().access_token, 'overview')).failed).toBe(false);
    expect((await form('/oauth/token', refresh)).json().error).toBe('invalid_grant');
    expect((await rpc(response.json().access_token, 'overview')).statusCode).toBe(401);
    expect(
      (
        await form('/oauth/token', { ...refresh, refresh_token: response.json().refresh_token })
      ).json().error,
    ).toBe('invalid_grant');
  });

  it('revokes connections immediately through the console or OAuth endpoint', async () => {
    const auth = await grant();
    await form('/oauth/revoke', { token: auth.refresh_token, client_id: 'another-client' });
    expect((await call(auth.access_token, 'overview')).failed).toBe(false);
    await form('/oauth/revoke', { token: auth.refresh_token, client_id: auth.clientId });
    expect((await rpc(auth.access_token, 'overview')).statusCode).toBe(401);
    const second = await grant();
    const connections = await app.inject({ url: '/admin/mcp/connections', headers: admin });
    const active = connections
      .json()
      .items.find((item: { revoked_at: string | null }) => item.revoked_at === null);
    expect(active.client_name).toBe('MCP integration');
    expect(JSON.stringify(connections.json())).not.toContain(second.access_token);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/admin/mcp/connections/${active.id}`,
          headers: admin,
        })
      ).statusCode,
    ).toBe(200);
    expect((await rpc(second.access_token, 'overview')).statusCode).toBe(401);
  });

  it('speaks the real SDK protocol and blocks all Telegram, session and privilege management routes', async () => {
    const auth = await grant();
    const client = new Client({ name: 'SDK interoperability', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${config.publicUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${auth.access_token}` } },
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const response = await app.inject({
          method: (init?.method ?? 'GET') as 'GET' | 'POST' | 'DELETE',
          url: url.pathname + url.search,
          headers: Object.fromEntries(new Headers(init?.headers)),
          ...(init?.body ? { payload: String(init.body) } : {}),
        });
        return new Response(response.statusCode === 202 ? null : response.body, {
          status: response.statusCode,
          headers: response.headers as Record<string, string>,
        });
      },
    });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.some((tool) => tool.name === 'providers_import')).toBe(true);
      expect(
        listed.tools.some((tool) => /telegram|user_update|http_request|sql/i.test(tool.name)),
      ).toBe(false);
      const result = await client.callTool({ name: 'overview', arguments: {} });
      expect(result.structuredContent).toMatchObject({ total: 0 });
    } finally {
      await client.close();
    }
    for (const [method, url] of [
      ['GET', '/admin/telegram/settings'],
      ['PUT', '/admin/telegram/settings'],
      ['GET', '/admin/telegram/chats'],
      ['POST', '/admin/telegram/api/getMe'],
      ['GET', '/admin/telegram/sessions'],
      ['GET', '/admin/telegram/updates'],
      ['GET', '/auth/me'],
      ['POST', '/auth/telegram/link'],
      ['PATCH', `/admin/users/${memberId}`],
      ['GET', '/admin/mcp/connections'],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${auth.access_token}` },
        ...(method === 'POST' || method === 'PUT' || method === 'PATCH' ? { payload: {} } : {}),
      });
      expect(response.statusCode, `${method} ${url}`).toBe(403);
    }
    expect(
      (await rpc(auth.access_token, 'http_request', { path: '/admin/telegram/settings' })).json()
        .error.code,
    ).toBe(-32602);
    expect(
      (await rpc(auth.access_token, 'provider_get', { id: '../../telegram/settings' })).json().error
        .code,
    ).toBe(-32602);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/mcp',
          headers: {
            authorization: `Bearer ${auth.access_token}`,
            origin: 'https://evil.example.com',
          },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
  });

  it('imports airports atomically, encrypts subscriptions and supports partial edits and endpoint management', async () => {
    const auth = await grant();
    const created = await call<{ items: { id: string }[]; count: number }>(
      auth.access_token,
      'providers_import',
      { providers: [provider('first'), provider('second')] },
    );
    expect(created.data.count).toBe(2);
    const id = created.data.items[0]!.id;
    const stored = await storage.db.query<{ url_ciphertext: string }>(
      "SELECT url_ciphertext FROM endpoints WHERE provider_id=$1 AND kind='subscription'",
      [id],
    );
    expect(stored[0]!.url_ciphertext).not.toContain('test-subscription-secret');
    expect(decrypt(stored[0]!.url_ciphertext, config.appKey)).toContain('test-subscription-secret');
    expect(
      (
        await call(auth.access_token, 'providers_import', {
          providers: [provider('rollback'), provider('first')],
        })
      ).failed,
    ).toBe(true);
    expect(
      (
        await call(auth.access_token, 'providers_import', {
          providers: [
            provider('rollback'),
            {
              ...provider('unsafe'),
              endpoints: [{ kind: 'website', url: 'http://127.0.0.1/private' }],
            },
          ],
        })
      ).failed,
    ).toBe(true);
    expect((await call<{ total: number }>(auth.access_token, 'providers_list')).data.total).toBe(2);
    await call(auth.access_token, 'provider_edit', { id, name: '修改后' });
    expect(
      (await storage.db.query<{ name: string }>('SELECT name FROM providers WHERE id=$1', [id]))[0]!
        .name,
    ).toBe('修改后');
    const listed = await call<{ items: { id: string; kind: string }[] }>(
      auth.access_token,
      'endpoints_list',
      { id },
    );
    expect(listed.data.items).toHaveLength(2);
    expect(JSON.stringify(listed.data)).not.toContain('test-subscription-secret');
    const endpoint = { id, kind: 'website', url: 'https://mirror.example.com/' };
    expect((await call(auth.access_token, 'endpoint_add', endpoint)).failed).toBe(false);
    expect((await call(auth.access_token, 'endpoint_add', endpoint)).failed).toBe(true);
    await call(auth.access_token, 'endpoint_delete', { id, endpointId: listed.data.items[0]!.id });
    await call(auth.access_token, 'endpoint_delete', { id, endpointId: listed.data.items[1]!.id });
    const last = (
      await call<{ items: { id: string }[] }>(auth.access_token, 'endpoints_list', { id })
    ).data.items[0]!;
    expect(
      (await call(auth.access_token, 'endpoint_delete', { id, endpointId: last.id })).data,
    ).toMatchObject({ error: { code: 'ENDPOINT_REQUIRED' } });
    expect(
      (await call(auth.access_token, 'providers_delete', { ids: [id, randomUUID()] })).failed,
    ).toBe(true);
    expect((await call<{ total: number }>(auth.access_token, 'providers_list')).data.total).toBe(2);
    expect(
      (
        await call(auth.access_token, 'providers_delete', {
          ids: created.data.items.map((row) => row.id),
        })
      ).data,
    ).toMatchObject({ count: 2 });
    const audit = JSON.stringify(await storage.db.query('SELECT * FROM audit_log'));
    expect(audit).toContain('provider.delete');
    expect(audit).not.toContain('test-subscription-secret');
  });

  it('reviews and edits submissions with revision checks, then handles incidents and memorials', async () => {
    const auth = await grant();
    const submitted = await app.inject({
      method: 'POST',
      url: '/submissions',
      headers: member,
      payload: provider('submitted'),
    });
    expect(submitted.statusCode).toBe(201);
    const submissionId = submitted.json().id as string;
    expect(
      (
        await call(auth.access_token, 'submission_edit', {
          id: submissionId,
          revision: 1,
          payload: { ...provider('submitted'), description: '补充资料' },
        })
      ).failed,
    ).toBe(false);
    expect(
      (
        await call(auth.access_token, 'submission_review', {
          id: submissionId,
          action: 'approved',
          reason: '资料完整',
          revision: 1,
        })
      ).data,
    ).toMatchObject({ error: { code: 'SUBMISSION_CHANGED' } });
    const reviewed = await call<{ providerId: string }>(auth.access_token, 'submission_review', {
      id: submissionId,
      action: 'approved',
      reason: '资料完整',
      revision: 2,
    });
    expect(reviewed.failed).toBe(false);
    const id = reviewed.data.providerId;
    const incident = await call<{ id: string }>(auth.access_token, 'incident_create', {
      id,
      summary: '官网无法访问，需要人工复核',
    });
    expect(incident.failed).toBe(false);
    const incidentId = incident.data.id;
    expect(
      (
        await call(auth.access_token, 'incident_edit', {
          id: incidentId,
          summary: '官网及订阅均已停止服务',
        })
      ).failed,
    ).toBe(false);
    expect(
      (
        await call(auth.access_token, 'incident_resolve', {
          id: incidentId,
          action: 'dead',
          reason: '官网发布停止运营公告',
          evidenceUrls: ['https://evidence.example.com/notice'],
          epitaph: '停止运营',
        })
      ).failed,
    ).toBe(false);
    const memorial = await call<{ id: string }>(auth.access_token, 'memorial_create', {
      id,
      body: '曾经很好用',
    });
    expect(memorial.failed).toBe(false);
    expect(
      (await call(auth.access_token, 'memorial_moderate', { id: memorial.data.id, visible: true }))
        .failed,
    ).toBe(false);
    expect(
      (
        await call(auth.access_token, 'memorial_edit', {
          id: memorial.data.id,
          body: '谢谢曾经的服务',
        })
      ).failed,
    ).toBe(false);
    expect(
      (
        await call<{ items: { body: string }[] }>(auth.access_token, 'memorials_list', {
          status: 'visible',
        })
      ).data.items[0]!.body,
    ).toBe('谢谢曾经的服务');
    expect(
      (
        await call(auth.access_token, 'provider_revive', {
          id,
          reason: '官网发布恢复运营公告',
          evidenceUrls: ['https://evidence.example.com/recovery'],
        })
      ).failed,
    ).toBe(false);
    expect((await call(auth.access_token, 'provider_delete', { id })).failed).toBe(false);
    expect(
      await storage.db.query('SELECT id FROM incidents WHERE provider_id=$1', [id]),
    ).toHaveLength(0);
    expect(
      (
        await storage.db.query('SELECT provider_id FROM submissions WHERE id=$1', [submissionId])
      )[0]!.provider_id,
    ).toBeNull();
  });

  it('reads operational data, updates monitor settings, and queues real check jobs', async () => {
    const auth = await grant();
    for (const name of [
      'audit_list',
      'notifications_list',
      'jobs_list',
      'users_list',
      'system_health',
    ])
      expect((await call(auth.access_token, name)).failed, name).toBe(false);
    const settings = await call(auth.access_token, 'settings_get');
    expect(
      (await call(auth.access_token, 'settings_update', { ...settings.data, intervalHours: 12 }))
        .failed,
    ).toBe(false);
    expect((await call(auth.access_token, 'settings_get')).data.intervalHours).toBe(12);
    const added = await call<{ id: string }>(
      auth.access_token,
      'provider_create',
      provider('checkable'),
    );
    const queued = await call<{ id: string }>(auth.access_token, 'provider_check', {
      id: added.data.id,
    });
    expect(queued.failed).toBe(false);
    expect(
      (await storage.db.query('SELECT * FROM check_jobs WHERE id=$1', [queued.data.id]))[0]!.status,
    ).toBe('pending');
  });

  it('invalidates MCP access when the administrator is disabled or changes password', async () => {
    const auth = await grant();
    await storage.db.query('UPDATE users SET disabled=true WHERE id=$1', [adminId]);
    expect((await rpc(auth.access_token, 'overview')).statusCode).toBe(401);
    expect(
      (
        await form('/oauth/token', {
          grant_type: 'refresh_token',
          client_id: auth.clientId,
          refresh_token: auth.refresh_token,
        })
      ).json().error,
    ).toBe('invalid_grant');
    await storage.db.query('UPDATE users SET disabled=false WHERE id=$1', [adminId]);
    const password = await app.inject({
      method: 'POST',
      url: '/auth/password',
      headers: admin,
      payload: { currentPassword: 'test-password-long', newPassword: 'updated-password-long' },
    });
    expect(password.statusCode).toBe(200);
    expect((await rpc(auth.access_token, 'overview')).statusCode).toBe(401);
  });
  it('does not resurrect old connections when a demoted administrator is promoted again', async () => {
    const auth = await grant();
    const [second] = await storage.db.query<{ id: string }>(
      "INSERT INTO users(display_name,role) VALUES ('Second admin','admin') RETURNING id",
    );
    await storage.db.query(
      "INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES ($1,$2,'second-csrf',now()+interval '1 day')",
      [digest('second-admin'), second!.id],
    );
    const headers = { cookie: 'session=second-admin', 'x-csrf-token': 'second-csrf' };
    for (const role of ['moderator', 'admin']) {
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `/admin/users/${adminId}`,
            headers,
            payload: { role, disabled: false },
          })
        ).statusCode,
      ).toBe(200);
      expect((await rpc(auth.access_token, 'overview')).statusCode).toBe(401);
    }
  });
  it('binds opaque access and refresh tokens to this MCP resource', async () => {
    const auth = await grant();
    const other = await buildApp(
      storage.db,
      { ...config, publicUrl: 'http://other.example.com' },
      { logger: false },
    );
    try {
      expect(
        (
          await other.inject({
            method: 'POST',
            url: '/mcp',
            headers: { authorization: `Bearer ${auth.access_token}` },
            payload: {},
          })
        ).statusCode,
      ).toBe(401);
      const refresh = await other.inject({
        method: 'POST',
        url: '/oauth/token',
        payload: {
          grant_type: 'refresh_token',
          client_id: auth.clientId,
          refresh_token: auth.refresh_token,
        },
      });
      expect(refresh.json().error).toBe('invalid_grant');
    } finally {
      await other.close();
    }
  });
});
