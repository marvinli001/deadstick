import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { MetricCard } from '@/components/arc/metric-card/metric-card';
import { StatusTag } from '@/components/marks';
import { Loading } from '@/components/states';
import { api } from '@/lib/api';
import { ago, count } from '@/lib/format';
import { useStats } from '@/lib/queries';
import { useSession } from '@/lib/session';
import type { HealthReport } from '@/lib/types';
import { isAdmin, PageHead, useQueue, type Queue } from './shared';
import styles from './console.module.css';

const queues: { queue: Queue; label: string; to: string }[] = [
  { queue: 'incidents', label: '待核验异常', to: '/console/incidents' },
  { queue: 'submissions', label: '待审投稿', to: '/console/submissions' },
  { queue: 'memorials', label: '待审留言', to: '/console/memorials' },
];

function QueueTile({ queue, label, to }: { queue: Queue; label: string; to: string }) {
  const { data } = useQueue(queue);
  return (
    <Link to={to} className={styles.queue} data-hot={data ? '' : undefined}>
      <strong>{data === undefined ? '—' : data >= 100 ? '99+' : data}</strong>
      <span>{label}</span>
    </Link>
  );
}

function SystemHealth() {
  const health = useQuery({
    queryKey: ['admin', 'health'],
    queryFn: () => api<HealthReport>('/admin/health'),
    refetchInterval: 15_000,
  });
  if (health.isPending) return <Loading lines={2} />;
  if (!health.data) return null;
  const { workers, checks, notifications } = health.data;
  return (
    <>
      <section className={styles.section}>
        <h2>
          Worker{' '}
          <span className="mono">
            {workers.filter((w) => w.healthy).length}/{workers.length}
          </span>
        </h2>
        <ul className={styles.rows}>
          {workers.length === 0 && <li>无心跳</li>}
          {workers.map((w) => (
            <li key={w.id}>
              <span className="mono">
                <i className={styles.dot} data-on={w.healthy || undefined} />
                {w.id}
              </span>
              <span className={styles.meta}>{ago(w.last_seen_at)}</span>
            </li>
          ))}
        </ul>
      </section>
      <div className={styles.grid2}>
        {[
          { title: '检测队列', rows: checks },
          { title: '通知队列', rows: notifications },
        ].map((group) => (
          <section key={group.title} className={styles.section}>
            <h2>{group.title}</h2>
            <ul className={styles.rows}>
              {group.rows.length === 0 && <li>空</li>}
              {group.rows.map((row) => (
                <li key={row.status}>
                  <span>
                    <StatusTag value={row.status} />
                  </span>
                  <span className="mono">{count(row.count)}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}

export default function Overview() {
  const { user } = useSession();
  const stats = useStats();
  const s = stats.data;
  return (
    <>
      <PageHead title="总览" />
      {s ? (
        <div className={styles.metrics}>
          <MetricCard label="收录" value={s.total} context={`正常 ${count(s.healthy)}`} />
          <MetricCard
            label="疑似跑路"
            value={s.suspected}
            context={`存活 ${count(s.total - s.dead - s.suspected)}`}
          />
          <MetricCard label="已入土" value={s.dead} context={`祭奠 ${count(s.tributes)}`} />
        </div>
      ) : (
        <Loading lines={2} />
      )}
      <section className={styles.section}>
        <h2>待办</h2>
        <div className={styles.queues}>
          {queues.map((q) => (
            <QueueTile key={q.queue} {...q} />
          ))}
        </div>
      </section>
      {isAdmin(user) && <SystemHealth />}
    </>
  );
}
