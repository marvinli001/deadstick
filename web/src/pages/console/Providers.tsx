import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { Button } from '@/components/arc/button/button';
import { Drawer, DrawerContent, useDrawerItem } from '@/components/arc/drawer/drawer';
import { Pagination } from '@/components/arc/pagination/pagination';
import { SearchField } from '@/components/arc/search-field/search-field';
import { Switch } from '@/components/arc/switch/switch';
import { useToastStack } from '@/components/arc/toast-stack/toast-stack';
import { useDebounced } from '@/components/AirportSearch';
import { HealthMark, LifecycleMark } from '@/components/marks';
import { ProviderForm } from '@/components/ProviderForm';
import { ErrorView, Loading } from '@/components/states';
import { safeSearchTerm } from '@/lib/submissionDraft';
import { api, errorText } from '@/lib/api';
import { ago } from '@/lib/format';
import type { AdminProvider, Lifecycle, Page } from '@/lib/types';
import { ProviderPanel } from './ProviderPanel';
import { Filter, PageHead, Table, Toolbar, type Column } from './shared';
import styles from './console.module.css';

const LIMIT = 30;
type LifecycleFilter = Lifecycle | 'all';
const lifecycles: { value: LifecycleFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'active', label: '存活' },
  { value: 'suspected', label: '疑似' },
  { value: 'dead', label: '已跑路' },
];

function MonitorSwitch({ provider }: { provider: AdminProvider }) {
  const client = useQueryClient();
  const { toast } = useToastStack();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      api(`/admin/providers/${provider.id}/monitoring`, { method: 'PATCH', body: { enabled } }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['admin', 'providers'] }),
    onError: (error) => toast({ type: 'error', title: errorText(error) }),
  });
  return (
    <Switch
      aria-label={`监测 ${provider.name}`}
      checked={toggle.isPending ? toggle.variables : provider.enabled}
      disabled={toggle.isPending}
      onCheckedChange={(enabled) => toggle.mutate(enabled)}
    />
  );
}

export default function Providers() {
  const client = useQueryClient();
  const { toast } = useToastStack();
  const [q, setQ] = useState('');
  const term = useDebounced(safeSearchTerm(q));
  const [lifecycle, setLifecycle] = useState<LifecycleFilter>('all');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const shown = useDrawerItem(selected);

  const query = { q: term || undefined, lifecycle: lifecycle === 'all' ? undefined : lifecycle };
  const providers = useQuery({
    queryKey: ['admin', 'providers', query, page],
    queryFn: () =>
      api<Page<AdminProvider>>('/admin/providers', {
        query: { ...query, limit: LIMIT, offset: (page - 1) * LIMIT },
      }),
    placeholderData: keepPreviousData,
  });
  const total = providers.data?.total ?? 0;

  const columns: Column<AdminProvider>[] = [
    {
      key: 'name',
      label: '名称',
      sortable: true,
      render: (_, p) => (
        <button
          type="button"
          className={styles.cellLink}
          onClick={() => setSelected({ id: p.id, name: p.name })}
        >
          {p.name}
        </button>
      ),
    },
    { key: 'slug', label: '标识', render: (v) => <span className={styles.mono}>{String(v)}</span> },
    {
      key: 'lifecycle',
      label: '状态',
      sortable: true,
      render: (_, p) => <LifecycleMark value={p.lifecycle} size="sm" />,
    },
    {
      key: 'health',
      label: '健康',
      sortable: true,
      render: (_, p) => <HealthMark value={p.health} />,
    },
    { key: 'failure_streak', label: '连败', sortable: true, numeric: true },
    {
      key: 'website_count',
      label: '官网/订阅',
      render: (_, p) => (
        <span
          className={styles.mono}
        >{`${p.website_count ?? 0}/${p.subscription_count ?? 0}`}</span>
      ),
    },
    {
      key: 'next_check_at',
      label: '下次检测',
      sortable: true,
      render: (_, p) => (
        <span className={styles.mono}>
          {p.enabled && p.lifecycle !== 'dead' ? ago(p.next_check_at) : '—'}
        </span>
      ),
    },
    { key: 'enabled', label: '监测', render: (_, p) => <MonitorSwitch provider={p} /> },
  ];

  return (
    <>
      <PageHead title="机场" total={providers.data ? total : undefined}>
        <Button onClick={() => setCreating(true)}>
          <Plus size={16} strokeWidth={1.75} />
          录入
        </Button>
      </PageHead>
      <Toolbar>
        <div className={styles.grow}>
          <SearchField
            label="搜机场"
            placeholder="名称或标识"
            value={q}
            onValueChange={(v) => {
              setQ(v);
              setPage(1);
            }}
          />
        </div>
        <Filter
          label="状态"
          value={lifecycle}
          options={lifecycles}
          onChange={(v) => {
            setLifecycle(v);
            setPage(1);
          }}
        />
      </Toolbar>
      {providers.isPending ? (
        <Loading lines={6} />
      ) : providers.isError ? (
        <ErrorView error={providers.error} onRetry={() => providers.refetch()} />
      ) : (
        <Table
          caption="机场"
          rows={providers.data.items}
          columns={columns}
          empty={term ? '没有符合的机场' : '还没有收录'}
        />
      )}
      {total > LIMIT && (
        <div className={styles.pager}>
          <Pagination page={page} pageCount={Math.ceil(total / LIMIT)} onPageChange={setPage} />
        </div>
      )}

      <Drawer open={Boolean(selected)} onOpenChange={(open) => !open && setSelected(null)}>
        <DrawerContent title={shown?.name ?? '机场'} side="right" className={styles.drawer}>
          {shown && <ProviderPanel key={shown.id} id={shown.id} />}
        </DrawerContent>
      </Drawer>

      <Drawer open={creating} onOpenChange={setCreating}>
        <DrawerContent title="录入机场" side="right" className={styles.drawer}>
          <ProviderForm
            submitLabel="录入"
            onSubmit={async (input) => {
              const created = await api<{ id: string }>('/admin/providers', {
                method: 'POST',
                body: input,
              });
              await client.invalidateQueries({ queryKey: ['admin', 'providers'] });
              toast({ type: 'success', title: `已录入 ${input.name}` });
              setCreating(false);
              setSelected({ id: created.id, name: input.name });
            }}
          />
        </DrawerContent>
      </Drawer>
    </>
  );
}
