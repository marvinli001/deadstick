import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/arc/button/button';
import { useToastStack } from '@/components/arc/toast-stack/toast-stack';
import { StatusTag } from '@/components/marks';
import { Empty, ErrorView, Loading } from '@/components/states';
import { api, errorText } from '@/lib/api';
import { dateTime } from '@/lib/format';
import type { AdminMemorial } from '@/lib/types';
import { Filter, PageHead, shortId, Toolbar, usePaged } from './shared';
import styles from './console.module.css';

type Status = AdminMemorial['status'];
const statuses: { value: Status; label: string }[] = [
  { value: 'pending', label: '待审' },
  { value: 'visible', label: '公开' },
  { value: 'hidden', label: '隐藏' },
];

export default function Memorials() {
  const client = useQueryClient();
  const { toast } = useToastStack();
  const [status, setStatus] = useState<Status>('pending');
  const list = usePaged<AdminMemorial>(['admin', 'memorials'], '/admin/memorials', { status });
  const moderate = useMutation({
    mutationFn: ({ id, visible }: { id: string; visible: boolean }) =>
      api(`/admin/memorials/${id}`, { method: 'PATCH', body: { visible } }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['admin'] });
      void client.invalidateQueries({ queryKey: ['memorials'] });
    },
    onError: (error) => toast({ type: 'error', title: errorText(error) }),
  });
  const busy = (id: string, visible: boolean) =>
    moderate.isPending && moderate.variables?.id === id && moderate.variables.visible === visible;

  return (
    <>
      <PageHead title="留言" />
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
        <Empty title={status === 'pending' ? '没有待审留言' : '无'} />
      ) : (
        <ul className={styles.cards}>
          {list.items.map((m) => (
            <li key={m.id} className={styles.card}>
              <div className={styles.cardTitle}>
                <Link to={`/airports/${m.provider_id}`} target="_blank" rel="noopener">
                  {m.provider_name}
                </Link>
                <StatusTag value={m.status} />
              </div>
              <div className={styles.cardBody}>
                <p className={styles.quote}>{m.body}</p>
                <p className={styles.meta}>
                  {m.author_name ?? shortId(m.user_id)} · {dateTime(m.created_at)}
                </p>
              </div>
              <div className={styles.cardActions}>
                {m.status !== 'visible' && (
                  <Button
                    size="sm"
                    loading={busy(m.id, true)}
                    onClick={() => moderate.mutate({ id: m.id, visible: true })}
                  >
                    <Eye size={15} strokeWidth={1.75} />
                    公开
                  </Button>
                )}
                {m.status !== 'hidden' && (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busy(m.id, false)}
                    onClick={() => moderate.mutate({ id: m.id, visible: false })}
                  >
                    <EyeOff size={15} strokeWidth={1.75} />
                    隐藏
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {list.pager}
    </>
  );
}
