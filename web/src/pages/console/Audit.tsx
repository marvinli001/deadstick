import { useState } from 'react';
import { Button } from '@/components/arc/button/button';
import { Dialog, DialogContent } from '@/components/arc/dialog/dialog';
import { JsonViewer } from '@/components/arc/json-viewer/json-viewer';
import { ErrorView, Loading } from '@/components/states';
import { dateTime } from '@/lib/format';
import type { AuditRow } from '@/lib/types';
import { PageHead, shortId, Table, usePaged, type Column } from './shared';
import styles from './console.module.css';

export default function Audit() {
  const list = usePaged<AuditRow>(['admin', 'audit'], '/admin/audit');
  const [active, setActive] = useState<AuditRow | null>(null);

  const columns: Column<AuditRow>[] = [
    {
      key: 'created_at',
      label: '时间',
      sortable: true,
      render: (_, a) => <span className={styles.mono}>{dateTime(a.created_at)}</span>,
    },
    {
      key: 'action',
      label: '操作',
      sortable: true,
      render: (v) => <span className={styles.mono}>{String(v)}</span>,
    },
    {
      key: 'actor_id',
      label: '操作人',
      render: (_, a) => (
        <span className={styles.mono}>{a.actor_id ? shortId(a.actor_id) : '系统'}</span>
      ),
    },
    {
      key: 'target_id',
      label: '对象',
      render: (_, a) => <span className={styles.mono}>{a.target_id ?? '—'}</span>,
    },
    {
      key: 'details',
      label: '',
      render: (_, a) =>
        a.details && Object.keys(a.details).length ? (
          <div className={styles.rowActions}>
            <Button size="sm" variant="ghost" onClick={() => setActive(a)}>
              详情
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <>
      <PageHead title="审计" />
      <div className={styles.toolbar} />
      {list.isPending ? (
        <Loading lines={6} />
      ) : list.isError ? (
        <ErrorView error={list.error} onRetry={() => list.refetch()} />
      ) : (
        <Table caption="审计日志" rows={list.items} columns={columns} />
      )}
      {list.pager}
      <Dialog open={Boolean(active)} onOpenChange={(open) => !open && setActive(null)}>
        <DialogContent title={active?.action ?? '详情'}>
          {active && (
            <JsonViewer
              data={active.details}
              rootName="details"
              defaultExpandDepth={3}
              label="详情"
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
