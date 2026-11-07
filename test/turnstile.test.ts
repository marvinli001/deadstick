import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { decrypt, digest } from '../src/crypto.js';
import { database } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { createProvider, prepareProvider } from '../src/catalog/service.js';

const connection = process.env.TEST_DATABASE_URL;
describe.skipIf(!connection)('Turnstile settings and protected submissions', () => {
  let app: FastifyInstance, storage: ReturnType<typeof database>, root: pg.Pool;
  let providerId: string;
  const config = loadConfig({
    APP_KEY: randomBytes(32).toString('base64'),
    PUBLIC_URL: 'https://deadstick.example',
  });
  const dbName = `deadstick_turnstile_${randomBytes(6).toString('hex')}`;
  const admin = { authorization: 'Bearer admin-token' };
  const member = { authorization: 'Bearer user-token' };
  const moderator = { authorization: 'Bearer moderator-token' };
  const credentials = { enabled: true, siteKey: 'test-site-key', secretKey: 'test-secret-key' };
  const input = {
    name: '新机场',
    endpoints: [{ kind: 'website', url: 'https://new.example.com' }],
  };
  const lead = { kind: 'abnormal', body: '官网连续多日无法打开' };
  const fetchMock = vi.fn<typeof fetch>();
  const configure = (payload = credentials) =>
    app.inject({ method: 'PUT', url: '/admin/settings/turnstile', headers: admin, payload });
  const verified = (action = 'submission', hostname = 'deadstick.example') =>
    Response.json({ success: true, action, hostname });

  beforeAll(async () => {
    root = new pg.Pool({ connectionString: connection });
    await root.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(connection!);
    url.pathname = `/${dbName}`;
    storage = database(url.href);
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
    await storage.db.query("DELETE FROM settings WHERE key='turnstile'");
    await storage.db.query('TRUNCATE users,providers,notifications RESTART IDENTITY CASCADE');
    const users = await storage.db.query<{ id: string; role: string }>(
      "INSERT INTO users(display_name,role) VALUES ('管理员','admin'),('成员','user'),('审核员','moderator') RETURNING id,role",
    );
    for (const user of users)
      await storage.db.query(
        "INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES ($1,$2,'test-csrf',now()+interval '1 day')",
        [digest(`${user.role}-token`), user.id],
      );
    const provider = await storage.db.transaction((tx) =>
      createProvider(
        tx,
        prepareProvider(
          {
            name: '已有机场',
            slug: 'existing-airport',
            endpoints: [{ kind: 'website', url: 'https://existing.example.com' }],
          },
          config,
        ),
        users[0]!.id,
      ),
    );
    providerId = provider.id;
    await storage.db.query("UPDATE providers SET lifecycle='dead' WHERE id=$1", [providerId]);
    fetchMock.mockReset().mockResolvedValue(verified());
    vi.stubGlobal('fetch', fetchMock);
    app = await buildApp(storage.db, config, { logger: false });
    await app.ready();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('defaults to disabled and accepts existing clients without contacting Cloudflare', async () => {
    expect((await app.inject({ url: '/settings/turnstile' })).json()).toEqual({
      enabled: false,
      siteKey: '',
    });
    for (const [url, payload] of [
      ['/submissions', input],
      [`/providers/${providerId}/submissions`, lead],
      [`/providers/${providerId}/memorials`, { body: '留下纪念' }],
    ] as const) {
      const response = await app.inject({ method: 'POST', url, headers: member, payload });
      expect(response.statusCode, response.body).toBe(201);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('restricts configuration to administrators and requires CSRF for cookie writes', async () => {
    for (const headers of [{}, member, moderator]) {
      for (const method of ['GET', 'PUT'] as const) {
        const response = await app.inject({
          method,
          url: '/admin/settings/turnstile',
          headers,
          ...(method === 'PUT' ? { payload: credentials } : {}),
        });
        expect(response.statusCode).toBe('authorization' in headers ? 403 : 401);
      }
    }
    const csrf = await app.inject({
      method: 'PUT',
      url: '/admin/settings/turnstile',
      headers: { cookie: 'session=admin-token' },
      payload: credentials,
    });
    expect(csrf.statusCode).toBe(403);
    expect((await app.inject({ url: '/settings/turnstile' })).json().enabled).toBe(false);
  });

  it('encrypts credentials, hides secrets from responses and audits, and preserves or rotates the secret', async () => {
    const saved = await configure();
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toEqual({
      enabled: true,
      siteKey: credentials.siteKey,
      secretKeySet: true,
    });
    const [row] = await storage.db.query<{ value: { ciphertext: string } }>(
      "SELECT value FROM settings WHERE key='turnstile'",
    );
    expect(JSON.stringify(row)).not.toContain(credentials.secretKey);
    expect(JSON.parse(decrypt(row!.value.ciphertext, config.appKey))).toEqual(credentials);
    const publicSettings = await app.inject({ url: '/settings/turnstile' });
    expect(publicSettings.json()).toEqual({ enabled: true, siteKey: credentials.siteKey });
    expect(publicSettings.headers['cache-control']).toBe('no-store');
    const adminSettings = await app.inject({ url: '/admin/settings/turnstile', headers: admin });
    expect(adminSettings.json()).toEqual(saved.json());
    expect(JSON.stringify(await storage.db.query('SELECT * FROM audit_log'))).not.toContain(
      credentials.secretKey,
    );
    await configure({ ...credentials, enabled: false, secretKey: '' });
    expect((await app.inject({ url: '/settings/turnstile' })).json()).toEqual({
      enabled: false,
      siteKey: '',
    });
    await configure({ ...credentials, secretKey: '' });
    await app.inject({
      method: 'POST',
      url: '/submissions',
      headers: member,
      payload: { ...input, turnstileToken: 'valid-token' },
    });
    expect((fetchMock.mock.calls[0]![1]!.body as URLSearchParams).get('secret')).toBe(
      credentials.secretKey,
    );
    await configure({ ...credentials, secretKey: 'rotated-secret' });
    await app.inject({
      method: 'POST',
      url: '/submissions',
      headers: member,
      payload: { ...input, turnstileToken: 'another-token' },
    });
    expect((fetchMock.mock.calls[1]![1]!.body as URLSearchParams).get('secret')).toBe(
      'rotated-secret',
    );
  });

  it('refuses to enable incomplete configuration', async () => {
    for (const payload of [
      { ...credentials, siteKey: '' },
      { ...credentials, secretKey: '  ' },
    ]) {
      const response = await configure(payload);
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('TURNSTILE_CONFIG');
    }
  });

  it('blocks missing tokens on every write, including both supplement kinds, before saving anything', async () => {
    await configure();
    const paths = [
      { method: 'POST', url: '/submissions', payload: input },
      { method: 'POST', url: `/providers/${providerId}/submissions`, payload: lead },
      { method: 'POST', url: `/providers/${providerId}/memorials`, payload: { body: '留言' } },
      { method: 'PUT', url: `/submissions/${providerId}`, payload: input },
      { method: 'PUT', url: `/submissions/${providerId}`, payload: lead },
    ] as const;
    for (const request of paths) {
      const response = await app.inject({ ...request, headers: member });
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json().error.code).toBe('TURNSTILE_REQUIRED');
    }
    expect(await storage.db.query('SELECT id FROM submissions')).toHaveLength(0);
    expect(await storage.db.query('SELECT id FROM memorials')).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('verifies each action, passes the client IP, and never persists tokens', async () => {
    await configure();
    for (const [url, payload, action] of [
      ['/submissions', input, 'submission'],
      [`/providers/${providerId}/submissions`, lead, 'lead'],
      [`/providers/${providerId}/memorials`, { body: '留言' }, 'memorial'],
    ] as const) {
      fetchMock.mockResolvedValueOnce(verified(action));
      const response = await app.inject({
        method: 'POST',
        url,
        headers: member,
        remoteAddress: '203.0.113.42',
        payload: { ...payload, turnstileToken: `valid-${action}-token` },
      });
      expect(response.statusCode, response.body).toBe(201);
    }
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect(options!.method).toBe('POST');
    expect(Object.fromEntries(options!.body as URLSearchParams)).toEqual({
      secret: credentials.secretKey,
      response: 'valid-submission-token',
      remoteip: '203.0.113.42',
    });
    expect(JSON.stringify(await storage.db.query('SELECT * FROM submissions'))).not.toContain(
      '-token',
    );
    expect(JSON.stringify(await storage.db.query('SELECT * FROM memorials'))).not.toContain(
      '-token',
    );
  });

  it.each(['provider', 'lead'])(
    'protects successful %s supplements with the matching action',
    async (kind) => {
      const created = await app.inject({
        method: 'POST',
        url: kind === 'provider' ? '/submissions' : `/providers/${providerId}/submissions`,
        headers: member,
        payload: kind === 'provider' ? input : lead,
      });
      expect(created.statusCode, created.body).toBe(201);
      const id = created.json().id;
      await storage.db.query("UPDATE submissions SET status='needs_info' WHERE id=$1", [id]);
      await configure();
      fetchMock.mockResolvedValueOnce(verified(kind === 'provider' ? 'submission' : 'lead'));
      const response = await app.inject({
        method: 'PUT',
        url: `/submissions/${id}`,
        headers: member,
        payload: { ...(kind === 'provider' ? input : lead), turnstileToken: 'supplement-token' },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(
        (
          await storage.db.query('SELECT status,revision,payload FROM submissions WHERE id=$1', [
            id,
          ])
        )[0],
      ).toMatchObject({ status: 'pending', revision: 2 });
      expect(JSON.stringify(await storage.db.query('SELECT * FROM submissions'))).not.toContain(
        'supplement-token',
      );
    },
  );

  it.each([
    { success: false, 'error-codes': ['timeout-or-duplicate'] },
    { success: true, action: 'memorial', hostname: 'deadstick.example' },
    { success: true, action: 'submission', hostname: 'attacker.example' },
    { success: true },
  ])('rejects expired tokens, wrong actions and wrong hostnames: %j', async (result) => {
    await configure();
    fetchMock.mockResolvedValueOnce(Response.json(result));
    const response = await app.inject({
      method: 'POST',
      url: '/submissions',
      headers: member,
      payload: { ...input, turnstileToken: 'untrusted-token' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('TURNSTILE_FAILED');
    expect(await storage.db.query('SELECT id FROM submissions')).toHaveLength(0);
  });

  it('fails closed on network errors and invalid Siteverify responses', async () => {
    await configure();
    fetchMock.mockRejectedValueOnce(new DOMException('Timed out', 'TimeoutError'));
    fetchMock.mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
    fetchMock.mockResolvedValueOnce(Response.json(null));
    for (let i = 0; i < 3; i++) {
      const response = await app.inject({
        method: 'POST',
        url: '/submissions',
        headers: member,
        payload: { ...input, turnstileToken: 'pending-token' },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe('TURNSTILE_UNAVAILABLE');
    }
    expect(await storage.db.query('SELECT id FROM submissions')).toHaveLength(0);
  });

  it('rejects replayed and oversized tokens while retaining authentication checks', async () => {
    await configure();
    fetchMock.mockResolvedValueOnce(verified('lead'));
    fetchMock.mockResolvedValueOnce(
      Response.json({ success: false, 'error-codes': ['timeout-or-duplicate'] }),
    );
    const request = {
      method: 'POST' as const,
      url: `/providers/${providerId}/submissions`,
      headers: member,
      payload: { ...lead, turnstileToken: 'single-use-token' },
    };
    expect((await app.inject(request)).statusCode).toBe(201);
    expect((await app.inject(request)).statusCode).toBe(403);
    expect(await storage.db.query('SELECT id FROM submissions')).toHaveLength(1);
    expect(
      (await app.inject({ ...request, payload: { ...lead, turnstileToken: 'x'.repeat(2049) } }))
        .statusCode,
    ).toBe(400);
    expect((await app.inject({ ...request, headers: {} })).statusCode).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
