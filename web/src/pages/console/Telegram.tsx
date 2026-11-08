import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, RotateCw, Send } from 'lucide-react';
import { Alert } from '@/components/arc/alert/alert';
import { Button } from '@/components/arc/button/button';
import { Dialog, DialogContent } from '@/components/arc/dialog/dialog';
import { HoldToConfirm } from '@/components/arc/hold-to-confirm/hold-to-confirm';
import { Input } from '@/components/arc/input/input';
import { JsonViewer } from '@/components/arc/json-viewer/json-viewer';
import { Select } from '@/components/arc/select/select';
import { Switch } from '@/components/arc/switch/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/arc/tabs/tabs';
import { Textarea } from '@/components/arc/textarea/textarea';
import { useToastStack } from '@/components/arc/toast-stack/toast-stack';
import { StatusTag } from '@/components/marks';
import { Empty, ErrorView, Loading } from '@/components/states';
import { api, apiForm, errorText } from '@/lib/api';
import { dateTime } from '@/lib/format';
import type { BotUpdate, Page, TelegramChat } from '@/lib/types';
import { PageHead, Table, usePaged, type Column } from './shared';
import styles from './console.module.css';
import TelegramSettings from './TelegramSettings';

const kinds = [{ value: 'admin', label: '管理员私聊' }];

function BindForm() {
  const client = useQueryClient();
  const { toast } = useToastStack();
  const [id, setId] = useState('');
  const [kind, setKind] = useState<TelegramChat['kind']>('admin');
  const [topic, setTopic] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!/^-?\d{1,20}$/.test(id.trim())) return setError('会话 ID 是数字，群组以 - 开头');
    if (topic && !/^\d+$/.test(topic)) return setError('话题 ID 是正整数');
    setBusy(true);
    setError(null);
    try {
      await api(`/admin/telegram/chats/${id.trim()}`, {
        method: 'PUT',
        body: { kind, enabled: true, ...(topic ? { topicId: Number(topic) } : {}) },
      });
      await client.invalidateQueries({ queryKey: ['admin', 'telegram', 'chats'] });
      toast({ type: 'success', title: '已绑定' });
      setId('');
      setTopic('');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className={styles.form} onSubmit={submit}>
      <Alert open={Boolean(error)} tone="danger" title={error ?? ''} />
      <div className={styles.grid2}>
        <Input
          label="会话 ID"
          className="mono"
          inputMode="numeric"
          placeholder="-100…"
          value={id}
          onChange={(e) => setId(e.target.value)}
        />
        <Select
          label="类型"
          options={kinds}
          value={kind}
          onValueChange={(v) => setKind(v as TelegramChat['kind'])}
        />
        <Input
          label="话题 ID"
          className="mono"
          inputMode="numeric"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
        />
      </div>
      <div className={styles.formActions}>
        <Button type="submit" loading={busy}>
          绑定
        </Button>
      </div>
    </form>
  );
}

function Chats() {
  const client = useQueryClient();
  const { toast } = useToastStack();
  const chats = useQuery({
    queryKey: ['admin', 'telegram', 'chats'],
    queryFn: () =>
      api<Page<TelegramChat>>('/admin/telegram/chats').then((r) =>
        r.items.filter((chat) => chat.kind === 'admin'),
      ),
  });
  const refresh = () => client.invalidateQueries({ queryKey: ['admin', 'telegram', 'chats'] });
  const onError = (error: unknown) => toast({ type: 'error', title: errorText(error) });
  const toggle = useMutation({
    mutationFn: (chat: TelegramChat & { next: boolean }) =>
      api(`/admin/telegram/chats/${chat.id}`, {
        method: 'PUT',
        body: {
          kind: chat.kind,
          enabled: chat.next,
          ...(chat.topic_id ? { topicId: chat.topic_id } : {}),
        },
      }),
    onSuccess: refresh,
    onError,
  });
  const unbind = useMutation({
    mutationFn: (id: string) => api(`/admin/telegram/chats/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError,
  });

  return (
    <>
      {chats.isPending ? (
        <Loading lines={3} />
      ) : chats.isError ? (
        <ErrorView error={chats.error} onRetry={() => chats.refetch()} />
      ) : !chats.data.length ? (
        <Empty title="还没有绑定会话" />
      ) : (
        <ul className={styles.rows}>
          {chats.data.map((c) => (
            <li key={c.id}>
              <span>
                {c.title}{' '}
                <span className={styles.mono}>{c.topic_id ? `${c.id} #${c.topic_id}` : c.id}</span>
              </span>
              <span className={styles.meta}>{kinds.find((k) => k.value === c.kind)?.label}</span>
              {c.kind === 'group' && <Link to={`/groups/${c.id}`}>群设置</Link>}
              <Switch
                aria-label={`启用 ${c.title}`}
                checked={c.enabled}
                disabled={toggle.isPending}
                onCheckedChange={(next) => toggle.mutate({ ...c, next })}
              />
              <HoldToConfirm
                label="解绑"
                confirmedLabel="已解绑"
                tone="danger"
                onConfirm={() => unbind.mutate(c.id)}
              />
            </li>
          ))}
        </ul>
      )}
      <section className={styles.section}>
        <h2>绑定会话</h2>
        <BindForm />
      </section>
    </>
  );
}

