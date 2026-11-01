import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { encrypt } from '../crypto.js';
import { AppError, required } from '../errors.js';
import { validateUrl } from '../monitor/network.js';
import type { ProviderInput, Resolution } from './schemas.js';
import { broadcast } from '../telegram/notifications.js';

export const providerColumns =
  'p.id,p.slug,p.name,p.description,p.tags,p.lifecycle,p.health,p.last_checked_at,p.death_at,p.epitaph,p.created_at';
export async function audit(
  db: DB,
  actorId: string | null,
  action: string,
  targetId: string,
  details: object = {},
) {
  await db.query('INSERT INTO audit_log(actor_id,action,target_id,details) VALUES ($1,$2,$3,$4)', [
    actorId,
    action,
    targetId,
    JSON.stringify(details),
  ]);
}
export function prepareProvider(input: ProviderInput, config: Config) {
  const seen = new Set<string>();
  const endpoints = input.endpoints.map((endpoint) => {
    const url = validateUrl(endpoint.url);
    const key = `${endpoint.kind}:${url.href}`;
    if (seen.has(key)) throw new AppError(400, 'DUPLICATE_ENDPOINT', 'Duplicate endpoint');
    seen.add(key);
    return {
      kind: endpoint.kind,
      label: endpoint.label ?? url.hostname,
      display_host: url.hostname,
      public_url: endpoint.kind === 'website' ? `${url.origin}${url.pathname}` : null,
      url_ciphertext: encrypt(url.href, config.appKey),
    };
  });
  return {
    name: input.name,
    slug: input.slug,
    description: input.description ?? '',
    tags: input.tags ?? [],
    endpoints,
  };
}
export type PreparedProvider = ReturnType<typeof prepareProvider>;
export async function insertEndpoints(
  db: DB,
  providerId: string,
  endpoints: PreparedProvider['endpoints'],
) {
  for (const e of endpoints)
    await db.query(
      'INSERT INTO endpoints(provider_id,kind,label,display_host,public_url,url_ciphertext) VALUES ($1,$2,$3,$4,$5,$6)',
      [providerId, e.kind, e.label, e.display_host, e.public_url, e.url_ciphertext],
    );
}
export async function createProvider(db: DB, input: PreparedProvider, actorId: string) {
  const [row] = await db.query<{ id: string }>(
    'INSERT INTO providers(name,slug,description,tags) VALUES ($1,$2,$3,$4) RETURNING id',
    [input.name, input.slug, input.description, input.tags],
  );
  await insertEndpoints(db, row!.id, input.endpoints);
  await audit(db, actorId, 'provider.create', row!.id);
  return row!;
}
export async function resolveIncident(
  db: DB,
  config: Config,
  id: string,
  resolution: Resolution,
  actorId: string,
) {
  return db.transaction(async (tx) => {
    const reference = required(
      (
        await tx.query<{ provider_id: string }>('SELECT provider_id FROM incidents WHERE id=$1', [
          id,
        ])
      )[0],
    );
    const provider = required(
      (
        await tx.query<{ name: string }>('SELECT name FROM providers WHERE id=$1 FOR UPDATE', [
          reference.provider_id,
        ])
      )[0],
    );
    const incident = required(
      (
        await tx.query<{ id: string; provider_id: string; status: string }>(
          'SELECT * FROM incidents WHERE id=$1 FOR UPDATE',
          [id],
        )
      )[0],
    );
    if (incident.status !== 'open')
      throw new AppError(409, 'ALREADY_REVIEWED', 'Incident already reviewed');
    const dead = resolution.action === 'dead';
    const status = dead
      ? 'confirmed_dead'
      : resolution.action === 'dismissed'
        ? 'dismissed'
        : 'resolved';
    await tx.query(
      'UPDATE incidents SET status=$1,resolution=$2,evidence_urls=$3,reviewer_id=$4,resolved_at=now() WHERE id=$5',
      [status, resolution.reason, resolution.evidenceUrls, actorId, id],
    );
    await tx.query(
      `UPDATE providers SET lifecycle=$1,death_at=CASE WHEN $2 THEN now() ELSE NULL END,epitaph=$3,failure_streak=0,config_version=config_version+1,next_check_at=now(),updated_at=now() WHERE id=$4`,
      [
        dead ? 'dead' : 'active',
        dead,
        dead ? (resolution.epitaph ?? resolution.reason) : null,
        incident.provider_id,
      ],
    );
    await audit(tx, actorId, `incident.${resolution.action}`, id, {
      reason: resolution.reason,
      evidenceUrls: resolution.evidenceUrls,
    });
    await broadcast(
      tx,
      config,
      incident.provider_id,
      `resolution:${id}`,
      `${dead ? '🪦 人工核验：确认跑路' : resolution.action === 'dismissed' ? '✅ 管理员排除本次异常' : '✅ 人工核验：服务恢复'}\n${provider.name}\n${resolution.reason}\n证据：${resolution.evidenceUrls.join('\n')}`,
    );
    return { id, status };
  });
}
export async function addTribute(
  db: DB,
  providerId: string,
  userId: string,
  kind: 'flower' | 'candle' | 'incense',
) {
  return db.transaction(async (tx) => {
    const provider = required(
      (
        await tx.query<{ lifecycle: string }>(
          'SELECT lifecycle FROM providers WHERE id=$1 FOR SHARE',
          [providerId],
        )
      )[0],
    );
    if (provider.lifecycle !== 'dead')
      throw new AppError(409, 'NOT_DEAD', 'Tributes are available after manual confirmation');
    const [row] = await tx.query(
      'INSERT INTO tributes(provider_id,user_id,kind) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id',
      [providerId, userId, kind],
    );
    return { created: Boolean(row) };
  });
}
