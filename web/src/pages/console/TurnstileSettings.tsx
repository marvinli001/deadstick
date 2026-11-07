import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert } from '@/components/arc/alert/alert';
import { Button } from '@/components/arc/button/button';
import { Input } from '@/components/arc/input/input';
import { Switch } from '@/components/arc/switch/switch';
import { useToastStack } from '@/components/arc/toast-stack/toast-stack';
import { ErrorView, Loading } from '@/components/states';
import { api, errorText } from '@/lib/api';
import styles from './console.module.css';

interface Settings {
  enabled: boolean;
  siteKey: string;
  secretKeySet: boolean;
}

function SettingsForm({ initial }: { initial: Settings }) {
  const client = useQueryClient();
  const { toast } = useToastStack();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [siteKey, setSiteKey] = useState(initial.siteKey);
  const [secretKey, setSecretKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dirty = enabled !== initial.enabled || siteKey !== initial.siteKey || Boolean(secretKey);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const saved = await api<Settings>('/admin/settings/turnstile', {
        method: 'PUT',
        body: { enabled, siteKey: siteKey.trim(), secretKey: secretKey.trim() },
      });
      setSecretKey('');
      client.setQueryData(['admin', 'settings', 'turnstile'], saved);
      await client.invalidateQueries({ queryKey: ['settings', 'turnstile'] });
      toast({ type: 'success', title: '已保存' });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className={styles.form} onSubmit={save}>
      <Alert open={Boolean(error)} tone="danger" title={error} />
      <Switch label="启用安全验证" checked={enabled} onCheckedChange={setEnabled} />
      <p className={styles.meta}>
        用于留言、投稿和补充线索。Cloudflare 中需允许本站域名，选择 Managed 模式。
      </p>
      <div className={styles.grid2}>
        <Input
          label="Site Key"
          autoComplete="off"
          spellCheck={false}
          required={enabled}
          maxLength={256}
          value={siteKey}
          onChange={(event) => setSiteKey(event.target.value)}
        />
        <Input
          label="Secret Key"
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          required={enabled && !initial.secretKeySet}
          maxLength={256}
          placeholder={initial.secretKeySet ? '已设置，留空保留' : 'Cloudflare 提供的 Secret Key'}
          value={secretKey}
          onChange={(event) => setSecretKey(event.target.value)}
        />
      </div>
      <div className={styles.formActions}>
        <Button
          type="button"
          variant="ghost"
          disabled={!dirty || busy}
          onClick={() => {
            setEnabled(initial.enabled);
            setSiteKey(initial.siteKey);
            setSecretKey('');
            setError('');
          }}
        >
          还原
        </Button>
        <Button type="submit" loading={busy} disabled={!dirty}>
          保存
        </Button>
      </div>
    </form>
  );
}

export function TurnstileSettings() {
  const settings = useQuery({
    queryKey: ['admin', 'settings', 'turnstile'],
    queryFn: () => api<Settings>('/admin/settings/turnstile'),
  });
  return (
    <section className={styles.section}>
      <h2>Cloudflare Turnstile</h2>
      {settings.isPending ? (
        <Loading lines={3} />
      ) : settings.isError ? (
        <ErrorView error={settings.error} onRetry={() => settings.refetch()} />
      ) : (
        <SettingsForm key={JSON.stringify(settings.data)} initial={settings.data} />
      )}
    </section>
  );
}