function Updates() {
  const client = useQueryClient();
  const { toast } = useToastStack();
  const list = usePaged<BotUpdate>(['admin', 'telegram', 'updates'], '/admin/telegram/updates');
  const [viewing, setViewing] = useState<string | null>(null);
  const payload = useQuery({
    queryKey: ['admin', 'telegram', 'update', viewing],
    queryFn: () =>
      api<{ update: unknown }>(`/admin/telegram/updates/${viewing}`).then((r) => r.update),
    enabled: Boolean(viewing),
  });
  const retry = useMutation({
    mutationFn: (id: string) => api(`/admin/telegram/updates/${id}/retry`, { method: 'POST' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['admin', 'telegram', 'updates'] });
      toast({ type: 'success', title: '已重新排队' });
    },
    onError: (error) => toast({ type: 'error', title: errorText(error) }),
  });
  const rows = list.items.map((u) => ({ ...u, id: u.update_id }));
  const columns: Column<(typeof rows)[number]>[] = [
    {
      key: 'update_id',
      label: 'update_id',
      sortable: true,
      render: (v) => <span className={styles.mono}>{String(v)}</span>,
    },
    {
      key: 'status',
      label: '状态',
      sortable: true,
      render: (_, u) => <StatusTag value={u.status} />,
    },
    { key: 'attempts', label: '尝试', numeric: true },
    {
      key: 'created_at',
      label: '收到',
      sortable: true,
      render: (_, u) => <span className={styles.mono}>{dateTime(u.created_at)}</span>,
    },
    {
      key: 'id',
      label: '',
      render: (_, u) => (
        <div className={styles.rowActions}>
          <Button size="sm" variant="ghost" onClick={() => setViewing(u.update_id)}>
            <Eye size={14} strokeWidth={1.75} />
            查看
          </Button>
          {u.status === 'failed' && (
            <Button
              size="sm"
              variant="ghost"
              loading={retry.isPending && retry.variables === u.update_id}
              onClick={() => retry.mutate(u.update_id)}
            >
              <RotateCw size={14} strokeWidth={1.75} />
              重试
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      {list.isPending ? (
        <Loading lines={5} />
      ) : list.isError ? (
        <ErrorView error={list.error} onRetry={() => list.refetch()} />
      ) : (
        <Table caption="Bot 更新" rows={rows} columns={columns} />
      )}
      {list.pager}
      <Dialog open={Boolean(viewing)} onOpenChange={(open) => !open && setViewing(null)}>
        <DialogContent title={`update ${viewing ?? ''}`}>
          {payload.isPending ? (
            <Loading lines={4} />
          ) : payload.isError ? (
            <ErrorView error={payload.error} />
          ) : (
            <JsonViewer
              data={payload.data}
              rootName="update"
              defaultExpandDepth={2}
              searchable
              label="更新内容"
              maxHeight="60vh"
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function BotApi() {
  const [method, setMethod] = useState('getMe');
  const [params, setParams] = useState('{}');
  const [field, setField] = useState('photo');
  const fileRef = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<unknown>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!/^[a-zA-Z][a-zA-Z0-9]{0,79}$/.test(method)) return setError('方法名不对');
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(params || '{}') as Record<string, unknown>;
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    } catch {
      return setError('参数要是 JSON 对象');
    }
    const file = fileRef.current?.files?.[0];
    setBusy(true);
    setError(null);
    try {
      if (file) {
        const form = new FormData();
        for (const [key, value] of Object.entries(body))
          form.append(key, typeof value === 'string' ? value : JSON.stringify(value));
        form.append(field || 'document', file, file.name);
        setResult(
          (await apiForm<{ result: unknown }>(`/admin/telegram/upload/${method}`, form)).result,
        );
      } else {
        setResult(
          (
            await api<{ result: unknown }>(`/admin/telegram/api/${method}`, {
              method: 'POST',
              body,
            })
          ).result,
        );
      }
    } catch (err) {
      setResult(undefined);
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className={styles.form} onSubmit={send}>
      <Alert open={Boolean(error)} tone="danger" title={error ?? ''} />
      <Input
        label="方法"
        className="mono"
        spellCheck={false}
        value={method}
        onChange={(e) => setMethod(e.target.value.trim())}
      />
      <Textarea
        label="参数 JSON"
        className="mono"
        rows={6}
        spellCheck={false}
        value={params}
        onChange={(e) => setParams(e.target.value)}
      />
      <div className={styles.grid2}>
        <Input
          label="文件字段"
          className="mono"
          value={field}
          onChange={(e) => setField(e.target.value.trim())}
        />
        <label className={styles.file}>
          <span>文件</span>
          <input ref={fileRef} type="file" />
        </label>
      </div>
      <div className={styles.formActions}>
        <Button type="submit" loading={busy}>
          <Send size={15} strokeWidth={1.75} />
          调用
        </Button>
      </div>
      {result !== undefined && (
        <JsonViewer
          data={result}
          rootName="result"
          defaultExpandDepth={2}
          label="返回"
          maxHeight="50vh"
        />
      )}
    </form>
  );
}

export default function Telegram() {
  return (
    <>
      <PageHead title="Telegram">
        <Link to="/console/groups">群组管理</Link>
      </PageHead>
      <Tabs defaultValue="settings" className={styles.tabs}>
        <TabsList aria-label="Telegram">
          <TabsTrigger value="settings">配置</TabsTrigger>
          <TabsTrigger value="chats">会话</TabsTrigger>
          <TabsTrigger value="updates">更新</TabsTrigger>
          <TabsTrigger value="api">Bot API</TabsTrigger>
        </TabsList>
        <TabsContent value="settings">
          <TelegramSettings />
        </TabsContent>
        <TabsContent value="chats">
          <Chats />
        </TabsContent>
        <TabsContent value="updates">
          <Updates />
        </TabsContent>
        <TabsContent value="api">
          <BotApi />
        </TabsContent>
      </Tabs>
    </>
  );
}
