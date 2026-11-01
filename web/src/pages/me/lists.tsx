import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/arc/button/button';
import { useToastStack } from '@/components/arc/toast-stack/toast-stack';
import { HealthMark, LifecycleMark, StatusTag } from '@/components/marks';
import { Empty, ErrorView, Loading } from '@/components/states';
import { api, errorText } from '@/lib/api';
import { ago, day } from '@/lib/format';
import type { MySubmission, Page, Provider } from '@/lib/types';
import styles from './me.module.css';

export function MeFollows() {
  const client = useQueryClient();
  const { toast } = useToastStack();
  const follows = useQuery({
    queryKey: ['follows'],
    queryFn: () => api<Page<Provider>>('/follows', { query: { limit: 100 } }),
  });
  const unfollow = useMutation({
    mutationFn: (id: string) => api(`/providers/${id}/follow`, { method: 'DELETE' }),
    onSuccess: (_, id) => {
      client.setQueryData<Page<Provider>>(['follows'], (old) =>
        old ? { ...old, items: old.items.filter((p) => p.id !== id) } : old,
      );
      void client.invalidateQueries({ queryKey: ['provider'] });
    },
    onError: (error) => toast({ type: 'error', title: errorText(error) }),
  });

  if (follows.isPending) return <Loading lines={4} />;
  if (follows.isError) return <ErrorView error={follows.error} onRetry={() => follows.refetch()} />;
  const items = follows.data.items;
  if (!items.length)
    return (
      <Empty
        title="还没有关注"
        action={
          <Link className={styles.textLink} to="/airports">
            去机场库
          </Link>
        }
      />
    );

  return (
    <ul className={styles.list}>
      {items.map((p) => (
        <li key={p.id} data-lifecycle={p.lifecycle}>
          <Link to={`/airports/${p.slug}`} className={styles.name}>
            {p.name}
          </Link>
          <HealthMark value={p.health} />
          <span className={`${styles.meta} mono`}>{ago(p.last_checked_at)}</span>
          <LifecycleMark value={p.lifecycle} size="sm" />
          <Button
            variant="ghost"
            size="sm"
            loading={unfollow.isPending && unfollow.variables === p.id}
            onClick={() => unfollow.mutate(p.id)}
          >
            取消关注
          </Button>
        </li>
      ))}
    </ul>
  );
}

export function MeSubmissions() {
  const submissions = useQuery({
    queryKey: ['submissions', 'mine'],
    queryFn: () => api<Page<MySubmission>>('/submissions/mine', { query: { limit: 100 } }),
  });

  if (submissions.isPending) return <Loading lines={4} />;
  if (submissions.isError)
    return <ErrorView error={submissions.error} onRetry={() => submissions.refetch()} />;
  const items = submissions.data.items;
  if (!items.length)
    return (
      <Empty
        title="还没有投稿"
        action={
          <Link className={styles.textLink} to="/submit">
            投稿
          </Link>
        }
      />
    );

  return (
    <ul className={styles.list}>
      {items.map((s) => (
        <li key={s.id} className={styles.submission}>
          {s.provider_id ? (
            <Link to={`/airports/${s.provider_id}`} className={styles.name}>
              {s.name}
            </Link>
          ) : (
            <span className={styles.name}>{s.name}</span>
          )}
          <span className={`${styles.meta} mono`}>{day(s.created_at)}</span>
          <StatusTag value={s.status} />
          {s.reason && <p className={styles.reason}>{s.reason}</p>}
        </li>
      ))}
    </ul>
  );
}
