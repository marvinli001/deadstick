import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { encrypt } from '../crypto.js';
import { AppError, required } from '../errors.js';
import { validateUrl } from '../monitor/network.js';
import type { ProviderInput, Resolution } from './schemas.js';
import {
  clearReviewButtons,
  notifyIncidentOpened,
  notifyMemorial,
  notifyResolution,
  notifyRevival,
} from '../telegram/notifications.js';

export const providerColumns = `p.id,p.slug,p.name,p.description,p.tags,p.aliases,p.lifecycle,p.health,p.last_checked_at,p.death_at,p.epitaph,p.created_at,to_char(p.opened_on,'YYYY-MM-DD') AS opened_on,to_char(p.closed_on,'YYYY-MM-DD') AS closed_on`;
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
  if (!input.name.trim()) throw new AppError(400, 'INVALID_NAME', 'Name required');
  return {
    name: input.name.trim(),
    aliases: input.aliases?.map((alias) => alias.trim()).filter(Boolean) ?? [],
    slug: input.slug,
    description: input.description ?? '',
    tags: input.tags ?? [],
    endpoints: prepareEndpoints(input.endpoints, config),
  };
}
export function prepareEndpoints(input: ProviderInput['endpoints'], config: Config) {
  const seen = new Set<string>();
  return input.map((endpoint) => {
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
    'INSERT INTO providers(name,slug,description,tags,aliases) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [input.name, input.slug, input.description, input.tags, input.aliases ?? []],
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
        await tx.query<{
          id: string;
          name: string;
          slug: string;
          lifecycle: string;
          epitaph: string | null;
        }>('SELECT id,name,slug,lifecycle,epitaph FROM providers WHERE id=$1 FOR UPDATE', [
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
    const reviving = provider.lifecycle === 'dead' && resolution.action === 'recovered';
    const status = dead
      ? 'confirmed_dead'
      : resolution.action === 'dismissed'
        ? 'dismissed'
        : 'resolved';
    await tx.query(
      'UPDATE incidents SET status=$1,resolution=$2,evidence_urls=$3,reviewer_id=$4,resolved_at=now() WHERE id=$5',
      [status, resolution.reason, resolution.evidenceUrls, actorId, id],
    );
    if (provider.lifecycle !== 'dead' || resolution.action !== 'dismissed')
      await tx.query(
        `UPDATE providers SET lifecycle=$1,death_at=CASE WHEN $2 THEN coalesce(death_at,now()) ELSE NULL END,closed_on=CASE WHEN $5 THEN NULL ELSE closed_on END,epitaph=$3,health=CASE WHEN $5 THEN 'unknown' ELSE health END,failure_streak=0,config_version=config_version+1,next_check_at=now(),updated_at=now() WHERE id=$4`,
        [
          dead ? 'dead' : 'active',
          dead,
          dead ? (resolution.epitaph ?? provider.epitaph ?? resolution.reason) : null,
          incident.provider_id,
          reviving,
        ],
      );
    await audit(tx, actorId, `incident.${resolution.action}`, id, {
      reason: resolution.reason,
      evidenceUrls: resolution.evidenceUrls,
    });
    if (reviving) {
      await clearReviewButtons(tx, `incident:${id}`);
      await audit(tx, actorId, 'provider.revive', provider.id, resolution);
      await notifyRevival(tx, config, provider, resolution.reason);
    } else await notifyResolution(tx, config, provider, id, resolution);
    return { id, status };
  });
}
export async function openIncident(
  db: DB,
  config: Config,
  providerId: string,
  summary: string,
  actorId: string,
) {
  return db.transaction(async (tx) => {
    const p = required(
      (
        await tx.query<{ id: string; name: string; slug: string; lifecycle: string }>(
          'SELECT id,name,slug,lifecycle FROM providers WHERE id=$1 FOR UPDATE',
          [providerId],
        )
      )[0],
    );
    if (p.lifecycle === 'dead')
      throw new AppError(409, 'ALREADY_DEAD', 'Provider already confirmed dead');
    const [incident] = await tx.query<{ id: string }>(
      "INSERT INTO incidents(provider_id,summary,manual_review) VALUES ($1,$2,true) ON CONFLICT (provider_id) WHERE status='open' DO NOTHING RETURNING id",
      [providerId, summary],
    );
    if (!incident)
      throw new AppError(409, 'INCIDENT_OPEN', 'Provider already has an open incident');
    await tx.query(
      "UPDATE providers SET lifecycle='suspected',config_version=config_version+1,updated_at=now() WHERE id=$1",
      [providerId],
    );
    await audit(tx, actorId, 'incident.create', incident.id);
    await notifyIncidentOpened(tx, config, p, incident.id, `审核员发起人工复核：${summary}`);
    return incident;
  });
}
export async function reviveProvider(
  db: DB,
  config: Config,
  providerId: string,
  input: { reason: string; evidenceUrls: string[] },
  actorId: string,
) {
  return db.transaction(async (tx) => {
    const p = required(
      (
        await tx.query<{ id: string; name: string; slug: string; lifecycle: string }>(
          'SELECT id,name,slug,lifecycle FROM providers WHERE id=$1 FOR UPDATE',
          [providerId],
        )
      )[0],
    );
    if (p.lifecycle !== 'dead')
      throw new AppError(409, 'NOT_DEAD', 'Provider is not in the cemetery');
    await tx.query(
      "UPDATE providers SET lifecycle='active',health='unknown',death_at=NULL,closed_on=NULL,epitaph=NULL,failure_streak=0,config_version=config_version+1,next_check_at=now(),updated_at=now() WHERE id=$1",
      [providerId],
    );
    const incidents = await tx.query<{ id: string }>(
      "UPDATE incidents SET status='resolved',resolution=$2,evidence_urls=$3,reviewer_id=$4,resolved_at=now() WHERE provider_id=$1 AND status='open' RETURNING id",
      [providerId, input.reason, input.evidenceUrls, actorId],
    );
    for (const incident of incidents) await clearReviewButtons(tx, `incident:${incident.id}`);
    await audit(tx, actorId, 'provider.revive', providerId, input);
    await notifyRevival(tx, config, p, input.reason);
    return { ok: true };
  });
}
export { createSubmission, reviewSubmission } from './submissions.js';
export async function createMemorial(
  db: DB,
  providerId: string,
  user: { id: string; display_name: string },
  body: string,
  sourceUpdateId: number | null = null,
) {
  return db.transaction(async (tx) => {
    const provider = required(
      (
        await tx.query<{ name: string; lifecycle: string }>(
          'SELECT name,lifecycle FROM providers WHERE id=$1 FOR SHARE',
          [providerId],
        )
      )[0],
    );
    if (provider.lifecycle !== 'dead')
      throw new AppError(409, 'NOT_DEAD', 'Provider has not been confirmed dead');
    const [row] = await tx.query<{ id: string; status: string }>(
      'INSERT INTO memorials(provider_id,user_id,body,source_update_id) VALUES ($1,$2,$3,$4) ON CONFLICT(source_update_id) DO NOTHING RETURNING id,status',
      [providerId, user.id, body, sourceUpdateId],
    );
    if (row)
      await notifyMemorial(tx, {
        id: row.id,
        body,
        provider: provider.name,
        author: user.display_name,
      });
    return row;
  });
}
export async function moderateMemorial(db: DB, id: string, visible: boolean, actorId: string) {
  return db.transaction(async (tx) => {
    required(
      (
        await tx.query('UPDATE memorials SET status=$1 WHERE id=$2 RETURNING id', [
          visible ? 'visible' : 'hidden',
          id,
        ])
      )[0],
    );
    await audit(tx, actorId, 'memorial.moderate', id, { visible });
    await clearReviewButtons(tx, `memorial:${id}`);
    return { ok: true };
  });
}
export async function setFollow(db: DB, userId: string, providerId: string, follow: boolean) {
  if (!follow) {
    await db.query('DELETE FROM follows WHERE user_id=$1 AND provider_id=$2', [userId, providerId]);
    return;
  }
  required((await db.query('SELECT id FROM providers WHERE id=$1', [providerId]))[0]);
  await db.query('INSERT INTO follows(user_id,provider_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [
    userId,
    providerId,
  ]);
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
