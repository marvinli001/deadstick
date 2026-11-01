import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, Pencil, RefreshCw, Sprout, TriangleAlert } from 'lucide-react';
import { Alert } from '@/components/arc/alert/alert';
import { Button } from '@/components/arc/button/button';
import { Textarea } from '@/components/arc/textarea/textarea';
import { useToastStack } from '@/components/arc/toast-stack/toast-stack';
import { HealthMark, LifecycleMark } from '@/components/marks';
import { ProviderForm } from '@/components/ProviderForm';
import { ErrorView, Loading } from '@/components/states';
import { api, errorText } from '@/lib/api';
import { ago, dateTime } from '@/lib/format';
import { useChecks } from '@/lib/queries';
import type { AdminEndpoint, AdminProvider, CheckRun, EndpointResult, Page } from '@/lib/types';
import { EvidenceField, parseUrls, validEvidence } from './shared';
import styles from './console.module.css';

type Mode = 'view' | 'edit' | 'incident' | 'revive';

function useRefresh(id: string) {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ['admin'] }),
      client.invalidateQueries({ queryKey: ['provider'] }),
      client.invalidateQueries({ queryKey: ['checks', id] }),
    ]);
}

function Results({ run, endpoints }: { run: CheckRun; endpoints: AdminEndpoint[] }) {
  const results = useQuery({
    queryKey: ['admin', 'results', run.id],
    queryFn: () => api<Page<EndpointResult>>(`/admin/checks/${run.id}/results`),
  });
  if (results.isPending) return <div className={styles.results}>…</div>;
  if (results.isError)
    return <div className={`${styles.results} ${styles.error}`}>{errorText(results.error)}</div>;
  const hostOf = (id: string | null) =>
    endpoints.find((e) => e.id === id)?.display_host ?? '已删除';
  return (
    <div className={styles.results}>
      {results.data.items.map((r) => (
        <div key={r.id}>
          <span className={r.ok ? styles.ok : styles.error}>{r.ok ? 'OK ' : 'ERR'}</span>{' '}
          {r.kind === 'website' ? '官网' : '订阅'} {hostOf(r.endpoint_id)} · {r.http_status ?? '—'}{' '}
          · {r.latency_ms}ms
          {r.error_code && ` · ${r.error_code}`}
          {r.node_count !== null &&
            ` · 节点 ${r.reachable_nodes ?? 0}/${r.sampled_nodes ?? 0}/${r.node_count}`}
          {r.probe_mode && ` · ${r.probe_mode}`}
          {r.subscription_expired && ' · 已过期'}
          {r.quota_exhausted && ' · 流量用尽'}
        </div>
      ))}
    </div>
  );
}

function Runs({ id, endpoints }: { id: string; endpoints: AdminEndpoint[] }) {
  const checks = useChecks(id, 12);
  const [open, setOpen] = useState<string | null>(null);
  if (checks.isPending) return <Loading lines={2} />;
  if (checks.isError) return <ErrorView error={checks.error} onRetry={() => checks.refetch()} />;
  const runs = checks.data?.items ?? [];
  if (!runs.length) return <p className={styles.meta}>无</p>;
  return (
    <ul className={styles.rows}>
      {runs.map((run) => (
        <li key={run.id}>
          <button
            type="button"
            className={styles.runButton}
            aria-expanded={open === run.id}
            onClick={() => setOpen(open === run.id ? null : run.id)}
          >
            <span className={styles.meta}>{dateTime(run.created_at)}</span>
            <HealthMark value={run.health} />
            <span className={styles.mono}>
              官网 {run.summary.website.up}/{run.summary.website.total} · 订阅{' '}
              {run.summary.subscription.up}/{run.summary.subscription.total} ·{' '}
              {run.summary.nodeProbe}
            </span>
          </button>
          {open === run.id && <Results run={run} endpoints={endpoints} />}
        </li>
      ))}
    </ul>
  );
}

