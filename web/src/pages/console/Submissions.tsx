import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Alert } from '@/components/arc/alert/alert';
import { Button } from '@/components/arc/button/button';
import { Dialog, DialogContent } from '@/components/arc/dialog/dialog';
import { Textarea } from '@/components/arc/textarea/textarea';
import { useToastStack } from '@/components/arc/toast-stack/toast-stack';
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
  { value: 'approved', label: '已通过' },
  { value: 'rejected', label: '已驳回' },
];

function ReviewForm({ submission, onDone }: { submission: AdminSubmission; onDone: () => void }) {
  const client = useQueryClient();
  const { toast } = useToastStack();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);

  const review = async (approve: boolean) => {
    if (!reason.trim()) return setError('写一句审核意见');
    setBusy(approve ? 'approve' : 'reject');
    setError(null);
    try {
      await api(`/admin/submissions/${submission.id}/review`, {
        method: 'POST',
        body: { approve, reason: reason.trim() },
      });
      await client.invalidateQueries({ queryKey: ['admin'] });
      toast({ type: 'success', title: approve ? `已收录 ${submission.provider.name}` : '已驳回' });
      onDone();
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
      <div className={styles.formActions}>
        <Button
          variant="secondary"
          loading={busy === 'reject'}
          disabled={Boolean(busy)}
          onClick={() => review(false)}
        >
          驳回
        </Button>
        <Button loading={busy === 'approve'} disabled={Boolean(busy)} onClick={() => review(true)}>
          通过并收录
        </Button>
      </div>
    </div>
  );
}

export default function Submissions() {
  const [status, setStatus] = useState<Status>('pending');
  const [active, setActive] = useState<AdminSubmission | null>(null);
  const list = usePaged<AdminSubmission>(['admin', 'submissions'], '/admin/submissions', {
    status,
  });

  return (
    <>
      <PageHead title="投稿" />
      <Toolbar>
        <Filter
          value={status}
          options={statuses}
          onChange={(v) => {
            setStatus(v);
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
                {s.provider.description && <p>{s.provider.description}</p>}
                {s.provider.tags.length > 0 && (
                  <p className={styles.tags}>
                    {s.provider.tags.map((t) => (
                      <span key={t}>#{t}</span>
                    ))}
                  </p>
                )}
                <p className={styles.meta}>
                  {dateTime(s.created_at)} · 地址 {s.endpoint_count} · 投稿人 {shortId(s.user_id)}
                </p>
                {s.reason && <p className={styles.quote}>{s.reason}</p>}
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
      <Dialog open={Boolean(active)} onOpenChange={(open) => !open && setActive(null)}>
        <DialogContent title={active ? `审核 ${active.provider.name}` : '审核'}>
          {active && (
            <ReviewForm key={active.id} submission={active} onDone={() => setActive(null)} />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
