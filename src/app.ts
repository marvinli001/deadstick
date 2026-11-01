import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
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

export async function buildApp(
  db: DB,
  config: Config,
  options: { logger?: boolean; sender?: TelegramSender } = {},
) {
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
  await app.register(helmet, { crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' } });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  await app.register(multipart, {
    limits: {
      fileSize: 20 * 1024 * 1024,
      files: 8,
      fields: 100,
      fieldSize: 1024 * 1024,
      parts: 108,
    },
  });
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Deadstick API',
        version: '0.1.0',
        description:
          '机场监测、人工复核、赛博墓园与 Telegram 机器人。订阅凭据不会出现在公开接口中。',
      },
      components: {
        securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: 'session' } },
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });
  app.decorateRequest('user', null);
  app.decorateRequest('sessionHash', null);
  app.decorateRequest('csrfToken', null);
  app.addHook('preHandler', authHook(db, config));
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.user || req.url.startsWith('/auth/') || req.url.startsWith('/admin/'))
      reply.header('Cache-Control', 'no-store');
    return payload;
  });
  app.setErrorHandler((error, req, reply) => {
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
  const sender = options.sender ?? (config.botToken ? telegramSender(config.botToken) : undefined);
  app.get('/health/live', async () => ({ ok: true }));
  app.get('/health/ready', async () => {
    await db.query('SELECT 1');
    return { ok: true };
  });
  authRoutes(app, db, config);
  catalogRoutes(app, db, config);
  adminRoutes(app, db, config, sender);
  telegramRoutes(app, db, config, sender);
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());
  return app;
}
