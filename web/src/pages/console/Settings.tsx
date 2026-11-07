import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/arc/button/button';
import { NumberField } from '@/components/arc/number-field/number-field';
import { useToastStack } from '@/components/arc/toast-stack/toast-stack';
import { ErrorView, Loading } from '@/components/states';
import { api, errorText } from '@/lib/api';
import type { MonitorSettings } from '@/lib/types';
import { PageHead } from './shared';
import { TurnstileSettings } from './TurnstileSettings';
import styles from './console.module.css';

const fields: {
  key: keyof MonitorSettings;
  label: string;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
}[] = [
  { key: 'intervalHours', label: '检测间隔', min: 1, max: 168, suffix: ' 小时' },
  { key: 'failureThreshold', label: '连败阈值', min: 1, max: 10, suffix: ' 次' },
  { key: 'batchSize', label: '每批机场', min: 1, max: 100 },
  { key: 'concurrency', label: '并发', min: 1, max: 16 },
  { key: 'checkTimeoutMs', label: '超时', min: 1000, max: 30000, step: 500, suffix: ' ms' },
  { key: 'nodeSampleSize', label: '节点抽样', min: 0, max: 10, suffix: ' 个' },
  { key: 'retentionDays', label: '记录保留', min: 7, max: 365, suffix: ' 天' },
];

function SettingsForm({ initial }: { initial: MonitorSettings }) {
  const client = useQueryClient();
  const { toast } = useToastStack();
  const [values, setValues] = useState(initial);
  const [busy, setBusy] = useState(false);
  const dirty = fields.some((f) => values[f.key] !== initial[f.key]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api('/admin/settings/monitor', { method: 'PUT', body: values });
      await client.invalidateQueries({ queryKey: ['admin', 'settings'] });
      toast({ type: 'success', title: '已保存' });
    } catch (error) {
      toast({ type: 'error', title: errorText(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className={styles.form} onSubmit={save}>
      <div className={styles.grid2}>
        {fields.map((f) => (
          <NumberField
            key={f.key}
            label={f.label}
            min={f.min}
            max={f.max}
            step={f.step ?? 1}
            suffix={f.suffix}
            value={values[f.key]}
            onValueChange={(v) => setValues((current) => ({ ...current, [f.key]: v }))}
          />
        ))}
      </div>
      <div className={styles.formActions}>
        <Button type="button" variant="ghost" disabled={!dirty} onClick={() => setValues(initial)}>
          还原
        </Button>
        <Button type="submit" loading={busy} disabled={!dirty}>
          保存
        </Button>
      </div>
    </form>
  );
}

export default function Settings() {
  const settings = useQuery({
    queryKey: ['admin', 'settings', 'monitor'],
    queryFn: () => api<MonitorSettings>('/admin/settings/monitor'),
  });
  return (
    <>
      <PageHead title="设置" />
      <section className={styles.section}>
        <h2>监测</h2>
        {settings.isPending ? (
          <Loading lines={4} />
        ) : settings.isError ? (
          <ErrorView error={settings.error} onRetry={() => settings.refetch()} />
        ) : (
          <SettingsForm key={JSON.stringify(settings.data)} initial={settings.data} />
        )}
      </section>
      <TurnstileSettings />
    </>
  );
}
