import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { bootstrapAdmin } from '../src/auth/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { digest, hashPassword, verifyPassword } from '../src/crypto.js';
import { database, type DB } from '../src/db.js';
import { migrate } from '../src/migrate.js';

const connection = process.env.TEST_DATABASE_URL;
describe.skipIf(!connection)('account credential lifecycle', () => {
  let storage: ReturnType<typeof database>, root: pg.Pool, app: FastifyInstance;
  let userId: string, passwordHash: string;
  const apps: FastifyInstance[] = [];
  const dbName = `deadstick_auth_${randomBytes(6).toString('hex')}`;
  const config = loadConfig({
    APP_KEY: randomBytes(32).toString('base64'),
    PUBLIC_URL: 'http://localhost:3000',
  });
  const headers = { cookie: 'session=lifecycle-session', 'x-csrf-token': 'lifecycle-csrf' };
  const currentPassword = 'original-password-long';
  const newPassword = 'replacement-password-long';
  const callback = 'http://127.0.0.1:51432/callback';

  function signal() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }
  async function application(db = storage.db) {
    const instance = await buildApp(db, config, { logger: false });
    apps.push(instance);
    await instance.ready();
    return instance;
  }
  async function account(email: string, session: string) {
    const [user] = await storage.db.query<{ id: string }>(
      "INSERT INTO users(email,password_hash,display_name,role) VALUES ($1,$2,'Fixture','admin') RETURNING id",
      [email, passwordHash],
    );
    await storage.db.query(
      "INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES ($1,$2,'lifecycle-csrf',now()+interval '1 day')",
      [digest(session), user!.id],
    );
    return user!.id;
  }
  function pauseQuery(query: string) {
    const entered = signal();
    const resume = signal();
    let paused = false;
    const db: DB = {
      async query<T extends pg.QueryResultRow>(text: string, values?: unknown[]) {
        const rows = await storage.db.query<T>(text, values);
        if (!paused && text === query) {
          paused = true;
          entered.resolve();
          await resume.promise;
        }
        return rows;
      },
      transaction: (fn) => storage.db.transaction(fn),
    };
    return { db, entered: entered.promise, resume: resume.resolve };
  }
  function changePassword(instance = app, replacement = newPassword) {
    return instance.inject({
      method: 'POST',
      url: '/auth/password',
      headers,
      payload: { currentPassword, newPassword: replacement },
    });
  }
  async function authorization(consentHeaders = headers) {
    const registered = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: { client_name: 'Lifecycle fixture', redirect_uris: [callback] },
    });
    expect(registered.statusCode).toBe(201);
    const clientId = registered.json().client_id as string;
    const verifier = randomBytes(32).toString('base64url');
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: callback,
      response_type: 'code',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      resource: `${config.publicUrl}/mcp`,
    });
    const started = await app.inject({ url: `/oauth/authorize?${query}` });
    expect(started.statusCode).toBe(302);
    const request = new URL(started.headers.location!, config.publicUrl).searchParams.get(
      'request',
    )!;
    return {
      request,
      approve: (instance = app) =>
        instance.inject({
          method: 'POST',
          url: `/auth/mcp/request/${request}`,
          headers: consentHeaders,
          payload: { approved: true },
        }),
      exchange: (code: string) =>
        app.inject({
          method: 'POST',
          url: '/oauth/token',
          payload: {
            grant_type: 'authorization_code',
            client_id: clientId,
            code,
            redirect_uri: callback,
            code_verifier: verifier,
          },
        }),
    };
  }
  async function approvedCode(consentHeaders = headers) {
    const flow = await authorization(consentHeaders);
    const approved = await flow.approve();
    expect(approved.statusCode).toBe(200);
    const code = new URL(approved.json().redirect as string).searchParams.get('code')!;
    return { exchange: () => flow.exchange(code) };
  }

  beforeAll(async () => {
    root = new pg.Pool({ connectionString: connection });
    await root.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(connection!);
    url.pathname = `/${dbName}`;
    storage = database(url.href);
    await migrate(storage.db);
    passwordHash = await hashPassword(currentPassword);
  });
  beforeEach(async () => {
    await storage.db.query('TRUNCATE mcp_clients,users RESTART IDENTITY CASCADE');
    userId = await account('lifecycle@example.com', 'lifecycle-session');
    app = await application();
  });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((instance) => instance.close()));
  });
  afterAll(async () => {
    await storage?.close();
    if (root) {
      await root.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await root.end();
    }
  });

  it('rejects a password update whose verified credential was replaced meanwhile', async () => {
    const pause = pauseQuery('SELECT password_hash FROM users WHERE id=$1');
    const delayed = await application(pause.db);
    const pending = changePassword(delayed, 'another-password-long').then((response) => response);
    try {
      await pause.entered;
      expect((await changePassword()).statusCode).toBe(200);
      expect((await app.inject({ url: '/auth/me', headers })).statusCode).toBe(401);
    } finally {
      pause.resume();
    }
    expect((await pending).statusCode).toBe(401);
    const [user] = await storage.db.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id=$1',
      [userId],
    );
    expect(await verifyPassword(newPassword, user!.password_hash)).toBe(true);
    expect(
      await storage.db.query('SELECT token_hash FROM sessions WHERE user_id=$1', [userId]),
    ).toHaveLength(1);
  });

  it('rejects a login whose verified password was replaced before session creation', async () => {
    const pause = pauseQuery('SELECT * FROM users WHERE email=$1');
    const delayed = await application(pause.db);
    const pending = delayed
      .inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'lifecycle@example.com', password: currentPassword },
      })
      .then((response) => response);
    try {
      await pause.entered;
      expect((await changePassword()).statusCode).toBe(200);
    } finally {
      pause.resume();
    }
    const response = await pending;
    expect(response.statusCode).toBe(401);
    expect(response.cookies.some((cookie) => cookie.name === 'session')).toBe(false);
  });

  it('invalidates pending authorization codes on password change only for that user', async () => {
    const own = await approvedCode();
    await account('another@example.com', 'another-session');
    const other = await approvedCode({ ...headers, cookie: 'session=another-session' });
    expect((await changePassword()).statusCode).toBe(200);
    const rejected = await own.exchange();
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error).toBe('invalid_grant');
    expect((await other.exchange()).statusCode).toBe(200);
  });

  it('invalidates pending authorization codes when bootstrap replaces the password', async () => {
    const flow = await approvedCode();
    await bootstrapAdmin(storage.db, {
      ADMIN_EMAIL: 'lifecycle@example.com',
      ADMIN_PASSWORD: newPassword,
    });
    const response = await flow.exchange();
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_grant');
  });

  it.each(['disable', 'demote'] as const)(
    'does not restore old authorization codes after an account %s is reversed',
    async (action) => {
      const flow = await approvedCode();
      await account('another@example.com', 'another-session');
      const operator = { ...headers, cookie: 'session=another-session' };
      const change = (role: 'user' | 'admin', disabled: boolean) =>
        app.inject({
          method: 'PATCH',
          url: `/admin/users/${userId}`,
          headers: operator,
          payload: { role, disabled },
        });
      expect(
        (await change(action === 'demote' ? 'user' : 'admin', action === 'disable')).statusCode,
      ).toBe(200);
      expect((await change('admin', false)).statusCode).toBe(200);
      const response = await flow.exchange();
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('invalid_grant');
    },
  );

  it('rechecks the session when an authorization approval resumes after a password change', async () => {
    const flow = await authorization();
    const entered = signal();
    const resume = signal();
    const delayed = await application({
      query: storage.db.query,
      async transaction(fn) {
        entered.resolve();
        await resume.promise;
        return storage.db.transaction(fn);
      },
    });
    const pending = flow.approve(delayed).then((response) => response);
    try {
      await entered.promise;
      expect((await changePassword()).statusCode).toBe(200);
    } finally {
      resume.resolve();
    }
    expect((await pending).statusCode).toBe(401);
  });
});
