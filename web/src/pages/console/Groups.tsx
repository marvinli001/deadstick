import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RotateCw } from 'lucide-react';
import { Alert } from '@/components/arc/alert/alert';
import { Button } from '@/components/arc/button/button';
import { Dialog, DialogContent } from '@/components/arc/dialog/dialog';
import { Drawer, DrawerContent, useDrawerItem } from '@/components/arc/drawer/drawer';
import { HoldToConfirm } from '@/components/arc/hold-to-confirm/hold-to-confirm';
import { Input } from '@/components/arc/input/input';
import { SearchField } from '@/components/arc/search-field/search-field';
import { Select } from '@/components/arc/select/select';
import { Switch } from '@/components/arc/switch/switch';
import { useToastStack } from '@/components/arc/toast-stack/toast-stack';
import { useDebounced } from '@/components/AirportSearch';
import { StatusTag } from '@/components/marks';
import { Empty, ErrorView, Loading } from '@/components/states';
import { api, errorText } from '@/lib/api';
import { dateTime } from '@/lib/format';
import type { TelegramGroup } from '@/lib/types';
import { SettingsForm, type NotificationSettings } from '../NotificationSettings';
import { PageHead, Toolbar, usePaged } from './shared';
import styles from './console.module.css';

const membership: Record<string, string> = {
  unknown: '待同步',
  member: '在群',
  administrator: '群管理员',
  creator: '群主',
  restricted: '受限',
  left: '已退出',
  kicked: '被移除',
};
const filters = [
  { value: 'all', label: '全部' },
  { value: 'pending', label: '待审批' },
  { value: 'enabled', label: '已启用' },
  { value: 'disabled', label: '已停用' },
  { value: 'rejected', label: '已拒绝' },
  { value: 'left', label: '已离群' },
];
const base = '/admin/telegram/groups';

