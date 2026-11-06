import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { administrator } from '../auth/service.js';
import { AppError, required } from '../errors.js';
import { decrypt } from '../crypto.js';
import {
  audit,
  createProvider,
  insertEndpoints,
  prepareEndpoints,
  prepareProvider,
} from '../catalog/service.js';
import {
  EndpointInput,
  Id,
  LeadInput,
  ProviderInput,
  SubmissionInput,
} from '../catalog/schemas.js';
import { editSubmission } from '../catalog/submissions.js';
import { clearReviewButtons } from '../telegram/notifications.js';

async function deleteProvider(tx: DB, id: string, actorId: string) {
  const row = required(
    (
      await tx.query<{ name: string }>('SELECT name FROM providers WHERE id=$1 FOR UPDATE', [id])
    )[0],
  );
  await tx.query(
    'UPDATE submissions SET provider_id=NULL,incident_id=NULL WHERE provider_id=$1 OR incident_id IN (SELECT id FROM incidents WHERE provider_id=$1)',
    [id],
  );
  await tx.query('DELETE FROM memorials WHERE provider_id=$1', [id]);
  await tx.query('DELETE FROM tributes WHERE provider_id=$1', [id]);
  await tx.query('DELETE FROM incidents WHERE provider_id=$1', [id]);
  await tx.query('DELETE FROM providers WHERE id=$1', [id]);
  await audit(tx, actorId, 'provider.delete', id, { name: row.name });
}

