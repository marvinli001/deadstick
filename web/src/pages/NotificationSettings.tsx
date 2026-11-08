import { useState, type FormEvent } from 'react';
import { useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/arc/button/button';
import { Alert } from '@/components/arc/alert/alert';
import { Checkbox } from '@/components/arc/checkbox/checkbox';
import { Input } from '@/components/arc/input/input';
import { Select } from '@/components/arc/select/select';
import { Switch } from '@/components/arc/switch/switch';
import { TagInput } from '@/components/arc/tag-input/tag-input';
import { Textarea } from '@/components/arc/textarea/textarea';
import { useToastStack } from '@/components/arc/toast-stack/toast-stack';
import { useDebounced } from '@/components/AirportSearch';
import { ErrorView, Loading } from '@/components/states';
import { api, errorText } from '@/lib/api';
import type { Page, Provider } from '@/lib/types';
import styles from './NotificationSettings.module.css';

const labels = {
  anomaly: '异常',
  recovery: '恢复',
  dead: '已跑路',
  dismissed: '排除异常',
  revival: '复活',
};
type EventType = keyof typeof labels;
interface Policy {
  enabled: boolean;
  conclusionsOnly: boolean;
  scope: 'all' | 'providers' | 'tags';
  providerIds: string[];
  tags: string[];
  events: EventType[];
  mode: 'realtime' | 'digest';
  timezone: string;
  quietStart: string | null;
  quietEnd: string | null;
  digestAt: string;
  minIntervalSeconds: number;
  mergeSeconds: number;
  tone: 'restrained' | 'playful';
}
export interface NotificationSettings {
  chat_id?: string;
  title?: string;
  active?: boolean;
  query_enabled?: boolean;
  guest_enabled?: boolean;
  approval_status?: 'pending' | 'approved' | 'rejected';
  admin_note?: string;
  topic_id?: number | null;
  policy: Policy;
  presets: Record<string, Policy>;
}
const titles = {
  anomaly: '检测异常',
  recovery: '检测恢复',
  dead: '已跑路',
  dismissed: '异常解除',
  revival: '恢复运营',
};

function ProviderPicker({ ids, onChange }: { ids: string[]; onChange: (ids: string[]) => void }) {
  const [search, setSearch] = useState('');
  const term = useDebounced(search.trim());
  const results = useQuery({
    queryKey: ['notification-providers', term],
    queryFn: () => api<Page<Provider>>('/providers', { query: { q: term, limit: 20 } }),
  });
  const selected = useQuery({
    queryKey: ['notification-provider-selection', ids],
    queryFn: () => Promise.all(ids.map((id) => api<Provider>(`/providers/${id}`))),
    enabled: ids.length > 0,
  });
  const providers = new Map(
    [...(selected.data ?? []), ...(results.data?.items ?? [])].map((p) => [p.id, p]),
  );
  return (
    <div className={styles.field}>
      <Input
        label="机场"
        placeholder="搜名称或域名"
        value={search}
        maxLength={120}
        onChange={(e) => setSearch(e.target.value)}
      />
      {results.isError && <ErrorView error={results.error} />}
      <div className={styles.options}>
        {[...providers.values()].map((p) => (
          <Checkbox
            key={p.id}
            label={p.name}
            checked={ids.includes(p.id)}
            onCheckedChange={(on) =>
              onChange(on ? [...ids, p.id] : ids.filter((id) => id !== p.id))
            }
          />
        ))}
      </div>
    </div>
  );
}

export function SettingsForm({
  initial,
  endpoint,
  group = false,
  admin = false,
  onSaved,
}: {
  initial: NotificationSettings;
  endpoint: string;
  group?: boolean;
  admin?: boolean;
  onSaved?: () => void;
}) {
  const { toast } = useToastStack();
  const [policy, setPolicy] = useState(initial.policy);
  const [queries, setQueries] = useState(initial.query_enabled ?? false);
  const [guests, setGuests] = useState(initial.guest_enabled ?? true);
  const [note, setNote] = useState(initial.admin_note ?? '');
  const [topic, setTopic] = useState(initial.topic_id?.toString() ?? '');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saved, setSaved] = useState(initial.active ?? true);
  const [error, setError] = useState<string | null>(null);
  const [sample, setSample] = useState<EventType>('anomaly');
  const change = <K extends keyof Policy>(key: K, value: Policy[K]) =>
    setPolicy((p) => ({ ...p, [key]: value }));
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ active?: boolean }>(endpoint, {
        method: 'PUT',
        body: group
          ? {
              queryEnabled: queries,
              guestEnabled: guests,
              topicId: topic ? Number(topic) : null,
              policy,
              ...(admin ? { note } : {}),
            }
          : policy,
      });
      setSaved(result.active ?? true);
      onSaved?.();
      toast({ type: 'success', title: '已保存' });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setTesting(true);
    setError(null);
    try {
      await api(`${admin ? `/telegram/groups/${initial.chat_id}` : endpoint}/test`, {
        method: 'POST',
        body: {},
      });
      toast({ type: 'success', title: '测试消息已排队' });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setTesting(false);
    }
  };
  return (
    <form className={styles.form} onSubmit={save}>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {group && (
        <>
          {!initial.active && (
            <Alert
              open
              tone="warning"
              title={
                initial.approval_status === 'pending'
                  ? '待审批，配置将在启用后生效'
                  : initial.approval_status === 'rejected'
                    ? '本群已被拒绝'
                    : '本群已停用'
              }
            />
          )}
          <Switch label="群命令与互动" checked={queries} onCheckedChange={setQueries} />
          <Switch label="Guest 查询" checked={guests} onCheckedChange={setGuests} />
        </>
      )}
      <Switch
        label={group ? '主动通知本群' : '关注动态私信'}
        checked={policy.enabled}
        onCheckedChange={(v) => change('enabled', v)}
      />
      {policy.enabled && (
        <>
          <div className={styles.presets} aria-label="通知预设">
            {(
              [
                ['duty', '值班'],
                ['spectator', '吃瓜'],
                ['daily', '日报'],
              ] as const
            ).map(([key, label]) => (
              <Button
                key={key}
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setPolicy({ ...initial.presets[key]! })}
              >
                {label}
              </Button>
            ))}
          </div>
          <Select
            label="接收内容"
            value={policy.conclusionsOnly ? 'conclusions' : 'all'}
            options={[
              { value: 'all', label: '异常与人工结论' },
              { value: 'conclusions', label: '人工结论' },
            ]}
            onValueChange={(v) => change('conclusionsOnly', v === 'conclusions')}
          />
          {group && (
            <>
              <Select
                label="机场范围"
                value={policy.scope}
                options={[
                  { value: 'all', label: '全库' },
                  { value: 'providers', label: '指定机场' },
                  { value: 'tags', label: '指定标签' },
                ]}
                onValueChange={(v) => change('scope', v as Policy['scope'])}
              />
              {policy.scope === 'providers' && (
                <ProviderPicker
                  ids={policy.providerIds}
                  onChange={(ids) => change('providerIds', ids)}
                />
              )}
              {policy.scope === 'tags' && (
                <TagInput
                  label="标签（匹配任一）"
                  value={policy.tags}
                  onValueChange={(tags) => change('tags', tags)}
                />
              )}
              <fieldset className={styles.events}>
                <legend>事件</legend>
                {(Object.keys(labels) as EventType[]).map((type) => (
                  <Checkbox
                    key={type}
                    label={labels[type]}
                    checked={policy.events.includes(type)}
                    onCheckedChange={(on) =>
                      change(
                        'events',
                        on ? [...policy.events, type] : policy.events.filter((e) => e !== type),
                      )
                    }
                  />
                ))}
              </fieldset>
              <Input
                label="目标话题 ID（留空发到主聊天）"
                type="number"
                min={1}
                max={2147483647}
                inputMode="numeric"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
              />
            </>
          )}
          <Select
            label="发送方式"
            value={policy.mode}
            options={[
              { value: 'realtime', label: '实时' },
              { value: 'digest', label: '定时汇总' },
            ]}
            onValueChange={(v) => change('mode', v as Policy['mode'])}
          />
          <Input
            label="时区"
            placeholder="Asia/Shanghai"
            required
            maxLength={80}
            value={policy.timezone}
            onChange={(e) => change('timezone', e.target.value)}
          />
          {policy.mode === 'digest' && (
            <Input
              label="每日汇总时间"
              type="time"
              required
              value={policy.digestAt}
              onChange={(e) => change('digestAt', e.target.value)}
            />
          )}
          <details className={styles.details}>
            <summary>静默与频率</summary>
            <div className={styles.field}>
              <Switch
                label="静默时段"
                checked={policy.quietStart !== null}
                onCheckedChange={(on) =>
                  setPolicy((p) => ({
                    ...p,
                    quietStart: on ? '23:00' : null,
                    quietEnd: on ? '08:00' : null,
                  }))
                }
              />
              {policy.quietStart !== null && (
                <div className={styles.grid}>
                  <Input
                    label="开始"
                    type="time"
                    required
                    value={policy.quietStart}
                    onChange={(e) => change('quietStart', e.target.value)}
                  />
                  <Input
                    label="结束"
                    type="time"
                    required
                    value={policy.quietEnd ?? ''}
                    onChange={(e) => change('quietEnd', e.target.value)}
                  />
                </div>
              )}
              <div className={styles.grid}>
                <Input
                  label="最短发送间隔（秒）"
                  type="number"
                  min={0}
                  max={86400}
                  required
                  value={policy.minIntervalSeconds}
                  onChange={(e) => change('minIntervalSeconds', Number(e.target.value))}
                />
                {policy.mode === 'realtime' && (
                  <Input
                    label="短时合并窗口（秒）"
                    type="number"
                    min={0}
                    max={900}
                    required
                    value={policy.mergeSeconds}
                    onChange={(e) => change('mergeSeconds', Number(e.target.value))}
                  />
                )}
              </div>
            </div>
          </details>
          <Select
            label="口吻"
            value={policy.tone}
            options={[
              { value: 'restrained', label: '克制' },
              { value: 'playful', label: '整活' },
            ]}
            onValueChange={(v) => change('tone', v as Policy['tone'])}
          />
          <details className={styles.details}>
            <summary>样例预览</summary>
            <div className={styles.field}>
              <Select
                label="样例事件"
                value={sample}
                options={(Object.keys(labels) as EventType[]).map((value) => ({
                  value,
                  label: labels[value],
                }))}
                onValueChange={(v) => setSample(v as EventType)}
              />
              <blockquote className={styles.preview}>
                <strong>{titles[sample]}</strong>
                <span>示例机场</span>
              </blockquote>
            </div>
          </details>
        </>
      )}
      {admin && (
        <Textarea
          label="管理备注"
          maxLength={1000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      )}
      <div className={styles.actions}>
        <Button type="submit" loading={busy}>
          保存
        </Button>
        {group && (
          <Button
            type="button"
            variant="secondary"
            loading={testing}
            disabled={!saved || busy}
            onClick={test}
          >
            发送测试消息
          </Button>
        )}
      </div>
    </form>
  );
}

export function GroupSettings() {
  const { chatId } = useParams();
  const endpoint = `/telegram/groups/${encodeURIComponent(chatId ?? '')}`;
  const settings = useQuery({
    queryKey: ['group-settings', chatId],
    queryFn: () => api<NotificationSettings>(endpoint),
    retry: false,
  });
  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <h1>{settings.data?.title ?? '本群设置'}</h1>
      </header>
      {settings.isPending ? (
        <Loading />
      ) : settings.isError ? (
        <ErrorView error={settings.error} onRetry={() => settings.refetch()} />
      ) : (
        <SettingsForm key={chatId} initial={settings.data} endpoint={endpoint} group />
      )}
    </div>
  );
}
export function PersonalNotificationSettings() {
  const endpoint = '/telegram/notifications/preferences';
  const settings = useQuery({
    queryKey: ['notification-preferences'],
    queryFn: () => api<NotificationSettings>(endpoint),
  });
  if (settings.isPending) return <Loading />;
  if (settings.isError)
    return <ErrorView error={settings.error} onRetry={() => settings.refetch()} />;
  return <SettingsForm initial={settings.data} endpoint={endpoint} />;
}