function ReasonForm({
  title,
  withEvidence,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  title: string;
  withEvidence: boolean;
  submitLabel: string;
  onSubmit: (text: string, evidence: string[]) => Promise<void>;
  onCancel: () => void;
}) {
  const [text, setText] = useState('');
  const [evidence, setEvidence] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const urls = parseUrls(evidence);
    if (text.trim().length < 3) return setError('至少 3 个字');
    const invalid = withEvidence ? validEvidence(urls) : null;
    if (invalid) return setError(invalid);
    setBusy(true);
    setError(null);
    try {
      await onSubmit(text.trim(), urls);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <form className={styles.form} onSubmit={submit}>
      <Alert open={Boolean(error)} tone="danger" title={error ?? ''} />
      <Textarea
        label={title}
        rows={4}
        maxLength={2000}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {withEvidence && <EvidenceField value={evidence} onChange={setEvidence} />}
      <div className={styles.formActions}>
        <Button type="button" variant="ghost" onClick={onCancel}>
          取消
        </Button>
        <Button type="submit" loading={busy}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

export function ProviderPanel({ id }: { id: string }) {
  const { toast } = useToastStack();
  const refresh = useRefresh(id);
  const [mode, setMode] = useState<Mode>('view');
  const [checking, setChecking] = useState(false);
  const provider = useQuery({
    queryKey: ['admin', 'provider', id],
    queryFn: () => api<AdminProvider>(`/admin/providers/${id}`),
  });
  const endpoints = useQuery({
    queryKey: ['admin', 'provider', id, 'endpoints'],
    queryFn: () =>
      api<Page<AdminEndpoint>>(`/admin/providers/${id}/endpoints`).then((r) => r.items),
  });

  if (provider.isPending || endpoints.isPending) return <Loading lines={5} />;
  if (provider.isError)
    return <ErrorView error={provider.error} onRetry={() => provider.refetch()} />;
  if (endpoints.isError)
    return <ErrorView error={endpoints.error} onRetry={() => endpoints.refetch()} />;
  const p = provider.data;
  const eps = endpoints.data ?? [];
  const done = async (title: string) => {
    await refresh();
    toast({ type: 'success', title });
    setMode('view');
  };

  const checkNow = async () => {
    setChecking(true);
    try {
      await api(`/admin/providers/${id}/check`, { method: 'POST' });
      toast({ type: 'success', title: '已排队检测' });
      void refresh();
    } catch (error) {
      toast({ type: 'error', title: errorText(error) });
    } finally {
      setChecking(false);
    }
  };

  if (mode === 'edit')
    return (
      <ProviderForm
        submitLabel="保存"
        onCancel={() => setMode('view')}
        initial={{
          name: p.name,
          slug: p.slug,
          description: p.description,
          tags: p.tags,
          websites: eps
            .filter((e) => e.kind === 'website')
            .map((e) => ({ url: e.public_url ?? '', label: e.label })),
          subscriptionHosts: eps
            .filter((e) => e.kind === 'subscription')
            .map((e) => e.display_host),
        }}
        onSubmit={async (input) => {
          await api(`/admin/providers/${id}`, { method: 'PUT', body: input });
          await done('已保存');
        }}
      />
    );

  return (
    <div className={styles.panel}>
      <header className={styles.panelHead}>
        <Link to={`/airports/${p.slug}`} className={styles.site} target="_blank" rel="noopener">
          <span className="mono">{p.slug}</span>
          <ArrowUpRight size={14} strokeWidth={1.75} aria-hidden="true" />
        </Link>
        <div className={styles.headActions}>
          <Button
            size="sm"
            loading={checking}
            disabled={!p.enabled || p.lifecycle === 'dead'}
            onClick={checkNow}
          >
            <RefreshCw size={15} strokeWidth={1.75} />
            立即检测
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setMode('edit')}>
            <Pencil size={15} strokeWidth={1.75} />
            编辑
          </Button>
          {p.lifecycle === 'dead' ? (
            <Button size="sm" variant="secondary" onClick={() => setMode('revive')}>
              <Sprout size={15} strokeWidth={1.75} />
              复活
            </Button>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => setMode('incident')}>
              <TriangleAlert size={15} strokeWidth={1.75} />
              开异常
            </Button>
          )}
        </div>
      </header>

      {mode === 'incident' && (
        <ReasonForm
          title="异常摘要"
          withEvidence={false}
          submitLabel="开异常"
          onCancel={() => setMode('view')}
          onSubmit={async (summary) => {
            await api(`/admin/providers/${id}/incidents`, { method: 'POST', body: { summary } });
            await done('已开异常，等待核验');
          }}
        />
      )}
      {mode === 'revive' && (
        <ReasonForm
          title="复活理由"
          withEvidence
          submitLabel="复活"
          onCancel={() => setMode('view')}
          onSubmit={async (reason, evidenceUrls) => {
            await api(`/admin/providers/${id}/revive`, {
              method: 'POST',
              body: { reason, evidenceUrls },
            });
            await done('已复活');
          }}
        />
      )}

      <dl className={styles.facts}>
        <div>
          <dt>状态</dt>
          <dd>
            <LifecycleMark value={p.lifecycle} size="sm" />
          </dd>
        </div>
        <div>
          <dt>健康</dt>
          <dd>
            <HealthMark value={p.health} />
          </dd>
        </div>
        <div>
          <dt>连败</dt>
          <dd className="mono">{p.failure_streak}</dd>
        </div>
        <div>
          <dt>监测</dt>
          <dd>{p.enabled ? '开' : '关'}</dd>
        </div>
        <div>
          <dt>最近检测</dt>
          <dd className="mono">{ago(p.last_checked_at)}</dd>
        </div>
        <div>
          <dt>下次检测</dt>
          <dd className="mono">{ago(p.next_check_at)}</dd>
        </div>
      </dl>

      <section className={styles.block}>
        <h4>地址</h4>
        <ul className={styles.rows}>
          {eps.map((e) => (
            <li key={e.id}>
              <span className="mono">{e.display_host}</span>
              <span className={styles.meta}>{e.kind === 'website' ? '官网' : '订阅'}</span>
              {e.label && <span>{e.label}</span>}
            </li>
          ))}
        </ul>
      </section>

      <section className={styles.block}>
        <h4>检测</h4>
        <Runs id={id} endpoints={eps} />
      </section>
    </div>
  );
}
