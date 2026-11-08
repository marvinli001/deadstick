import Fastify from 'fastify';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import type { DB } from './db.js';
import type { Config } from './config.js';
import { AppError } from './errors.js';
import { authHook } from './auth/service.js';
import { authRoutes } from './auth/routes.js';
import { catalogRoutes } from './catalog/routes.js';
import { adminRoutes } from './routes/admin.js';
import { telegramRoutes } from './telegram/routes.js';
import { telegramSender, TelegramError, type TelegramSender } from './telegram/notifications.js';
import { telegramConfig } from './telegram/settings.js';
import { groupSettingsRoutes } from './telegram/group-settings.js';
import { adminGroupRoutes } from './telegram/groups.js';
import { mcpProtocolPaths, OAuthError } from './mcp/access.js';
import { oauthRoutes } from './mcp/oauth.js';
import { mcpRoutes } from './mcp/routes.js';
import { managementRoutes } from './mcp/management.js';
import { mcpAllows } from './mcp/tools.js';
import { turnstileRoutes } from './turnstile.js';

const staticPath = /^\/(?:(?:assets|fonts)\/|favicon\.svg(?:\?|$))/;

export async function buildApp(
  db: DB,
  config: Config,
  options: { logger?: boolean; sender?: TelegramSender } = {},
) {
  const defaults = config;
  config = { ...config };
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: config.logLevel,
            redact: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.headers.x-csrf-token',
              'req.headers.x-telegram-bot-api-secret-token',
              'res.headers.set-cookie',
            ],
            serializers: {
              req: (req) => ({
                method: req.method,
                url: req.url?.split('?')[0],
                remoteAddress: req.ip,
              }),
            },
          },
    bodyLimit: 2 * 1024 * 1024,
    ajv: { customOptions: { removeAdditional: false } },
    requestTimeout: 30000,
    trustProxy: config.trustProxy,
  });
  await app.register(cookie);
  await app.register(cors, { origin: config.corsOrigins, credentials: true });
  await app.register(helmet, {
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    // Telegram Web opens Mini Apps in an iframe; native clients use a webview.
    frameguard: false,
    contentSecurityPolicy: {
      directives: {
        scriptSrc: ["'self'", 'https://telegram.org', 'https://challenges.cloudflare.com'],
        frameSrc: ["'self'", 'https://challenges.cloudflare.com'],
        connectSrc: ["'self'", 'https://challenges.cloudflare.com'],
        frameAncestors: ["'self'", 'https://web.telegram.org'],
        upgradeInsecureRequests: config.production ? [] : null,
      },
    },
  });
  await app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
    allowList: (req) => staticPath.test(req.url),
  });
  await app.register(multipart, {
    limits: {
      fileSize: 20 * 1024 * 1024,
      files: 8,
      fields: 100,
      fieldSize: 1024 * 1024,
      parts: 108,
    },
  });
  app.decorateRequest('user', null);
  app.decorateRequest('sessionHash', null);
  app.decorateRequest('csrfToken', null);
  app.addHook('onRequest', async (req) => {
    const path = req.url.split('?')[0]!;
    if (
      req.headers.authorization?.startsWith('Bearer dsmcp_') &&
      path !== '/mcp' &&
      !mcpProtocolPaths.has(path) &&
      !path.startsWith('/.well-known/') &&
      !mcpAllows(req.method, req.routeOptions.url ?? '')
    )
      throw new AppError(403, 'FORBIDDEN', 'This route is not available to MCP connections');
    if (!staticPath.test(req.url) && !req.url.startsWith('/health/'))
      Object.assign(config, await telegramConfig(db, defaults));
  });
  const auth = authHook(db, config);
  app.addHook('preHandler', async (req) => {
    if (!staticPath.test(req.url)) await auth(req);
  });
  app.addHook('onSend', async (req, reply, payload) => {
    if (staticPath.test(req.url)) return payload;
    const path = req.url.split('?')[0]!;
    if (mcpProtocolPaths.has(path) || path.startsWith('/.well-known/oauth-')) {
      reply.header('Access-Control-Allow-Origin', '*');
      reply.removeHeader('Access-Control-Allow-Credentials');
    }
    if (path.startsWith('/oauth/') || path === '/mcp' || path === '/mcp/authorize')
      reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    if (path === '/mcp/authorize' || path.startsWith('/oauth/'))
      reply
        .header('X-Frame-Options', 'DENY')
        .header(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
        );
    if (req.user || req.url.startsWith('/auth/') || req.url.startsWith('/admin/'))
      reply.header('Cache-Control', 'no-store');
    return payload;
  });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof OAuthError)
      return reply
        .code(error.statusCode)
        .send({ error: error.code, error_description: error.message });
    if (error instanceof AppError)
      return reply
        .code(error.statusCode)
        .send({ error: { code: error.code, message: error.message }, requestId: req.id });
    if (error instanceof TelegramError)
      return reply.code(502).send({
        error: { code: `TELEGRAM_${error.code}`, message: 'Telegram rejected the API request' },
        requestId: req.id,
      });
    const e = error as { validation?: unknown; code?: string; statusCode?: number; name?: string };
    if (e.validation)
      return reply.code(400).send({
        error: { code: 'VALIDATION', message: 'Request does not match the API schema' },
        requestId: req.id,
      });
    if (e.code === '23505')
      return reply
        .code(409)
        .send({ error: { code: 'CONFLICT', message: 'Record already exists' }, requestId: req.id });
    if (e.code === '23503')
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: 'Referenced resource not found' },
        requestId: req.id,
      });
    if (e.statusCode && e.statusCode < 500)
      return reply.code(e.statusCode).send({
        error: {
          code: e.code ?? 'BAD_REQUEST',
          message: e.statusCode === 429 ? 'Too many requests' : 'Request rejected',
        },
        requestId: req.id,
      });
    req.log.error({ errorType: e.name, errorCode: e.code }, 'Request failed');
    return reply
      .code(500)
      .send({ error: { code: 'INTERNAL', message: 'Internal server error' }, requestId: req.id });
  });
  const sender: TelegramSender = options.sender ?? {
    send(method, parameters) {
      if (!config.botToken)
        throw new AppError(503, 'NOT_CONFIGURED', 'Telegram bot is not configured');
      return telegramSender(config.botToken).send(method, parameters);
    },
  };
  app.get('/health/live', async () => ({ ok: true }));
  app.get('/health/ready', async () => {
    await db.query('SELECT 1');
    return { ok: true };
  });
  authRoutes(app, db, config);
  catalogRoutes(app, db, config);
  turnstileRoutes(app, db, config);
  adminRoutes(app, db, config, sender);
  telegramRoutes(app, db, config, sender);
  groupSettingsRoutes(app, db, sender);
  adminGroupRoutes(app, db, sender, config);
  managementRoutes(app, db, config);
  oauthRoutes(app, db, config);
  mcpRoutes(app, db, config);
  if (existsSync(join(config.webDist, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: config.webDist,
      wildcard: false,
      index: false,
      setHeaders: (reply, path) => {
        if (/[\\/](assets|fonts)[\\/]/.test(path))
          reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        else reply.header('Cache-Control', 'no-cache');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (['GET', 'HEAD'].includes(req.method) && req.headers.accept?.includes('text/html'))
        return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: 'Route not found' }, requestId: req.id });
    });
  }
  return app;
}
