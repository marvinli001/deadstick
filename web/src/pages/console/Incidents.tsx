import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Alert } from '@/components/arc/alert/alert';
import { Button } from '@/components/arc/button/button';
import { Dialog, DialogContent } from '@/components/arc/dialog/dialog';
import { Input } from '@/components/arc/input/input';
import { RadioCards } from '@/components/arc/radio-cards/radio-cards';
import { Textarea } from '@/components/arc/textarea/textarea';
import { useToastStack } from '@/components/arc/toast-stack/toast-stack';
import { StatusTag } from '@/components/marks';
import { Empty, ErrorView, Loading } from '@/components/states';
import { api, errorText } from '@/lib/api';
import { dateTime, host } from '@/lib/format';
import type { AdminIncident } from '@/lib/types';
import {
  EvidenceField,
  Filter,
  PageHead,
  parseUrls,
  Toolbar,
  usePaged,
  validEvidence,
} from './shared';
import styles from './console.module.css';

type Status = AdminIncident['status'];
const statuses: { value: Status; label: string }[] = [
  { value: 'open', label: '待核验' },
  { value: 'confirmed_dead', label: '确认跑路' },
  { value: 'resolved', label: '已恢复' },
  { value: 'dismissed', label: '已排除' },
];
type Action = 'dead' | 'recovered' | 'dismissed';
const actions = [
  { value: 'dead', label: '确认跑路', description: '立碑入园' },
  { value: 'recovered', label: '已恢复', description: '回到存活' },
  { value: 'dismissed', label: '排除', description: '误报' },
];

function ResolveForm({ incident, onDone }: { incident: AdminIncident; onDone: () => void }) {
  const client = useQueryClient();
  const { toast } = useToastStack();
  const [action, setAction] = useState<Action>('dead');
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  const [epitaph, setEpitaph] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const evidenceUrls = parseUrls(evidence);
    if (reason.trim().length < 3) return setError('原因至少 3 个字');
    const invalid = validEvidence(evidenceUrls);
    if (invalid) return setError(invalid);
    setBusy(true);
    setError(null);
    try {
      await api(`/admin/incidents/${incident.id}/resolve`, {
        method: 'POST',
        body: {
          action,
          reason: reason.trim(),
          evidenceUrls,
          ...(action === 'dead' && epitaph.trim() ? { epitaph: epitaph.trim() } : {}),
        },
      });
      await Promise.all([
        client.invalidateQueries({ queryKey: ['admin'] }),
        client.invalidateQueries({ queryKey: ['provider'] }),
        client.invalidateQueries({ queryKey: ['graveyard'] }),
        client.invalidateQueries({ queryKey: ['stats'] }),
      ]);
      toast({
        type: 'success',
        title: action === 'dead' ? `${incident.provider_name} 已入土` : '已处理',
      });
      onDone();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <form className={styles.form} onSubmit={submit}>
      <Alert open={Boolean(error)} tone="danger" title={error ?? ''} />
      <RadioCards
        aria-label="结论"
        options={actions}
        value={action}
        onValueChange={(v) => setAction(v as Action)}
        minColumnWidth={110}
      />
      <Textarea
        label="原因"
        rows={3}
        maxLength={2000}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <EvidenceField value={evidence} onChange={setEvidence} />
      {action === 'dead' && (
        <Input
          label="墓志铭"
          maxLength={500}
          value={epitaph}
          onChange={(e) => setEpitaph(e.target.value)}
        />
      )}
      <div className={styles.formActions}>
        <Button type="button" variant="ghost" onClick={onDone}>
          取消
        </Button>
        <Button type="submit" variant={action === 'dead' ? 'danger' : 'primary'} loading={busy}>
          提交结论
        </Button>
      </div>
    </form>
  );
}

export default function Incidents() {
  const [params, setParams] = useSearchParams();
  const target = params.get('id');
  const [status, setStatus] = useState<Status>('open');
  const [selected, setActive] = useState<AdminIncident | null>(null);
  const list = usePaged<AdminIncident>(['admin', 'incidents'], '/admin/incidents', {
    status,
    id: target ?? undefined,
  });
  const active =
    selected ??
    (target && list.items[0]?.id === target && list.items[0].status === 'open'
      ? list.items[0]
      : null);
  const close = () => {
    setActive(null);
    setParams({}, { replace: true });
  };

  return (
    <>
      <PageHead title="异常" />
      <Toolbar>
        <Filter
          value={status}
          options={statuses}
          onChange={(v) => {
            setStatus(v);
            setParams({}, { replace: true });
            list.reset();
          }}
        />
      </Toolbar>
      {list.isPending ? (
        <Loading lines={4} />
      ) : list.isError ? (
        <ErrorView error={list.error} onRetry={() => list.refetch()} />
      ) : !list.items.length ? (
        <Empty title={status === 'open' ? '没有待核验的异常' : '无'} />
      ) : (
        <ul className={styles.cards}>
          {list.items.map((i) => (
            <li key={i.id} className={styles.card}>
              <div className={styles.cardTitle}>
                <Link to={`/airports/${i.provider_id}`} target="_blank" rel="noopener">
                  {i.provider_name}
                </Link>
                <StatusTag value={i.status} />
                <span className={styles.meta}>{dateTime(i.created_at)}</span>
              </div>
              <div className={styles.cardBody}>
                <p className={styles.quote}>{i.summary}</p>
                {i.resolution && <p>{i.resolution}</p>}
                {i.evidence_urls.length > 0 && (
                  <p className={styles.links}>
                    {i.evidence_urls.map((url) => (
                      <a key={url} href={url} target="_blank" rel="noopener noreferrer nofollow">
                        {host(url)}
                      </a>
                    ))}
                  </p>
                )}
              </div>
              {i.status === 'open' && (
                <div className={styles.cardActions}>
                  <Button size="sm" onClick={() => setActive(i)}>
                    核验
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {list.pager}
      <Dialog open={Boolean(active)} onOpenChange={(open) => !open && close()}>
        <DialogContent title={active ? `核验 ${active.provider_name}` : '核验'}>
          {active && <ResolveForm key={active.id} incident={active} onDone={close} />}
        </DialogContent>
      </Dialog>
    </>
  );
}
