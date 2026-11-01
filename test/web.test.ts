import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { DB } from '../src/db.js';

describe('web and API on one origin', () => {
  let app: FastifyInstance;
  let webDist: string;
  const query = vi.fn(async () => []);
  const db: DB = { query, transaction: (fn) => fn(db) };
  const html = '<!doctype html><html><body>Deadstick</body></html>';

  beforeAll(async () => {
    webDist = await mkdtemp(join(tmpdir(), 'deadstick-web-'));
    await mkdir(join(webDist, 'assets'));
    await mkdir(join(webDist, 'fonts'));
    await writeFile(join(webDist, 'index.html'), html);
    await writeFile(join(webDist, 'assets/main.js'), 'export {};');
    await writeFile(join(webDist, 'fonts/test.woff2'), 'font');
    const config = loadConfig({
      APP_KEY: randomBytes(32).toString('base64'),
      WEB_DIST: webDist,
    });
    app = await buildApp(db, config, { logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await rm(webDist, { recursive: true, force: true });
  });

  it('serves deep links and permits Telegram Web embedding', async () => {
    const page = await app.inject({ url: '/console/incidents', headers: { accept: 'text/html' } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toBe(html);
    expect(page.headers['cache-control']).toBe('no-cache');
    expect(page.headers['content-security-policy']).toContain(
      "frame-ancestors 'self' https://web.telegram.org",
    );
    expect(page.headers['x-frame-options']).toBeUndefined();
    expect(page.headers['content-security-policy']).toContain(
      "script-src 'self' https://telegram.org",
    );
    const head = await app.inject({
      method: 'HEAD',
      url: '/airports/example',
      headers: { accept: 'text/html' },
    });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe('');
  });

  it('caches assets without looking up the session', async () => {
    query.mockClear();
    for (const url of ['/assets/main.js', '/fonts/test.woff2']) {
      const asset = await app.inject({ url, headers: { cookie: 'session=unused-token' } });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('preserves API errors and never sends HTML for JSON or mutation requests', async () => {
    const auth = await app.inject({ url: '/auth/me', headers: { accept: 'application/json' } });
    expect(auth.statusCode).toBe(401);
    expect(auth.json().error.code).toBe('UNAUTHORIZED');
    expect(auth.headers['cache-control']).toBe('no-store');
    const missing = await app.inject({
      url: '/missing-api',
      headers: { accept: 'application/json' },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('NOT_FOUND');
    const post = await app.inject({
      method: 'POST',
      url: '/console',
      headers: { accept: 'text/html' },
    });
    expect(post.statusCode).toBe(404);
    expect(post.json().error.code).toBe('NOT_FOUND');
  });

  it('does not spend the API rate limit on fonts and scripts', async () => {
    for (let i = 0; i < 125; i++) {
      const asset = await app.inject({ url: '/assets/main.js' });
      expect(asset.statusCode).toBe(200);
    }
    const auth = await app.inject({ url: '/auth/me' });
    expect(auth.statusCode).toBe(401);
  });
});