function GroupActions({ group }: { group: TelegramGroup }) {
  const client = useQueryClient();
  const { toast } = useToastStack();
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['admin', 'groups'] });
    void client.invalidateQueries({ queryKey: ['admin', 'queue', 'groups'] });
    void client.invalidateQueries({ queryKey: ['admin', 'telegram', 'chats'] });
    void client.invalidateQueries({ queryKey: ['group-settings', group.id] });
  };
  const failure = (error: unknown) => toast({ type: 'error', title: errorText(error) });
  const review = useMutation({
    mutationFn: (approve: boolean) =>
      api(`${base}/${group.id}/review`, { method: 'POST', body: { approve } }),
    onSuccess: (_, approve) =>
      toast({ type: 'success', title: approve ? '已同意并启用' : '已拒绝并退出群组' }),
    onError: failure,
    onSettled: refresh,
  });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      api(`${base}/${group.id}`, { method: 'PUT', body: { enabled } }),
    onError: failure,
    onSuccess: refresh,
  });
  const sync = useMutation({
    mutationFn: () => api(`${base}/${group.id}/sync`, { method: 'POST', body: {} }),
    onError: failure,
    onSuccess: refresh,
  });
  const reopen = useMutation({
    mutationFn: () => api(`${base}/${group.id}/reopen`, { method: 'POST', body: {} }),
    onSuccess: () => {
      refresh();
      toast({ type: 'success', title: '已允许重新加入，入群后可审批' });
    },
    onError: failure,
  });
  const busy = review.isPending || toggle.isPending || sync.isPending || reopen.isPending;
  return (
    <div className={styles.headActions}>
      {group.approval_status === 'approved' ? (
        <Switch
          label="启用"
          checked={group.enabled && group.bot_can_send}
          disabled={busy}
          onCheckedChange={(enabled) => toggle.mutate(enabled)}
          aria-label={`启用 ${group.title}`}
        />
      ) : group.approval_status === 'rejected' ? (
        <Button
          size="sm"
          disabled={busy}
          loading={reopen.isPending}
          onClick={() => reopen.mutate()}
        >
          允许重新加入
        </Button>
      ) : (
        <Button size="sm" disabled={busy} onClick={() => review.mutate(true)}>
          同意并启用
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        loading={sync.isPending}
        disabled={busy}
        onClick={() => sync.mutate()}
        aria-label={`同步 ${group.title}`}
      >
        <RotateCw size={14} strokeWidth={1.75} />
        同步
      </Button>
      {(group.approval_status !== 'rejected' ||
        !['left', 'kicked'].includes(group.bot_member_status)) && (
        <HoldToConfirm
          key={`${group.id}:${group.approval_status}:${group.updated_at}`}
          label="拒绝并退群"
          confirmedLabel="已拒绝"
          tone="danger"
          disabled={busy}
          onConfirm={() => review.mutate(false)}
        />
      )}
    </div>
  );
}

function GroupPanel({ id }: { id: string }) {
  const client = useQueryClient();
  const details = useQuery({
    queryKey: ['admin', 'groups', 'detail', id],
    queryFn: () => api<TelegramGroup & NotificationSettings>(`${base}/${id}`),
  });
  if (details.isPending) return <Loading lines={6} />;
  if (details.isError) return <ErrorView error={details.error} onRetry={() => details.refetch()} />;
  const group = details.data;
  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <div className={styles.tags}>
          <StatusTag value={group.approval_status} />
          <span className="mono">{group.id}</span>
          <span>{membership[group.bot_member_status] ?? group.bot_member_status}</span>
        </div>
        <GroupActions group={group} />
      </div>
      <dl className={styles.facts}>
        <div>
          <dt>邀请人</dt>
          <dd>
            {group.inviter_name ?? '—'}
            {group.inviter_telegram_id && (
              <span className={styles.meta}> · {group.inviter_telegram_id}</span>
            )}
          </dd>
        </div>
        <div>
          <dt>加入时间</dt>
          <dd>{dateTime(group.joined_at)}</dd>
        </div>
        <div>
          <dt>审批时间</dt>
          <dd>{dateTime(group.reviewed_at)}</dd>
        </div>
        <div>
          <dt>离群时间</dt>
          <dd>{dateTime(group.left_at)}</dd>
        </div>
      </dl>
      <SettingsForm
        key={group.updated_at}
        initial={group}
        endpoint={`${base}/${id}`}
        group
        admin
        onSaved={() => {
          void client.invalidateQueries({ queryKey: ['admin', 'groups'] });
          void client.invalidateQueries({ queryKey: ['group-settings', id] });
        }}
      />
    </div>
  );
}

function AddGroup({ onAdded }: { onAdded: (id: string) => void }) {
  const client = useQueryClient();
  const [id, setId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!/^-[0-9]{1,20}$/.test(id.trim())) return setError('群组 ID 以 - 开头，只包含数字');
    setBusy(true);
    setError(null);
    try {
      await api(`${base}/${id.trim()}/sync`, { method: 'POST', body: {} });
      void client.invalidateQueries({ queryKey: ['admin', 'groups'] });
      void client.invalidateQueries({ queryKey: ['admin', 'queue', 'groups'] });
      onAdded(id.trim());
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className={styles.form} onSubmit={submit}>
      <Alert open={Boolean(error)} tone="danger" title={error ?? ''} />
      <Input
        label="群组 ID"
        placeholder="-100…"
        value={id}
        onChange={(e) => setId(e.target.value)}
        required
      />
      <div className={styles.formActions}>
        <Button type="submit" loading={busy}>
          添加
        </Button>
      </div>
    </form>
  );
}

