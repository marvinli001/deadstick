import { randomUUID } from 'node:crypto';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { AppError, required } from '../errors.js';
import { validateUrl } from '../monitor/network.js';
import {
  audit,
  createProvider,
  insertEndpoints,
  prepareProvider,
  providerColumns,
  type PreparedProvider,
} from './service.js';
import { searchProviders } from './search.js';
import type { LeadInput, SubmissionInput, SubmissionReview } from './schemas.js';
import {
  notifySubmission,
  notifySubmissionResult,
  notifyIncidentOpened,
} from '../telegram/notifications.js';

type Author = { id: string; display_name: string };
export type SubmissionPayload = PreparedProvider & {
  report?: { kind: LeadInput['kind']; body: string; evidenceUrls: string[] };
};
type Submission = {
  id: string;
  status: string;
  user_id: string;
  kind: string;
  provider_id: string | null;
  incident_id: string | null;
  payload: SubmissionPayload;
  revision: number;
};
export const safeSubmissionColumns = `s.id,s.kind,s.payload->>'name' AS name,s.status,s.reason,s.provider_id,
  s.created_at,s.reviewed_at,s.revision,s.incident_id,s.payload - 'endpoints' AS provider,
  jsonb_array_length(s.payload->'endpoints') AS endpoint_count,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('url',e->>'public_url','label',e->>'label')),'[]'::jsonb)
    FROM jsonb_array_elements(s.payload->'endpoints') e WHERE e->>'kind'='website') AS websites,
  (SELECT count(*)::int FROM jsonb_array_elements(s.payload->'endpoints') e WHERE e->>'kind'='subscription') AS subscription_count`;

