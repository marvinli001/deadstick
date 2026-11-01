import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { SearchField } from '@/components/arc/search-field/search-field';
import { Select } from '@/components/arc/select/select';
import { Switch } from '@/components/arc/switch/switch';
import { useToastStack } from '@/components/arc/toast-stack/toast-stack';
import { useDebounced } from '@/components/AirportSearch';
import { ErrorView, Loading } from '@/components/states';
import { api, errorText } from '@/lib/api';
import { day, roleLabel } from '@/lib/format';
import { useSession } from '@/lib/session';
import type { AdminUser, Role } from '@/lib/types';
import { Filter, PageHead, Table, Toolbar, usePaged, type Column } from './shared';
import styles from './console.module.css';

type RoleFilter = Role | 'all';
const roles: { value: RoleFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'admin', label: '管理员' },
  { value: 'moderator', label: '审核员' },
  { value: 'user', label: '用户' },
];
const roleOptions = (['user', 'moderator', 'admin'] as Role[]).map((r) => ({
  value: r,
  label: roleLabel[r],
}));

export default function Users() {
  const { user: me } = useSession();
  const client = useQueryClient();
  const { toast } = useToastStack();
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim());
  const [role, setRole] = useState<RoleFilter>('all');
  const list = usePaged<AdminUser>(['admin', 'users'], '/admin/users', {
    q: term || undefined,
    role: role === 'all' ? undefined : role,
  });
  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string; role: Role; disabled: boolean }) =>
      api(`/admin/users/${id}`, { method: 'PATCH', body }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['admin', 'users'] });
      toast({ type: 'success', title: '已更新，对方需重新登录' });
    },
    onError: (error) => toast({ type: 'error', title: errorText(error) }),
  });

  const columns: Column<AdminUser>[] = [
    { key: 'display_name', label: '昵称', sortable: true },
    {
      key: 'email',
      label: '邮箱',
      sortable: true,
      render: (v) => <span className={styles.mono}>{String(v ?? '—')}</span>,
    },
    {
      key: 'telegram_id',
      label: 'Telegram',
      render: (v) => <span className={styles.mono}>{String(v ?? '—')}</span>,
    },
    {
      key: 'role',
      label: '角色',
      sortable: true,
      render: (_, u) => (
        <div className={styles.bare}>
          <Select
            label={`${u.display_name} 的角色`}
            options={roleOptions}
            value={u.role}
            disabled={u.id === me?.id || update.isPending}
            onValueChange={(value) =>
              update.mutate({ id: u.id, role: value as Role, disabled: u.disabled })
            }
          />
        </div>
      ),
    },
    {
      key: 'disabled',
      label: '启用',
      render: (_, u) => (
        <Switch
          aria-label={`启用 ${u.display_name}`}
          checked={!u.disabled}
          disabled={u.id === me?.id || update.isPending}
          onCheckedChange={(on) => update.mutate({ id: u.id, role: u.role, disabled: !on })}
        />
      ),
    },
    {
      key: 'created_at',
      label: '注册',
      sortable: true,
      render: (_, u) => <span className={styles.mono}>{day(u.created_at)}</span>,
    },
  ];

  return (
    <>
      <PageHead title="用户" />
      <Toolbar>
        <div className={styles.grow}>
          <SearchField
            label="搜用户"
            placeholder="邮箱、昵称或 Telegram ID"
            value={q}
            onValueChange={(v) => {
              setQ(v);
              list.reset();
            }}
          />
        </div>
        <Filter
          label="角色"
          value={role}
          options={roles}
          onChange={(v) => {
            setRole(v);
            list.reset();
          }}
        />
      </Toolbar>
      {list.isPending ? (
        <Loading lines={6} />
      ) : list.isError ? (
        <ErrorView error={list.error} onRetry={() => list.refetch()} />
      ) : (
        <Table caption="用户" rows={list.items} columns={columns} empty="没有符合的用户" />
      )}
      {list.pager}
    </>
  );
}
