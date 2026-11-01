import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RotateCw } from 'lucide-react';
import { Button } from '@/components/arc/button/button';
import { useToastStack } from '@/components/arc/toast-stack/toast-stack';
import { StatusTag } from '@/components/marks';
import { ErrorView, Loading } from '@/components/states';
import { api, errorText } from '@/lib/api';
import { ago, dateTime } from '@/lib/format';
import type { NotificationRow } from '@/lib/types';
import { PageHead, Table, usePaged, type Column } from './shared';
import styles from './console.module.css';

const mono = (v: unknown) => (
  <span className={styles.mono}>{v === null || v === undefined ? '—' : String(v)}</span>
);

export default function Notifications() {
  const client = useQueryClient();
  const { toast } = useToastStack();
  const list = usePaged<NotificationRow>(['admin', 'notifications'], '/admin/notifications');
  const retry = useMutation({
    mutationFn: (id: string) => api(`/admin/notifications/${id}/retry`, { method: 'POST' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['admin', 'notifications'] });
      toast({ type: 'success', title: '已重新排队' });
    },
    onError: (error) => toast({ type: 'error', title: errorText(error) }),
  });

  const columns: Column<NotificationRow>[] = [
    {
      key: 'created_at',
      label: '创建',
      sortable: true,
      render: (_, n) => mono(dateTime(n.created_at)),
    },
    {
      key: 'chat_id',
      label: '会话',
      render: (_, n) => mono(n.topic_id ? `${n.chat_id} #${n.topic_id}` : n.chat_id),
    },
    { key: 'method', label: '方法', render: (v) => mono(v ?? 'sendMessage') },
    {
      key: 'status',
      label: '状态',
      sortable: true,
      render: (_, n) => <StatusTag value={n.status} />,
    },
    { key: 'attempts', label: '尝试', sortable: true, numeric: true },
    { key: 'error_code', label: '错误', render: (v) => mono(v) },
    {
      key: 'sent_at',
      label: '发送',
      sortable: true,
      render: (_, n) => mono(n.sent_at ? ago(n.sent_at) : null),
    },
    {
      key: 'id',
      label: '',
      render: (_, n) =>
        n.status === 'failed' ? (
          <div className={styles.rowActions}>
            <Button
              size="sm"
              variant="ghost"
              loading={retry.isPending && retry.variables === n.id}
              onClick={() => retry.mutate(n.id)}
            >
              <RotateCw size={14} strokeWidth={1.75} />
              重试
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <>
      <PageHead title="通知" />
      <div className={styles.toolbar} />
      {list.isPending ? (
        <Loading lines={6} />
      ) : list.isError ? (
        <ErrorView error={list.error} onRetry={() => list.refetch()} />
      ) : (
        <Table caption="通知" rows={list.items} columns={columns} />
      )}
      {list.pager}
    </>
  );
}
