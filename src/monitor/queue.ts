import { createHash } from 'node:crypto';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import type { MonitorSettings } from '../catalog/schemas.js';
import { notifyIncidentOpened, notifyRecovery } from '../telegram/notifications.js';
import { type CheckEndpoint, type Endpoint, type EndpointResult, summarize } from './check.js';

export async function monitorSettings(db: DB) {
  return (
    await db.query<{ value: MonitorSettings }>("SELECT value FROM settings WHERE key='monitor'")
  )[0]!.value;
}
export async function schedule(db: DB, settings: MonitorSettings, now = Date.now()) {
  return db.transaction(async (tx) => {
    const providers = await tx.query<{ id: string; next_check_at: Date }>(
      "SELECT id,next_check_at FROM providers WHERE enabled AND lifecycle<>'dead' AND next_check_at<=now() ORDER BY next_check_at FOR UPDATE SKIP LOCKED LIMIT $1",
      [settings.batchSize],
    );
    const interval = settings.intervalHours * 3600 * 1000;
    for (const p of providers) {
      const offset = createHash('sha256').update(p.id).digest().readUInt32BE(0) % interval;
      let next = Math.floor(now / interval) * interval + offset;
      if (next <= now) next += interval;
      await tx.query(
        'INSERT INTO check_jobs(provider_id,dedupe_key) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [p.id, `scheduled:${p.id}:${p.next_check_at.toISOString()}`],
      );
      await tx.query('UPDATE providers SET next_check_at=$1 WHERE id=$2', [new Date(next), p.id]);
    }
    return providers.length;
  });
}
export async function claimChecks(db: DB, limit: number) {
  await db.query(
    "UPDATE check_jobs SET status='failed',finished_at=now(),error_code='RETRIES_EXHAUSTED' WHERE attempts>=3 AND (status='pending' OR status='running' AND lease_until<now())",
  );
  return db.transaction(async (tx) => {
    const picked = await tx.query<{ id: string }>(
      `SELECT candidate.id FROM providers p CROSS JOIN LATERAL (
      SELECT j.id,j.available_at FROM check_jobs j WHERE j.provider_id=p.id AND j.attempts<3 AND j.available_at<=now()
      AND (j.status='pending' OR j.status='running' AND j.lease_until<now())
      AND NOT EXISTS(SELECT 1 FROM check_jobs running WHERE running.provider_id=p.id AND running.id<>j.id AND running.status='running' AND running.lease_until>now())
      ORDER BY j.available_at,j.created_at LIMIT 1
    ) candidate ORDER BY candidate.available_at,p.id LIMIT $1 FOR UPDATE OF p SKIP LOCKED`,
      [limit],
    );
    // Keep provider locks while rechecking jobs in a fresh READ COMMITTED snapshot.
    return tx.query<{ id: string; provider_id: string; lease_token: string; attempts: number }>(
      `UPDATE check_jobs j SET status='running',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '30 minutes'
      WHERE j.id=ANY($1::uuid[]) AND j.attempts<3 AND j.available_at<=now()
      AND (j.status='pending' OR j.status='running' AND j.lease_until<now())
      AND NOT EXISTS(SELECT 1 FROM check_jobs running WHERE running.provider_id=j.provider_id AND running.id<>j.id AND running.status='running' AND running.lease_until>now())
      RETURNING j.*`,
      [picked.map((job) => job.id)],
    );
  });
}
export type CheckJob = Awaited<ReturnType<typeof claimChecks>>[number];
export async function runCheck(
  db: DB,
  config: Config,
  job: CheckJob,
  settings: MonitorSettings,
  check: CheckEndpoint,
) {
  try {
    const [provider] = await db.query<{
      id: string;
      name: string;
      slug: string;
      config_version: number;
      enabled: boolean;
      lifecycle: string;
    }>('SELECT * FROM providers WHERE id=$1', [job.provider_id]);
    if (!provider) return;
    const endpoints = await db.query<Endpoint>(
      'SELECT id,kind,url_ciphertext FROM endpoints WHERE provider_id=$1 ORDER BY id',
      [provider.id],
    );
    const results: EndpointResult[] = [];
    if (provider.enabled && provider.lifecycle !== 'dead')
      for (const endpoint of endpoints) results.push(await check(endpoint, settings));
    const summary = summarize(results);
    await db.transaction(async (tx) => {
      // Provider first: catalog edits, scheduling and reviews use the same lock order.
      const [current] = await tx.query<{
        config_version: number;
        lifecycle: string;
        enabled: boolean;
        failure_streak: number;
        last_checked_at: Date | null;
      }>('SELECT * FROM providers WHERE id=$1 FOR UPDATE', [provider.id]);
      const [owned] = await tx.query(
        "SELECT id FROM check_jobs WHERE id=$1 AND status='running' AND lease_token=$2 AND lease_until>now() FOR UPDATE",
        [job.id, job.lease_token],
      );
      if (!owned) return;
      if (
        !current ||
        current.config_version !== provider.config_version ||
        !current.enabled ||
        current.lifecycle === 'dead'
      ) {
        await tx.query(
          "UPDATE check_jobs SET status='done',error_code='CONFIG_CHANGED',finished_at=now(),lease_until=NULL WHERE id=$1",
          [job.id],
        );
        return;
      }
      const [run] = await tx.query<{ id: string }>(
        'INSERT INTO check_runs(job_id,provider_id,health,summary) VALUES ($1,$2,$3,$4) RETURNING id',
        [job.id, provider.id, summary.health, JSON.stringify(summary)],
      );
      for (const r of results)
        await tx.query(
          'INSERT INTO endpoint_results(run_id,endpoint_id,kind,ok,http_status,latency_ms,error_code,node_count,reachable_nodes,sampled_nodes,subscription_expired,quota_exhausted,probe_mode,probe_error_code) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
          [
            run!.id,
            r.endpointId,
            r.kind,
            r.ok,
            r.httpStatus ?? null,
            r.latencyMs,
            r.errorCode ?? null,
            r.nodeCount ?? null,
            r.reachableNodes ?? null,
            r.sampledNodes ?? null,
            r.subscriptionExpired ?? null,
            r.quotaExhausted ?? null,
            r.probeMode ?? null,
            r.probeErrorCode ?? null,
          ],
        );
      const streak = summary.health === 'down' ? current.failure_streak + 1 : 0;
      const suspected = streak >= settings.failureThreshold;
      const lifecycle =
        summary.health === 'unknown' ? current.lifecycle : suspected ? 'suspected' : 'active';
      await tx.query(
        "UPDATE providers SET health=$1,failure_streak=$2,lifecycle=CASE WHEN $3::text='active' AND EXISTS(SELECT 1 FROM incidents WHERE provider_id=$4 AND status='open' AND manual_review) THEN 'suspected' ELSE $3 END,last_checked_at=now(),updated_at=now() WHERE id=$4",
        [summary.health, streak, lifecycle, provider.id],
      );
      if (suspected) {
        const [incident] = await tx.query<{ id: string }>(
          "INSERT INTO incidents(provider_id,summary) VALUES ($1,$2) ON CONFLICT (provider_id) WHERE status='open' DO NOTHING RETURNING id",
          [provider.id, `连续 ${streak} 次检测异常；等待人工二次核验`],
        );
        if (incident)
          await notifyIncidentOpened(
            tx,
            config,
            provider,
            incident.id,
            `连续 ${streak} 次无法通过检测，已请求管理员复核。`,
          );
      } else if (['healthy', 'degraded'].includes(summary.health)) {
        const closed = await tx.query<{ id: string }>(
          "UPDATE incidents SET status='resolved',resolution='自动检测恢复，未确认跑路',resolved_at=now() WHERE provider_id=$1 AND status='open' AND NOT manual_review RETURNING id",
          [provider.id],
        );
        for (const incident of closed) await notifyRecovery(tx, config, provider, incident.id);
      }
      await tx.query(
        "UPDATE check_jobs SET status='done',finished_at=now(),lease_until=NULL WHERE id=$1",
        [job.id],
      );
    });
  } catch {
    await db.query(
      "UPDATE check_jobs SET status=$1,error_code='CHECK_FAILED',available_at=now()+$2*interval '1 minute',lease_until=NULL,finished_at=CASE WHEN $1='failed' THEN now() END WHERE id=$3 AND lease_token=$4 AND status='running'",
      [job.attempts >= 3 ? 'failed' : 'pending', 2 ** job.attempts, job.id, job.lease_token],
    );
  }
}
export async function cleanup(db: DB, retentionDays: number) {
  await db.query('DELETE FROM sessions WHERE expires_at<now()');
  await db.query('DELETE FROM auth_challenges WHERE expires_at<now()');
  await db.query('DELETE FROM auth_replays WHERE expires_at<now()');
  await db.query('DELETE FROM bot_conversations WHERE expires_at<now()');
  await db.query('DELETE FROM mcp_authorizations WHERE expires_at<now()');
  await db.query('DELETE FROM mcp_codes WHERE expires_at<now()');
  await db.query(
    "DELETE FROM mcp_connections WHERE expires_at<now() OR revoked_at<now()-interval '30 days'",
  );
  await db.query(
    "DELETE FROM mcp_clients WHERE created_at<now()-interval '30 days' AND NOT EXISTS (SELECT 1 FROM mcp_connections WHERE client_id=mcp_clients.id) AND NOT EXISTS (SELECT 1 FROM mcp_authorizations WHERE client_id=mcp_clients.id) AND NOT EXISTS (SELECT 1 FROM mcp_codes WHERE client_id=mcp_clients.id)",
  );
  await db.query(
    "DELETE FROM check_jobs WHERE status IN ('done','failed') AND finished_at<now()-$1*interval '1 day'",
    [retentionDays],
  );
  await db.query(
    "DELETE FROM notifications WHERE status IN ('sent','failed') AND created_at<now()-$1*interval '1 day'",
    [retentionDays],
  );
  await db.query(
    "DELETE FROM bot_updates WHERE status IN ('done','failed') AND created_at<now()-interval '7 days'",
  );
  await db.query("DELETE FROM bot_rate_limits WHERE window_start<now()-interval '1 day'");
}
