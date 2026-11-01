import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert } from '@/components/arc/alert/alert';
import { Button } from '@/components/arc/button/button';
import { Input } from '@/components/arc/input/input';
import { useToastStack } from '@/components/arc/toast-stack/toast-stack';
import { ErrorView, Loading } from '@/components/states';
import { api, errorText } from '@/lib/api';
import styles from './console.module.css';

interface Settings {
  bot_username: string;
  bot_token_set: boolean;
  webhook_secret_set: boolean;
  client_id: string;
  client_secret_set: boolean;
  public_url: string;
  webhook_url: string;
  callback_url: string;
}
interface BotStatus {
  bot_username: string;
  bot_name: string;
  webhook_url: string;
  pending_updates: number;
  last_error: string | null;
  hints: string[];
}

function SettingsForm({ initial }: { initial: Settings }) {
  const client = useQueryClient();
  const { toast } = useToastStack();
  const [username, setUsername] = useState(initial.bot_username);
  const [botToken, setBotToken] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [clientId, setClientId] = useState(initial.client_id);
  const [clientSecret, setClientSecret] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | 'setup' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<BotStatus | null>(null);
  const dirty =
    username !== initial.bot_username ||
    clientId !== initial.client_id ||
    Boolean(botToken || webhookSecret || clientSecret);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy('save');
    setError(null);
    try {
      const saved = await api<Settings>('/admin/telegram/settings', {
        method: 'PUT',
        body: {
          botUsername: username.trim(),
          botToken: botToken.trim(),
          webhookSecret: webhookSecret.trim(),
          telegramClientId: clientId.trim(),
          telegramClientSecret: clientSecret.trim(),
        },
      });
      client.setQueryData(['admin', 'telegram', 'settings'], saved);
      setUsername(saved.bot_username);
      setClientId(saved.client_id);
      setBotToken('');
      setWebhookSecret('');
      setClientSecret('');
      setStatus(null);
      toast({ type: 'success', title: '已保存' });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };
  const run = async (action: 'test' | 'setup') => {
    setBusy(action);
    setError(null);
    setStatus(null);
    try {
      setStatus(await api<BotStatus>(`/admin/telegram/${action}`, { method: 'POST' }));
      toast({ type: 'success', title: action === 'test' ? '连接正常' : 'Webhook 和菜单已初始化' });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };
  const secretHint = (set: boolean, empty: string) => (set ? '已设置，留空保留' : empty);

  return (
    <>
      <form className={styles.form} onSubmit={save}>
        <Alert open={Boolean(error)} tone="danger" title={error ?? ''} />
        <div className={styles.grid2}>
          <Input
            label="Bot Token"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            placeholder={secretHint(initial.bot_token_set, 'BotFather 提供的 Token')}
            required={!initial.bot_token_set}
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
          />
          <Input
            label="机器人用户名"
            placeholder="deadstick_bot"
            autoComplete="off"
            spellCheck={false}
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <Input
            label="Webhook 密钥"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            placeholder={secretHint(initial.webhook_secret_set, '留空自动生成')}
            value={webhookSecret}
            onChange={(e) => setWebhookSecret(e.target.value)}
          />
        </div>
        <div className={styles.grid2}>
          <Input label="公网地址" value={initial.public_url} readOnly />
          <Input label="Webhook 地址" value={initial.webhook_url} readOnly />
        </div>
        <section className={styles.section}>
          <h2>
            Telegram 网页登录 <span>选填，Mini App 无需配置</span>
          </h2>
          <div className={styles.grid2}>
            <Input
              label="Client ID"
              value={clientId}
              autoComplete="off"
              placeholder="留空关闭网页 Telegram 登录"
              onChange={(e) => setClientId(e.target.value)}
            />
            <Input
              label="Client Secret"
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              placeholder={secretHint(initial.client_secret_set, 'BotFather 提供的 Client Secret')}
              disabled={!clientId.trim()}
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
            />
            <Input label="登录回调地址" value={initial.callback_url} readOnly />
          </div>
        </section>
        <div className={styles.formActions}>
          <Button
            type="button"
            variant="secondary"
            disabled={Boolean(busy) || dirty || !initial.bot_token_set}
            loading={busy === 'test'}
            onClick={() => void run('test')}
          >
            测试连接
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={
              Boolean(busy) ||
              dirty ||
              !initial.bot_token_set ||
              !initial.public_url.startsWith('https://')
            }
            loading={busy === 'setup'}
            onClick={() => void run('setup')}
          >
            初始化 Webhook 与菜单
          </Button>
          <Button type="submit" loading={busy === 'save'} disabled={Boolean(busy) || !dirty}>
            保存
          </Button>
        </div>
      </form>
      {status && (
        <section className={styles.section} aria-live="polite">
          <h2>
            {status.bot_name} <span>@{status.bot_username}</span>
          </h2>
          <ul className={styles.rows}>
            <li>
              <span>Webhook</span>
              <span className={styles.mono}>{status.webhook_url || '未注册'}</span>
            </li>
            <li>
              <span>待处理更新</span>
              <span>{status.pending_updates}</span>
            </li>
          </ul>
          <Alert open={Boolean(status.last_error)} tone="danger" title={status.last_error ?? ''} />
          {status.hints.length > 0 && (
            <ul>
              {status.hints.map((hint) => (
                <li key={hint}>{hint}</li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}

export default function TelegramSettings() {
  const settings = useQuery({
    queryKey: ['admin', 'telegram', 'settings'],
    queryFn: () => api<Settings>('/admin/telegram/settings'),
  });
  if (settings.isPending) return <Loading lines={5} />;
  if (settings.isError)
    return <ErrorView error={settings.error} onRetry={() => settings.refetch()} />;
  return <SettingsForm key={JSON.stringify(settings.data)} initial={settings.data} />;
}
