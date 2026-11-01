import { useState } from 'react';
import { Link } from 'react-router';
import { StatusTag } from '@/components/marks';
import { ErrorView, Loading } from '@/components/states';
import { ago, dateTime } from '@/lib/format';
import type { CheckJob } from '@/lib/types';
import { Filter, PageHead, shortId, Table, Toolbar, usePaged, type Column } from './shared';
import styles from './console.module.css';

type Status = CheckJob['status'] | 'all';
const statuses: { value: Status; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'pending', label: '排队' },
  { value: 'running', label: '进行中' },
  { value: 'done', label: '完成' },
  { value: 'failed', label: '失败' },
];

const mono = (v: unknown) => (
  <span className={styles.mono}>{v === null || v === undefined ? '—' : String(v)}</span>
);

const columns: Column<CheckJob>[] = [
  {
    key: 'created_at',
    label: '创建',
    sortable: true,
    render: (_, j) => mono(dateTime(j.created_at)),
  },
  {
    key: 'provider_id',
    label: '机场',
    render: (_, j) => (
      <Link
        to={`/airports/${j.provider_id}`}
        className={styles.mono}
        target="_blank"
        rel="noopener"
      >
        {shortId(j.provider_id)}
      </Link>
    ),
  },
  {
    key: 'status',
    label: '状态',
    sortable: true,
    render: (_, j) => <StatusTag value={j.status} />,
  },
  { key: 'attempts', label: '尝试', sortable: true, numeric: true },
  { key: 'error_code', label: '错误', render: (v) => mono(v) },
  {
    key: 'available_at',
    label: '可执行',
    sortable: true,
    render: (_, j) => mono(j.status === 'pending' ? ago(j.available_at) : null),
  },
  {
    key: 'finished_at',
    label: '结束',
    sortable: true,
    render: (_, j) => mono(j.finished_at ? ago(j.finished_at) : null),
  },
];

export default function Jobs() {
  const [status, setStatus] = useState<Status>('all');
  const list = usePaged<CheckJob>(['admin', 'jobs'], '/admin/jobs', {
    status: status === 'all' ? undefined : status,
  });
  return (
    <>
      <PageHead title="任务" />
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
        <Loading lines={6} />
      ) : list.isError ? (
        <ErrorView error={list.error} onRetry={() => list.refetch()} />
      ) : (
        <Table caption="检测任务" rows={list.items} columns={columns} />
      )}
      {list.pager}
    </>
  );
}