export function prepareSubmission(input: SubmissionInput, config: Config) {
  const base =
    input.name
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 40)
      .replace(/^-+|-+$/g, '') || 'airport';
  return prepareProvider({ ...input, slug: input.slug ?? `${base}-${randomUUID()}` }, config);
}
export async function duplicateProviders(db: DB, name: string, websites: string[]) {
  const matches: { id: string; name: string; slug: string; lifecycle: string }[][] = [];
  for (const query of [name, ...websites].filter(Boolean))
    matches.push(
      await searchProviders<{ id: string; name: string; slug: string; lifecycle: string }>(
        db,
        `SELECT ${providerColumns}`,
        query,
        100,
        0,
        { exact: true },
      ),
    );
  return [...new Map(matches.flat().map((p) => [p.id, p])).values()];
}
async function checkDuplicate(db: DB, payload: PreparedProvider, excludeId?: string) {
  const websites = payload.endpoints.filter((e) => e.kind === 'website').map((e) => e.display_host);
  if ((await duplicateProviders(db, payload.name, websites)).length)
    throw new AppError(409, 'DUPLICATE_PROVIDER', 'Provider may already exist');
  const [pending] = await db.query(
    `SELECT id FROM submissions WHERE kind='provider' AND status IN ('pending','needs_info')
      AND ($3::uuid IS NULL OR id<>$3) AND (lower(payload->>'name')=lower($1)
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(payload->'endpoints') e
        WHERE e->>'kind'='website' AND e->>'display_host'=ANY($2::text[]))) LIMIT 1`,
    [payload.name, websites, excludeId ?? null],
  );
  if (pending) throw new AppError(409, 'DUPLICATE_SUBMISSION', 'Submission already pending');
}
async function announce(
  db: DB,
  config: Config,
  row: { id: string; revision: number },
  payload: SubmissionPayload,
  user: Author,
) {
  await notifySubmission(db, config, {
    id: row.id,
    revision: row.revision,
    name: payload.name,
    slug: payload.slug,
    hosts: payload.endpoints.filter((e) => e.kind === 'website').map((e) => e.display_host),
    subscriptions: payload.endpoints.filter((e) => e.kind === 'subscription').length,
    author: user.display_name,
    kind: payload.report?.kind,
  });
}
export async function createSubmission(
  db: DB,
  config: Config,
  user: Author,
  payload: PreparedProvider,
  sourceUpdateId: number | null = null,
) {
  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(73912682)');
    if (
      sourceUpdateId !== null &&
      (await tx.query('SELECT id FROM submissions WHERE source_update_id=$1', [sourceUpdateId]))
        .length
    )
      return undefined;
    await checkDuplicate(tx, payload);
    const [row] = await tx.query<{
      id: string;
      status: string;
      created_at: Date;
      revision: number;
    }>(
      'INSERT INTO submissions(user_id,payload,source_update_id) VALUES ($1,$2,$3) RETURNING id,status,created_at,revision',
      [user.id, JSON.stringify(payload), sourceUpdateId],
    );
    await announce(tx, config, row!, payload, user);
    return row!;
  });
}
function publicUrl(value: string) {
  const url = validateUrl(value);
  return `${url.origin}${url.pathname}`;
}
async function prepareLead(
  db: DB,
  config: Config,
  providerId: string,
  input: LeadInput,
): Promise<SubmissionPayload> {
  if (input.body.trim().length < 3) throw new AppError(400, 'LEAD_REQUIRED', 'Lead required');
  const p = required(
    (
      await db.query<{ name: string; slug: string; description: string; tags: string[] }>(
        'SELECT name,slug,description,tags FROM providers WHERE id=$1',
        [providerId],
      )
    )[0],
  );
  if (input.kind === 'website' && !input.website)
    throw new AppError(400, 'WEBSITE_REQUIRED', 'Website required');
  return {
    ...prepareProvider(
      {
        name: p.name,
        slug: p.slug,
        endpoints: input.website ? [{ kind: 'website', url: publicUrl(input.website) }] : [],
      },
      config,
    ),
    report: {
      kind: input.kind,
      body: input.body.trim(),
      evidenceUrls: (input.evidenceUrls ?? []).map(publicUrl),
    },
  };
}
export async function createLead(
  db: DB,
  config: Config,
  user: Author,
  providerId: string,
  input: LeadInput,
) {
  return db.transaction(async (tx) => {
    const payload = await prepareLead(tx, config, providerId, input);
    const [row] = await tx.query<{ id: string; status: string; revision: number }>(
      'INSERT INTO submissions(user_id,payload,kind,provider_id) VALUES ($1,$2,$3,$4) RETURNING id,status,revision',
      [user.id, JSON.stringify(payload), input.kind, providerId],
    );
    await announce(tx, config, row!, payload, user);
    return row!;
  });
}
export async function supplementSubmission(
  db: DB,
  config: Config,
  user: Author,
  id: string,
  input: SubmissionInput | LeadInput,
) {
  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(73912682)');
    const row = required(
      (
        await tx.query<Submission>(
          'SELECT * FROM submissions WHERE id=$1 AND user_id=$2 FOR UPDATE',
          [id, user.id],
        )
      )[0],
    );
    if (row.status !== 'needs_info')
      throw new AppError(409, 'NOT_AWAITING_INFO', 'Submission is not awaiting more information');
    if ((row.kind === 'provider') === 'kind' in input)
      throw new AppError(400, 'SUBMISSION_KIND', 'Submission kind mismatch');
    const payload: SubmissionPayload =
      'kind' in input
        ? await prepareLead(tx, config, row.provider_id!, input)
        : prepareSubmission(input, config);
    if (row.kind === 'provider') {
      payload.slug = row.payload.slug;
      if (!payload.endpoints.some((e) => e.kind === 'subscription'))
        payload.endpoints.push(...row.payload.endpoints.filter((e) => e.kind === 'subscription'));
      await checkDuplicate(tx, payload, id);
    }
    const [updated] = await tx.query<{ id: string; revision: number }>(
      "UPDATE submissions SET payload=$1,kind=$2,status='pending',reason=NULL,reviewer_id=NULL,reviewed_at=NULL,revision=revision+1 WHERE id=$3 RETURNING id,revision",
      [JSON.stringify(payload), payload.report?.kind ?? 'provider', id],
    );
    await audit(tx, user.id, 'submission.supplement', id);
    await announce(tx, config, updated!, payload, user);
    return { ok: true };
  });
}
async function acceptLead(db: DB, config: Config, row: Submission, actorId: string) {
  const p = required(
    (
      await db.query<{ id: string; name: string; slug: string; lifecycle: string }>(
        'SELECT id,name,slug,lifecycle FROM providers WHERE id=$1 FOR UPDATE',
        [row.provider_id],
      )
    )[0],
  );
  if (row.kind === 'website') {
    for (const endpoint of row.payload.endpoints) {
      const exists = await db.query(
        "SELECT id FROM endpoints WHERE provider_id=$1 AND kind='website' AND public_url=$2",
        [p.id, endpoint.public_url],
      );
      if (!exists.length) await insertEndpoints(db, p.id, [endpoint]);
    }
    await db.query(
      'UPDATE providers SET config_version=config_version+1,next_check_at=now(),updated_at=now() WHERE id=$1',
      [p.id],
    );
    await audit(db, actorId, 'provider.update', p.id, { submissionId: row.id });
  } else {
    // User text and evidence remain private until the reviewer writes a public resolution.
    const [existing] = await db.query<{ id: string }>(
      "SELECT id FROM incidents WHERE provider_id=$1 AND status='open'",
      [p.id],
    );
    const incident =
      existing ??
      (
        await db.query<{ id: string }>(
          "INSERT INTO incidents(provider_id,summary,manual_review) VALUES ($1,'已接收用户线索，等待人工复核',true) RETURNING id",
          [p.id],
        )
      )[0]!;
    if (existing)
      await db.query('UPDATE incidents SET manual_review=true WHERE id=$1', [incident.id]);
    await db.query('UPDATE submissions SET incident_id=$1 WHERE id=$2', [incident.id, row.id]);
    row.incident_id = incident.id;
    if (p.lifecycle !== 'dead') {
      await db.query(
        "UPDATE providers SET lifecycle='suspected',config_version=config_version+1,updated_at=now() WHERE id=$1",
        [p.id],
      );
      if (!existing)
        await notifyIncidentOpened(db, config, p, incident.id, '审核员已接收线索，等待人工复核');
    }
    if (!existing)
      await audit(db, actorId, 'incident.create', incident.id, { submissionId: row.id });
    await audit(db, actorId, 'submission.accept_lead', row.id, {
      providerId: p.id,
      incidentId: incident.id,
    });
  }
  return p;
}
export async function editSubmission(
  db: DB,
  config: Config,
  id: string,
  revision: number,
  input: SubmissionInput | LeadInput,
  actorId: string,
) {
  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(73912682)');
    const row = required(
      (await tx.query<Submission>('SELECT * FROM submissions WHERE id=$1 FOR UPDATE', [id]))[0],
    );
    if (row.revision !== revision)
      throw new AppError(409, 'SUBMISSION_CHANGED', 'Submission changed');
    if (!['pending', 'needs_info'].includes(row.status))
      throw new AppError(409, 'ALREADY_REVIEWED', 'Submission already reviewed');
    if ((row.kind === 'provider') === 'kind' in input)
      throw new AppError(400, 'SUBMISSION_KIND', 'Submission kind mismatch');
    const payload: SubmissionPayload =
      'kind' in input
        ? await prepareLead(tx, config, required(row.provider_id ?? undefined), input)
        : prepareSubmission(input, config);
    if (row.kind === 'provider') {
      payload.slug = row.payload.slug;
      if (!payload.endpoints.some((e) => e.kind === 'subscription'))
        payload.endpoints.push(...row.payload.endpoints.filter((e) => e.kind === 'subscription'));
      await checkDuplicate(tx, payload, id);
    }
    const [updated] = await tx.query<{ id: string; revision: number }>(
      'UPDATE submissions SET payload=$1,kind=$2,revision=revision+1 WHERE id=$3 RETURNING id,revision',
      [JSON.stringify(payload), payload.report?.kind ?? 'provider', id],
    );
    await audit(tx, actorId, 'submission.edit', id, { revision: updated!.revision });
    return updated!;
  });
}
export async function reviewSubmission(
  db: DB,
  config: Config,
  id: string,
  input: SubmissionReview,
  actorId: string,
) {
  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(73912682)');
    const row = required(
      (await tx.query<Submission>('SELECT * FROM submissions WHERE id=$1 FOR UPDATE', [id]))[0],
    );
    if (row.revision !== (input.revision ?? 1))
      throw new AppError(409, 'SUBMISSION_CHANGED', '投稿已更新，请刷新审核后重试。');
    if (row.status !== 'pending')
      throw new AppError(409, 'ALREADY_REVIEWED', 'Submission already reviewed');
    const status = 'action' in input ? input.action : input.approve ? 'approved' : 'rejected';
    if (!input.reason.trim()) throw new AppError(400, 'REASON_REQUIRED', 'Reason required');
    let provider: { id: string; name: string; slug: string } | undefined;
    if (status === 'approved') {
      if (row.kind === 'provider') {
        if (
          (
            await duplicateProviders(
              tx,
              row.payload.name,
              row.payload.endpoints.filter((e) => e.kind === 'website').map((e) => e.display_host),
            )
          ).length
        )
          throw new AppError(409, 'DUPLICATE_PROVIDER', 'Provider may already exist');
        provider = {
          ...(await createProvider(tx, row.payload, actorId)),
          name: row.payload.name,
          slug: row.payload.slug,
        };
      } else provider = await acceptLead(tx, config, row, actorId);
    }
    await tx.query(
      'UPDATE submissions SET status=$1,reason=$2,reviewer_id=$3,provider_id=coalesce($4,provider_id),reviewed_at=now() WHERE id=$5',
      [status, input.reason.trim(), actorId, provider?.id ?? null, id],
    );
    await audit(tx, actorId, 'submission.review', id, { action: status, revision: row.revision });
    await notifySubmissionResult(
      tx,
      config,
      {
        id,
        userId: row.user_id,
        name: row.payload.name,
        approved: status === 'approved',
        status,
        reason: input.reason.trim(),
        revision: row.revision,
      },
      provider,
    );
    return { providerId: provider?.id ?? row.provider_id, incidentId: row.incident_id };
  });
}
