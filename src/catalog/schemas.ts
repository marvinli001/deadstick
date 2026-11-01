import { FormatRegistry, Type, type Static } from '@sinclair/typebox';
// Fastify's Ajv knows these formats; Value.Check (used by the bot) needs them registered.
if (!FormatRegistry.Has('uri')) FormatRegistry.Set('uri', (value) => URL.canParse(value));
export const Id = Type.Object({ id: Type.String({ format: 'uuid' }) });
export const Page = {
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 100000, default: 0 })),
};
export const EndpointInput = Type.Object(
  {
    kind: Type.Union([Type.Literal('website'), Type.Literal('subscription')]),
    label: Type.Optional(Type.String({ maxLength: 80 })),
    url: Type.String({ format: 'uri', maxLength: 4096 }),
  },
  { additionalProperties: false },
);
export const ProviderInput = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 120 }),
    slug: Type.String({ minLength: 2, maxLength: 80, pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' }),
    description: Type.Optional(Type.String({ maxLength: 4000 })),
    tags: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 40 }), { maxItems: 10, uniqueItems: true }),
    ),
    endpoints: Type.Array(EndpointInput, { minItems: 1, maxItems: 30 }),
  },
  { additionalProperties: false },
);
export type ProviderInput = Static<typeof ProviderInput>;
export const MonitorSettings = Type.Object(
  {
    intervalHours: Type.Integer({ minimum: 1, maximum: 168 }),
    batchSize: Type.Integer({ minimum: 1, maximum: 100 }),
    concurrency: Type.Integer({ minimum: 1, maximum: 16 }),
    failureThreshold: Type.Integer({ minimum: 1, maximum: 10 }),
    checkTimeoutMs: Type.Integer({ minimum: 1000, maximum: 30000 }),
    nodeSampleSize: Type.Integer({ minimum: 0, maximum: 10 }),
    retentionDays: Type.Integer({ minimum: 7, maximum: 365 }),
  },
  { additionalProperties: false },
);
export type MonitorSettings = Static<typeof MonitorSettings>;
export const Resolution = Type.Object(
  {
    action: Type.Union([
      Type.Literal('dead'),
      Type.Literal('recovered'),
      Type.Literal('dismissed'),
    ]),
    reason: Type.String({ minLength: 3, maxLength: 2000 }),
    evidenceUrls: Type.Array(
      Type.String({ format: 'uri', pattern: '^https?://', maxLength: 2048 }),
      { minItems: 1, maxItems: 10 },
    ),
    epitaph: Type.Optional(Type.String({ maxLength: 500 })),
  },
  { additionalProperties: false },
);
export type Resolution = Static<typeof Resolution>;