export default function Groups() {
  const client = useQueryClient();
  const { toast } = useToastStack();
  const discover = useMutation({
    mutationFn: () => api<{ imported: number }>(`${base}/discover`, { method: 'POST', body: {} }),
    onSuccess: ({ imported }) => {
      void client.invalidateQueries({ queryKey: ['admin', 'groups'] });
      void client.invalidateQueries({ queryKey: ['admin', 'queue', 'groups'] });
      toast({ type: 'success', title: `已导入 ${imported} 个群组` });
    },
    onError: (error) => toast({ type: 'error', title: errorText(error) }),
  });
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim());
  const [status, setStatus] = useState('all');
  const [selected, setSelected] = useState<{ id: string; title: string } | null>(null);
  const shown = useDrawerItem(selected);
  const [adding, setAdding] = useState(false);
  const list = usePaged<TelegramGroup>(['admin', 'groups', 'list'], base, {
    q: term || undefined,
    status: status === 'all' ? undefined : status,
  });
  return (
    <>
      <PageHead title="群组">
        <Button variant="secondary" loading={discover.isPending} onClick={() => discover.mutate()}>
          导入历史群组
        </Button>
        <Button onClick={() => setAdding(true)}>
          <Plus size={16} strokeWidth={1.75} />
          添加群组
        </Button>
      </PageHead>
      <Toolbar>
        <div className={styles.grow}>
          <SearchField
            label="搜索群组"
            placeholder="群名、用户名或群组 ID"
            value={q}
            onValueChange={(value) => {
              setQ(value);
              list.reset();
            }}
            maxLength={120}
          />
        </div>
        <Select
          label="状态"
          options={filters}
          value={status}
          onValueChange={(value) => {
            setStatus(value);
            list.reset();
          }}
        />
      </Toolbar>
      {list.isPending ? (
        <Loading lines={5} />
      ) : list.isError ? (
        <ErrorView error={list.error} onRetry={() => list.refetch()} />
      ) : !list.items.length ? (
        <Empty title={q || status !== 'all' ? '没有符合的群组' : '尚无群组'} />
      ) : (
        <ul className={styles.cards}>
          {list.items.map((group) => (
            <li key={group.id} className={styles.card}>
              <div className={styles.cardTitle}>
                <button
                  type="button"
                  className={styles.cellLink}
                  onClick={() => setSelected({ id: group.id, title: group.title })}
                >
                  {group.title}
                </button>
                <StatusTag value={group.approval_status} />
                <span className={styles.meta}>
                  {membership[group.bot_member_status] ?? group.bot_member_status}
                </span>
              </div>
              <div className={styles.cardBody}>
                <div className={styles.tags}>
                  <span className="mono">{group.id}</span>
                  {group.username && (
                    <a
                      href={`https://t.me/${group.username}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      @{group.username}
                    </a>
                  )}
                  <span>
                    {group.enabled && group.approval_status === 'approved' && group.bot_can_send
                      ? '已启用'
                      : '未启用'}
                  </span>
                </div>
                <div className={styles.tags}>
                  <span>群命令 {group.query_enabled ? '开' : '关'}</span>
                  <span>Guest {group.guest_enabled ? '开' : '关'}</span>
                  <span>通知 {group.notification_policy.enabled ? '开' : '关'}</span>
                </div>
                {group.inviter_name && (
                  <span className={styles.meta}>
                    邀请人 {group.inviter_name} · {dateTime(group.joined_at)}
                  </span>
                )}
                {group.admin_note && <p>{group.admin_note}</p>}
              </div>
              <div className={styles.cardActions}>
                <GroupActions group={group} />
              </div>
            </li>
          ))}
        </ul>
      )}
      {list.pager}
      <Drawer open={Boolean(selected)} onOpenChange={(open) => !open && setSelected(null)}>
        <DrawerContent title={shown?.title ?? '群组'} side="right" className={styles.drawer}>
          {shown && <GroupPanel id={shown.id} />}
        </DrawerContent>
      </Drawer>
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent title="添加群组">
          <AddGroup
            onAdded={(id) => {
              setAdding(false);
              setSelected({ id, title: '群组' });
            }}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
