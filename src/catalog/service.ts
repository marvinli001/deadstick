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
  notifySubmission,
  notifySubmissionResult,
} from '../telegram/notifications.js';

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
        await tx.query<{ id: string; name: string; slug: string }>(
          'SELECT id,name,slug FROM providers WHERE id=$1 FOR UPDATE',
          [reference.provider_id],
        )
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
    await notifyResolution(tx, config, provider, id, resolution);
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
      "INSERT INTO incidents(provider_id,summary) VALUES ($1,$2) ON CONFLICT (provider_id) WHERE status='open' DO NOTHING RETURNING id",
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
      "UPDATE providers SET lifecycle='active',health='unknown',death_at=NULL,epitaph=NULL,failure_streak=0,config_version=config_version+1,next_check_at=now(),updated_at=now() WHERE id=$1",
      [providerId],
    );
    await audit(tx, actorId, 'provider.revive', providerId, input);
    await notifyRevival(tx, config, p, input.reason);
    return { ok: true };
  });
}
export async function createSubmission(
  db: DB,
  config: Config,
  user: { id: string; display_name: string },
  payload: PreparedProvider,
  sourceUpdateId: number | null = null,
) {
  return db.transaction(async (tx) => {
    const [row] = await tx.query<{ id: string; status: string; created_at: Date }>(
      'INSERT INTO submissions(user_id,payload,source_update_id) VALUES ($1,$2,$3) ON CONFLICT(source_update_id) DO NOTHING RETURNING id,status,created_at',
      [user.id, JSON.stringify(payload), sourceUpdateId],
    );
    if (row)
      await notifySubmission(tx, config, {
        id: row.id,
        name: payload.name,
        slug: payload.slug,
        hosts: payload.endpoints.filter((e) => e.kind === 'website').map((e) => e.display_host),
        subscriptions: payload.endpoints.filter((e) => e.kind === 'subscription').length,
        author: user.display_name,
      });
    return row;
  });
}
export async function reviewSubmission(
  db: DB,
  config: Config,
  id: string,
  input: { approve: boolean; reason: string },
  actorId: string,
) {
  return db.transaction(async (tx) => {
    const row = required(
      (
        await tx.query<{ status: string; user_id: string; payload: PreparedProvider }>(
          'SELECT status,user_id,payload FROM submissions WHERE id=$1 FOR UPDATE',
          [id],
        )
      )[0],
    );
    if (row.status !== 'pending')
      throw new AppError(409, 'ALREADY_REVIEWED', 'Submission already reviewed');
    const provider = input.approve ? await createProvider(tx, row.payload, actorId) : null;
    await tx.query(
      'UPDATE submissions SET status=$1,reason=$2,reviewer_id=$3,provider_id=$4,reviewed_at=now() WHERE id=$5',
      [input.approve ? 'approved' : 'rejected', input.reason, actorId, provider?.id ?? null, id],
    );
    await audit(tx, actorId, 'submission.review', id, { approve: input.approve });
    await notifySubmissionResult(
      tx,
      config,
      {
        id,
        userId: row.user_id,
        name: row.payload.name,
        approved: input.approve,
        reason: input.reason,
      },
      provider ? { id: provider.id, name: row.payload.name, slug: row.payload.slug } : undefined,
    );
    return { providerId: provider?.id ?? null };
  });
}
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