export function managementRoutes(app: FastifyInstance, db: DB, config: Config) {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();
  api.post(
    '/admin/providers/batch',
    {
      preHandler: administrator,
      schema: {
        body: Type.Object(
          { providers: Type.Array(ProviderInput, { minItems: 1, maxItems: 100 }) },
          { additionalProperties: false },
        ),
      },
    },
    async (req, reply) => {
      const prepared = req.body.providers.map((input) => prepareProvider(input, config));
      const items = await db.transaction(async (tx) => {
        const rows = [];
        for (const input of prepared) rows.push(await createProvider(tx, input, req.user!.id));
        return rows;
      });
      return reply.code(201).send({ items, count: items.length });
    },
  );
  api.post(
    '/admin/providers/batch-delete',
    {
      preHandler: administrator,
      schema: {
        body: Type.Object(
          { ids: Type.Array(Id.properties.id, { minItems: 1, maxItems: 100, uniqueItems: true }) },
          { additionalProperties: false },
        ),
      },
    },
    async (req) =>
      db.transaction(async (tx) => {
        for (const id of [...req.body.ids].sort()) await deleteProvider(tx, id, req.user!.id);
        return { count: req.body.ids.length };
      }),
  );
  api.delete(
    '/admin/providers/:id',
    { preHandler: administrator, schema: { params: Id } },
    async (req) =>
      db.transaction(async (tx) => {
        await deleteProvider(tx, req.params.id, req.user!.id);
        return { ok: true };
      }),
  );
  api.patch(
    '/admin/providers/:id',
    {
      preHandler: administrator,
      schema: {
        params: Id,
        body: Type.Partial(Type.Omit(ProviderInput, ['endpoints']), {
          minProperties: 1,
          additionalProperties: false,
        }),
      },
    },
    async (req) =>
      db.transaction(async (tx) => {
        if (req.body.name !== undefined && !req.body.name.trim())
          throw new AppError(400, 'INVALID_NAME', 'Name required');
        required(
          (
            await tx.query(
              'UPDATE providers SET name=coalesce($1,name),slug=coalesce($2,slug),description=coalesce($3,description),tags=coalesce($4,tags),aliases=coalesce($5,aliases),updated_at=now() WHERE id=$6 RETURNING id',
              [
                req.body.name?.trim(),
                req.body.slug,
                req.body.description,
                req.body.tags,
                req.body.aliases?.map((v) => v.trim()).filter(Boolean),
                req.params.id,
              ],
            )
          )[0],
        );
        await audit(tx, req.user!.id, 'provider.edit', req.params.id);
        return { ok: true };
      }),
  );
  api.post(
    '/admin/providers/:id/endpoints',
    {
      preHandler: administrator,
      schema: { params: Id, body: EndpointInput },
    },
    async (req) => {
      const endpoints = prepareEndpoints([req.body], config);
      return db.transaction(async (tx) => {
        required(
          (await tx.query('SELECT id FROM providers WHERE id=$1 FOR UPDATE', [req.params.id]))[0],
        );
        const existing = await tx.query<{
          kind: string;
          display_host: string;
          url_ciphertext: string;
        }>('SELECT kind,display_host,url_ciphertext FROM endpoints WHERE provider_id=$1', [
          req.params.id,
        ]);
        if (existing.length >= 30)
          throw new AppError(409, 'ENDPOINT_LIMIT', 'Maximum 30 endpoints');
        if (
          existing.some(
            (e) =>
              e.kind === req.body.kind &&
              decrypt(e.url_ciphertext, config.appKey) ===
                decrypt(endpoints[0]!.url_ciphertext, config.appKey),
          )
        )
          throw new AppError(409, 'DUPLICATE_ENDPOINT', 'Duplicate endpoint');
        await insertEndpoints(tx, req.params.id, endpoints);
        await tx.query(
          'UPDATE providers SET config_version=config_version+1,next_check_at=now(),updated_at=now() WHERE id=$1',
          [req.params.id],
        );
        await audit(tx, req.user!.id, 'endpoint.create', req.params.id, { kind: req.body.kind });
        return { ok: true };
      });
    },
  );
  api.delete(
    '/admin/providers/:id/endpoints/:endpointId',
    {
      preHandler: administrator,
      schema: { params: Type.Object({ ...Id.properties, endpointId: Id.properties.id }) },
    },
    async (req) =>
      db.transaction(async (tx) => {
        required(
          (await tx.query('SELECT id FROM providers WHERE id=$1 FOR UPDATE', [req.params.id]))[0],
        );
        const endpoints = await tx.query<{ id: string }>(
          'SELECT id FROM endpoints WHERE provider_id=$1',
          [req.params.id],
        );
        required(endpoints.find((e) => e.id === req.params.endpointId));
        if (endpoints.length === 1)
          throw new AppError(409, 'ENDPOINT_REQUIRED', 'Keep at least one endpoint');
        await tx.query('DELETE FROM endpoints WHERE id=$1 AND provider_id=$2', [
          req.params.endpointId,
          req.params.id,
        ]);
        await tx.query(
          'UPDATE providers SET config_version=config_version+1,next_check_at=now(),updated_at=now() WHERE id=$1',
          [req.params.id],
        );
        await audit(tx, req.user!.id, 'endpoint.delete', req.params.id, {
          endpointId: req.params.endpointId,
        });
        return { ok: true };
      }),
  );
  api.patch(
    '/admin/submissions/:id',
    {
      preHandler: administrator,
      schema: {
        params: Id,
        body: Type.Object(
          {
            revision: Type.Integer({ minimum: 1 }),
            payload: Type.Union([SubmissionInput, LeadInput]),
          },
          { additionalProperties: false },
        ),
      },
    },
    (req) =>
      editSubmission(db, config, req.params.id, req.body.revision, req.body.payload, req.user!.id),
  );
  api.delete(
    '/admin/submissions/:id',
    { preHandler: administrator, schema: { params: Id } },
    async (req) =>
      db.transaction(async (tx) => {
        required(
          (await tx.query('DELETE FROM submissions WHERE id=$1 RETURNING id', [req.params.id]))[0],
        );
        await clearReviewButtons(tx, `submission:${req.params.id}`);
        await audit(tx, req.user!.id, 'submission.delete', req.params.id);
        return { ok: true };
      }),
  );
  api.patch(
    '/admin/memorials/:id/content',
    {
      preHandler: administrator,
      schema: {
        params: Id,
        body: Type.Object(
          { body: Type.String({ minLength: 1, maxLength: 1000, pattern: '\\S' }) },
          { additionalProperties: false },
        ),
      },
    },
    async (req) =>
      db.transaction(async (tx) => {
        required(
          (
            await tx.query('UPDATE memorials SET body=$1 WHERE id=$2 RETURNING id', [
              req.body.body.trim(),
              req.params.id,
            ])
          )[0],
        );
        await clearReviewButtons(tx, `memorial:${req.params.id}`);
        await audit(tx, req.user!.id, 'memorial.edit', req.params.id);
        return { ok: true };
      }),
  );
  api.delete(
    '/admin/memorials/:id',
    { preHandler: administrator, schema: { params: Id } },
    async (req) =>
      db.transaction(async (tx) => {
        required(
          (await tx.query('DELETE FROM memorials WHERE id=$1 RETURNING id', [req.params.id]))[0],
        );
        await clearReviewButtons(tx, `memorial:${req.params.id}`);
        await audit(tx, req.user!.id, 'memorial.delete', req.params.id);
        return { ok: true };
      }),
  );
  api.patch(
    '/admin/incidents/:id',
    {
      preHandler: administrator,
      schema: {
        params: Id,
        body: Type.Object(
          { summary: Type.String({ minLength: 3, maxLength: 2000, pattern: '\\S' }) },
          { additionalProperties: false },
        ),
      },
    },
    async (req) =>
      db.transaction(async (tx) => {
        const row = required(
          (
            await tx.query<{ status: string }>(
              'SELECT status FROM incidents WHERE id=$1 FOR UPDATE',
              [req.params.id],
            )
          )[0],
        );
        if (row.status !== 'open')
          throw new AppError(409, 'ALREADY_REVIEWED', 'Incident already reviewed');
        await tx.query('UPDATE incidents SET summary=$1 WHERE id=$2', [
          req.body.summary.trim(),
          req.params.id,
        ]);
        await audit(tx, req.user!.id, 'incident.edit', req.params.id);
        return { ok: true };
      }),
  );
}
