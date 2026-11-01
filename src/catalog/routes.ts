import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { authenticated, reviewer } from '../auth/service.js';
import { required } from '../errors.js';
import { Id, Page, ProviderInput } from './schemas.js';
import {
  addTribute,
  audit,
  createProvider,
  createMemorial,
  createSubmission,
  insertEndpoints,
  prepareProvider,
  providerColumns,
  reviewSubmission,
  setFollow,
} from './service.js';

export function catalogRoutes(app: FastifyInstance, db: DB, config: Config) {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();
  const count = async (sql: string, values: unknown[]) =>
    (await db.query<{ total: number }>(`SELECT count(*)::int AS total ${sql}`, values))[0]!.total;
  async function providerDetail(column: 'id' | 'slug', value: string, userId?: string) {
    const provider = required(
      (
        await db.query<{ id: string }>(
          `SELECT ${providerColumns},(SELECT count(*)::int FROM follows f WHERE f.provider_id=p.id) AS follower_count,(SELECT count(*)::int FROM memorials m WHERE m.provider_id=p.id AND m.status='visible') AS memorial_count,CASE WHEN $2::uuid IS NULL THEN NULL ELSE EXISTS(SELECT 1 FROM follows f WHERE f.provider_id=p.id AND f.user_id=$2::uuid) END AS following FROM providers p WHERE p.${column}=$1`,
          [value, userId ?? null],
        )
      )[0],
    );
    const [websites, incidents, tributes] = await Promise.all([
      db.query(
        "SELECT id,label,public_url FROM endpoints WHERE provider_id=$1 AND kind='website'",
        [provider.id],
      ),
      db.query(
        'SELECT id,status,summary,resolution,evidence_urls,created_at,resolved_at FROM incidents WHERE provider_id=$1 ORDER BY created_at DESC LIMIT 20',
        [provider.id],
      ),
      db.query(
        'SELECT kind,count(*)::int AS count FROM tributes WHERE provider_id=$1 GROUP BY kind',
        [provider.id],
      ),
    ]);
    return { ...provider, websites, incidents, tributes };
  }
  api.get(
    '/providers',
    {
      schema: {
        tags: ['catalog'],
        querystring: Type.Object({
          ...Page,
          q: Type.Optional(Type.String({ maxLength: 120 })),
          lifecycle: Type.Optional(
            Type.Union([Type.Literal('active'), Type.Literal('suspected'), Type.Literal('dead')]),
          ),
          tag: Type.Optional(Type.String({ maxLength: 40 })),
        }),
      },
    },
    async (req) => {
      const { q, lifecycle, tag, limit = 20, offset = 0 } = req.query;
      const filter =
        "FROM providers p WHERE ($1::text IS NULL OR p.name ILIKE '%'||$1||'%' OR p.slug ILIKE '%'||$1||'%') AND ($2::text IS NULL OR p.lifecycle=$2) AND ($3::text IS NULL OR $3=ANY(p.tags))";
      const values = [q ?? null, lifecycle ?? null, tag ?? null];
      const [items, total] = await Promise.all([
        db.query(
          `SELECT ${providerColumns},(SELECT count(*)::int FROM tributes t WHERE t.provider_id=p.id) AS tribute_count ${filter} ORDER BY p.created_at DESC,p.id LIMIT $4 OFFSET $5`,
          [...values, limit, offset],
        ),
        count(filter, values),
      ]);
      return { items, total, limit, offset };
    },
  );
  api.get(
    '/graveyard',
    { schema: { tags: ['cemetery'], querystring: Type.Object(Page) } },
    async (req) => {
      const { limit = 20, offset = 0 } = req.query;
      const [items, total] = await Promise.all([
        db.query(
          `SELECT ${providerColumns},(SELECT count(*)::int FROM tributes t WHERE t.provider_id=p.id) AS tribute_count FROM providers p WHERE lifecycle='dead' ORDER BY death_at DESC,p.id LIMIT $1 OFFSET $2`,
          [limit, offset],
        ),
        count("FROM providers WHERE lifecycle='dead'", []),
      ]);
      return { items, total, limit, offset };
    },
  );
  api.get(
    '/stats',
    { schema: { tags: ['catalog'] } },
    async () =>
      (
        await db.query(
          "SELECT count(*)::int AS total,count(*) FILTER(WHERE lifecycle='dead')::int AS dead,count(*) FILTER(WHERE lifecycle='suspected')::int AS suspected,count(*) FILTER(WHERE health='healthy')::int AS healthy,(SELECT count(*)::int FROM tributes) AS tributes FROM providers",
        )
      )[0],
  );
  api.get('/providers/:id', { schema: { tags: ['catalog'], params: Id } }, (req) =>
    providerDetail('id', req.params.id, req.user?.id),
  );
  api.get(
    '/providers/slug/:slug',
    {
      schema: {
        tags: ['catalog'],
        params: Type.Object({ slug: ProviderInput.properties.slug }),
      },
    },
    (req) => providerDetail('slug', req.params.slug, req.user?.id),
  );
  api.get(
    '/providers/:id/checks',
    { schema: { tags: ['catalog'], params: Id, querystring: Type.Object(Page) } },
    async (req) => ({
      items: await db.query(
        'SELECT id,health,summary,created_at FROM check_runs WHERE provider_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
        [req.params.id, req.query.limit ?? 20, req.query.offset ?? 0],
      ),
    }),
  );
  api.post(
    '/submissions',
    {
      preHandler: authenticated,
      config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
      schema: { tags: ['submissions'], body: ProviderInput },
    },
    async (req, reply) => {
      const row = await createSubmission(db, config, req.user!, prepareProvider(req.body, config));
      reply.code(201);
      return row;
    },
  );
  api.get(
    '/submissions/mine',
    {
      preHandler: authenticated,
      schema: { tags: ['submissions'], querystring: Type.Object(Page) },
    },
    async (req) => ({
      items: await db.query(
        "SELECT id,payload->>'name' AS name,status,reason,provider_id,created_at,reviewed_at FROM submissions WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3",
        [req.user!.id, req.query.limit ?? 20, req.query.offset ?? 0],
      ),
    }),
  );
  api.post(
    '/admin/providers',
    { preHandler: reviewer, schema: { tags: ['admin'], body: ProviderInput } },
    async (req, reply) => {
      const prepared = prepareProvider(req.body, config);
      const result = await db.transaction((tx) => createProvider(tx, prepared, req.user!.id));
      reply.code(201);
      return result;
    },
  );
  api.get(
    '/admin/providers',
    {
      preHandler: reviewer,
      schema: {
        tags: ['admin'],
        querystring: Type.Object({
          ...Page,
          q: Type.Optional(Type.String({ maxLength: 120 })),
          lifecycle: Type.Optional(
            Type.Union([Type.Literal('active'), Type.Literal('suspected'), Type.Literal('dead')]),
          ),
        }),
      },
    },
    async (req) => {
      const { q, lifecycle, limit = 20, offset = 0 } = req.query;
      const filter =
        "FROM providers p WHERE ($1::text IS NULL OR p.name ILIKE '%'||$1||'%' OR p.slug ILIKE '%'||$1||'%') AND ($2::text IS NULL OR p.lifecycle=$2)";
      const values = [q ?? null, lifecycle ?? null];
      const [items, total] = await Promise.all([
        db.query(
          `SELECT ${providerColumns},p.enabled,p.failure_streak,p.next_check_at,p.updated_at,(SELECT count(*)::int FROM endpoints e WHERE e.provider_id=p.id AND e.kind='website') AS website_count,(SELECT count(*)::int FROM endpoints e WHERE e.provider_id=p.id AND e.kind='subscription') AS subscription_count ${filter} ORDER BY p.created_at DESC,p.id LIMIT $3 OFFSET $4`,
          [...values, limit, offset],
        ),
        count(filter, values),
      ]);
      return { items, total, limit, offset };
    },
  );
  api.put(
    '/admin/providers/:id',
    { preHandler: reviewer, schema: { tags: ['admin'], params: Id, body: ProviderInput } },
    async (req) => {
      const p = prepareProvider(req.body, config);
      return db.transaction(async (tx) => {
        required(
          (await tx.query('SELECT id FROM providers WHERE id=$1 FOR UPDATE', [req.params.id]))[0],
        );
        await tx.query(
          'UPDATE providers SET name=$1,slug=$2,description=$3,tags=$4,config_version=config_version+1,next_check_at=now(),updated_at=now() WHERE id=$5',
          [p.name, p.slug, p.description, p.tags, req.params.id],
        );
        await tx.query('DELETE FROM endpoints WHERE provider_id=$1', [req.params.id]);
        await insertEndpoints(tx, req.params.id, p.endpoints);
        await audit(tx, req.user!.id, 'provider.update', req.params.id);
        return { ok: true };
      });
    },
  );
  api.get(
    '/admin/providers/:id/endpoints',
    { preHandler: reviewer, schema: { tags: ['admin'], params: Id } },
    async (req) => ({
      items: await db.query(
        'SELECT id,kind,label,display_host,public_url,created_at FROM endpoints WHERE provider_id=$1',
        [req.params.id],
      ),
    }),
  );
  api.get(
    '/admin/providers/:id',
    { preHandler: reviewer, schema: { tags: ['admin'], params: Id } },
    async (req) =>
      required(
        (
          await db.query(
            `SELECT ${providerColumns},p.enabled,p.failure_streak,p.next_check_at,p.updated_at FROM providers p WHERE id=$1`,
            [req.params.id],
          )
        )[0],
      ),
  );
  api.patch(
    '/admin/providers/:id/monitoring',
    {
      preHandler: reviewer,
      schema: {
        tags: ['admin'],
        params: Id,
        body: Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false }),
      },
    },
    async (req) =>
      db.transaction(async (tx) => {
        required(
          (
            await tx.query(
              'UPDATE providers SET enabled=$1,config_version=config_version+1,next_check_at=now(),updated_at=now() WHERE id=$2 RETURNING id',
              [req.body.enabled, req.params.id],
            )
          )[0],
        );
        await audit(tx, req.user!.id, 'provider.monitoring', req.params.id, req.body);
        return { ok: true };
      }),
  );
  api.get(
    '/admin/submissions',
    {
      preHandler: reviewer,
      schema: {
        tags: ['admin'],
        querystring: Type.Object({
          ...Page,
          status: Type.Optional(
            Type.Union([
              Type.Literal('pending'),
              Type.Literal('approved'),
              Type.Literal('rejected'),
            ]),
          ),
        }),
      },
    },
    async (req) => ({
      items: await db.query(
        "SELECT id,user_id,payload - 'endpoints' AS provider,jsonb_array_length(payload->'endpoints') AS endpoint_count,status,reason,created_at FROM submissions WHERE status=$1 ORDER BY created_at LIMIT $2 OFFSET $3",
        [req.query.status ?? 'pending', req.query.limit ?? 20, req.query.offset ?? 0],
      ),
    }),
  );
  api.post(
    '/admin/submissions/:id/review',
    {
      preHandler: reviewer,
      schema: {
        tags: ['admin'],
        params: Id,
        body: Type.Object(
          { approve: Type.Boolean(), reason: Type.String({ minLength: 1, maxLength: 1000 }) },
          { additionalProperties: false },
        ),
      },
    },
    (req) => reviewSubmission(db, config, req.params.id, req.body, req.user!.id),
  );
  api.put(
    '/providers/:id/follow',
    { preHandler: authenticated, schema: { tags: ['catalog'], params: Id } },
    async (req) => {
      await setFollow(db, req.user!.id, req.params.id, true);
      return { ok: true };
    },
  );
  api.delete(
    '/providers/:id/follow',
    { preHandler: authenticated, schema: { tags: ['catalog'], params: Id } },
    async (req) => {
      await setFollow(db, req.user!.id, req.params.id, false);
      return { ok: true };
    },
  );
  api.get(
    '/follows',
    { preHandler: authenticated, schema: { tags: ['catalog'], querystring: Type.Object(Page) } },
    async (req) => ({
      items: await db.query(
        `SELECT ${providerColumns} FROM providers p JOIN follows f ON p.id=f.provider_id WHERE f.user_id=$1 ORDER BY f.created_at DESC LIMIT $2 OFFSET $3`,
        [req.user!.id, req.query.limit ?? 20, req.query.offset ?? 0],
      ),
    }),
  );
  api.post(
    '/providers/:id/tributes',
    {
      preHandler: authenticated,
      schema: {
        tags: ['cemetery'],
        params: Id,
        body: Type.Object(
          {
            kind: Type.Union([
              Type.Literal('flower'),
              Type.Literal('candle'),
              Type.Literal('incense'),
            ]),
          },
          { additionalProperties: false },
        ),
      },
    },
    (req) => addTribute(db, req.params.id, req.user!.id, req.body.kind),
  );
  api.post(
    '/providers/:id/memorials',
    {
      preHandler: authenticated,
      config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
      schema: {
        tags: ['cemetery'],
        params: Id,
        body: Type.Object(
          { body: Type.String({ minLength: 1, maxLength: 1000 }) },
          { additionalProperties: false },
        ),
      },
    },
    async (req, reply) => {
      const row = await createMemorial(db, req.params.id, req.user!, req.body.body);
      reply.code(201);
      return row;
    },
  );
  api.get(
    '/providers/:id/memorials',
    { schema: { tags: ['cemetery'], params: Id, querystring: Type.Object(Page) } },
    async (req) => ({
      items: await db.query(
        "SELECT m.id,m.body,m.created_at,u.display_name FROM memorials m JOIN users u ON m.user_id=u.id WHERE provider_id=$1 AND status='visible' ORDER BY created_at DESC LIMIT $2 OFFSET $3",
        [req.params.id, req.query.limit ?? 20, req.query.offset ?? 0],
      ),
    }),
  );
}
