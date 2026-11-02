import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Alert } from '@/components/arc/alert/alert';
import { Button } from '@/components/arc/button/button';
import { Dialog, DialogContent } from '@/components/arc/dialog/dialog';
import { Textarea } from '@/components/arc/textarea/textarea';
import { useToastStack } from '@/components/arc/toast-stack/toast-stack';
import { leadLabels } from '@/components/SubmissionForm';
import { StatusTag } from '@/components/marks';
import { Empty, ErrorView, Loading } from '@/components/states';
import { api, errorText } from '@/lib/api';
import { dateTime } from '@/lib/format';
import type { AdminSubmission } from '@/lib/types';
import { Filter, PageHead, shortId, Toolbar, usePaged } from './shared';
import styles from './console.module.css';

type Status = AdminSubmission['status'];
const statuses: { value: Status; label: string }[] = [
  { value: 'pending', label: '待审' },
  { value: 'needs_info', label: '待补充' },
  { value: 'approved', label: '已通过' },
  { value: 'rejected', label: '已驳回' },
];

function SubmissionDetails({ submission: s }: { submission: AdminSubmission }) {
  return (
    <>
      {s.kind !== 'provider' && <p>{leadLabels[s.kind]}</p>}
      {s.websites.map((site) => (
        <p key={site.url}>
          <a href={site.url} target="_blank" rel="noopener noreferrer nofollow">
            {site.url}
          </a>
        </p>
      ))}
      {s.provider.report && (
        <>
          <p>{s.provider.report.body}</p>
          {s.provider.report.evidenceUrls.map((url) => (
            <p key={url}>
              <a href={url} target="_blank" rel="noopener noreferrer nofollow">
                {url}
              </a>
            </p>
          ))}
        </>
      )}
      {s.provider.description && <p>{s.provider.description}</p>}
      {s.provider.tags.length > 0 && (
        <p className={styles.tags}>
          {s.provider.tags.map((t) => (
            <span key={t}>#{t}</span>
          ))}
        </p>
      )}
    </>
  );
}

function ReviewForm({ submission, onDone }: { submission: AdminSubmission; onDone: () => void }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const { toast } = useToastStack();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'approved' | 'rejected' | 'needs_info' | null>(null);

  const review = async (action: 'approved' | 'rejected' | 'needs_info') => {
    if (!reason.trim()) return setError('写一句审核意见');
    setBusy(action);
    setError(null);
    try {
      const result = await api<{ incidentId: string | null }>(
        `/admin/submissions/${submission.id}/review`,
        {
          method: 'POST',
          body: { action, reason: reason.trim() },
        },
      );
      await client.invalidateQueries({ queryKey: ['admin'] });
      toast({
        type: 'success',
        title: action === 'approved' ? '已通过' : action === 'needs_info' ? '已退回补充' : '已驳回',
      });
      onDone();
      if (result.incidentId) navigate(`/console/incidents?id=${result.incidentId}`);
    } catch (err) {
      setError(errorText(err));
      setBusy(null);
    }
  };

  return (
    <div className={styles.form}>
      <Alert open={Boolean(error)} tone="danger" title={error ?? ''} />
      <Textarea
        label="审核意见"
        rows={3}
        maxLength={1000}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <SubmissionDetails submission={submission} />
      {submission.kind !== 'provider' && submission.provider_id && (
        <a href={`/airports/${submission.provider_id}`}>查看机场</a>
      )}
      <div className={styles.formActions}>
        <Button
          variant="secondary"
          loading={busy === 'needs_info'}
          disabled={Boolean(busy)}
          onClick={() => review('needs_info')}
        >
          待补充
        </Button>
        <Button
          variant="secondary"
          loading={busy === 'rejected'}
          disabled={Boolean(busy)}
          onClick={() => review('rejected')}
        >
          驳回
        </Button>
        <Button
          loading={busy === 'approved'}
          disabled={Boolean(busy)}
          onClick={() => review('approved')}
        >
          {submission.kind === 'provider'
            ? '通过并收录'
            : submission.kind === 'website'
              ? '通过并补入官网'
              : '接收并复核'}
        </Button>
      </div>
    </div>
  );
}

export default function Submissions() {
  const [params, setParams] = useSearchParams();
  const target = params.get('id');
  const [status, setStatus] = useState<Status>('pending');
  const [selected, setActive] = useState<AdminSubmission | null>(null);
  const list = usePaged<AdminSubmission>(['admin', 'submissions'], '/admin/submissions', {
    status,
    id: target ?? undefined,
  });
  const active =
    selected ??
    (target && list.items[0]?.id === target && list.items[0].status === 'pending'
      ? list.items[0]
      : null);
  const close = () => {
    setActive(null);
    setParams({}, { replace: true });
  };

  return (
    <>
      <PageHead title="投稿" />
      <Toolbar>
        <Filter
          value={status}
          options={statuses}
          onChange={(v) => {
            setStatus(v);
            setParams({}, { replace: true });
            list.reset();
          }}
        />
      </Toolbar>
      {list.isPending ? (
        <Loading lines={4} />
      ) : list.isError ? (
        <ErrorView error={list.error} onRetry={() => list.refetch()} />
      ) : !list.items.length ? (
        <Empty title={status === 'pending' ? '没有待审投稿' : '无'} />
      ) : (
        <ul className={styles.cards}>
          {list.items.map((s) => (
            <li key={s.id} className={styles.card}>
              <div className={styles.cardTitle}>
                <strong>{s.provider.name}</strong>
                <span className={styles.mono}>{s.provider.slug}</span>
                <StatusTag value={s.status} />
              </div>
              <div className={styles.cardBody}>
                <SubmissionDetails submission={s} />
                <p className={styles.meta}>
                  {dateTime(s.created_at)} · 地址 {s.endpoint_count} · 投稿人 {shortId(s.user_id)}
                </p>
                {s.reason && <p className={styles.quote}>{s.reason}</p>}
                {s.incident_id && (
                  <Link to={`/console/incidents?id=${s.incident_id}`}>继续复核</Link>
                )}
              </div>
              {s.status === 'pending' && (
                <div className={styles.cardActions}>
                  <Button size="sm" onClick={() => setActive(s)}>
                    审核
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {list.pager}
      <Dialog open={Boolean(active)} onOpenChange={(open) => !open && close()}>
        <DialogContent title={active ? `审核 ${active.provider.name}` : '审核'}>
          {active && <ReviewForm key={active.id} submission={active} onDone={close} />}
        </DialogContent>
      </Dialog>
    </>
  );
}
