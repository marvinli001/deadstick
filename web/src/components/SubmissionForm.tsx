import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Alert } from '@/components/arc/alert/alert';
import { Button } from '@/components/arc/button/button';
import { Input } from '@/components/arc/input/input';
import { Select } from '@/components/arc/select/select';
import { Textarea } from '@/components/arc/textarea/textarea';
import { TagInput } from '@/components/arc/tag-input/tag-input';
import { LifecycleMark } from '@/components/marks';
import { api, ApiError, errorText } from '@/lib/api';
import {
  clearSubmissionDraft,
  publicWebsite,
  readSubmissionDraft,
  saveSubmissionDraft,
} from '@/lib/submissionDraft';
import type { LeadInput, LeadKind, MySubmission, Page, Provider } from '@/lib/types';
import styles from './ProviderForm.module.css';

export const leadLabels: Record<LeadKind, string> = {
  website: '补官网',
  abnormal: '报异常',
  evidence: '补证据',
  review: '申请复核',
};

export function SubmissionForm({
  initial,
  keyword = '',
  onDone,
}: {
  initial?: MySubmission;
  keyword?: string;
  onDone: (name: string) => void;
}) {
  const key = `deadstick-submission:${initial?.id ?? 'new'}`;
  const [draft] = useState(() => (initial ? undefined : readSubmissionDraft(key)));
  const [name, setName] = useState(
    initial?.name ?? draft?.name ?? (keyword.includes('.') ? '' : keyword),
  );
  const [website, setWebsite] = useState(
    initial?.websites[0]?.url ??
      draft?.website ??
      (keyword.includes('.') ? publicWebsite(`https://${keyword}`) : ''),
  );
  const [description, setDescription] = useState(
    initial?.provider.description ?? draft?.description ?? '',
  );
  const [tags, setTags] = useState<string[]>(initial?.provider.tags ?? draft?.tags ?? []);
  const [subscription, setSubscription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [duplicates, setDuplicates] = useState<Provider[]>([]);
  useEffect(() => {
    saveSubmissionDraft(key, { name, website, description, tags });
  }, [key, name, website, description, tags]);
  const check = async () => {
    const result = await api<Page<Provider>>('/submissions/check', {
      method: 'POST',
      body: { name: name.trim(), website: publicWebsite(website) },
    });
    setDuplicates(result.items);
    return result.items;
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!publicWebsite(website)) return setError('官网要以 http:// 或 https:// 开头');
    if (subscription && !publicWebsite(subscription))
      return setError('订阅要以 http:// 或 https:// 开头');
    setBusy(true);
    setError('');
    try {
      if ((await check()).length) return;
      await api(initial ? `/submissions/${initial.id}` : '/submissions', {
        method: initial ? 'PUT' : 'POST',
        body: {
          name: name.trim(),
          description: description.trim(),
          tags,
          endpoints: [
            { kind: 'website', url: publicWebsite(website) },
            ...(subscription ? [{ kind: 'subscription', url: subscription.trim() }] : []),
          ],
        },
      });
      clearSubmissionDraft(key);
      setSubscription('');
      onDone(name.trim());
    } catch (err) {
      setError(errorText(err));
      if (err instanceof ApiError && err.code === 'DUPLICATE_PROVIDER') await check();
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className={styles.form} onSubmit={submit}>
      <Alert open={Boolean(error)} tone="danger" title={error} />
      {initial?.reason && <Alert open tone="warning" title={initial.reason} />}
      <Input
        label="名称"
        required
        maxLength={120}
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setDuplicates([]);
        }}
      />
      <Input
        label="官网"
        type="url"
        required
        maxLength={4096}
        value={website}
        autoCapitalize="off"
        onChange={(e) => {
          setWebsite(e.target.value);
          setDuplicates([]);
        }}
      />
      <details className={styles.optional}>
        <summary>补点资料</summary>
        <div className={styles.form}>
          <Input
            label={initial?.subscription_count ? '替换订阅（留空保留）' : '订阅'}
            type="url"
            maxLength={4096}
            autoComplete="off"
            autoCapitalize="off"
            value={subscription}
            onChange={(e) => setSubscription(e.target.value)}
          />
          <Textarea
            label="简介"
            maxLength={4000}
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <TagInput
            label="标签"
            value={tags}
            onValueChange={(value) => setTags(value.slice(0, 10))}
          />
        </div>
      </details>
      {duplicates.length > 0 && (
        <div className={styles.duplicates} role="status">
          <p>可能已经收录</p>
          <ul>
            {duplicates.map((p) => (
              <li key={p.id}>
                <Link to={`/airports/${p.slug}`}>{p.name}</Link>
                <LifecycleMark value={p.lifecycle} size="sm" />
                <Link to={`/submit?provider=${p.id}`}>给它补充</Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      <Button type="submit" size="lg" loading={busy} disabled={!name.trim() || !website.trim()}>
        {initial ? '补交资料' : '提交'}
      </Button>
    </form>
  );
}

export function LeadForm({
  providerId,
  initial,
  onDone,
}: {
  providerId: string;
  initial?: MySubmission;
  onDone: () => void;
}) {
  const [kind, setKind] = useState<LeadKind>(initial?.provider.report?.kind ?? 'abnormal');
  const [body, setBody] = useState(initial?.provider.report?.body ?? '');
  const [website, setWebsite] = useState(initial?.websites[0]?.url ?? '');
  const [evidence, setEvidence] = useState(initial?.provider.report?.evidenceUrls.join('\n') ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const evidenceUrls = evidence.split(/\s+/).filter(Boolean).map(publicWebsite);
    if (evidenceUrls.some((url) => !url) || evidenceUrls.length > 10)
      return setError('证据最多 10 个，请填公开的 http(s) 链接');
    if (kind === 'website' && !publicWebsite(website)) return setError('填一下官网');
    setBusy(true);
    setError('');
    const input: LeadInput = {
      kind,
      body: body.trim(),
      ...(kind === 'website' ? { website: publicWebsite(website) } : {}),
      evidenceUrls,
    };
    try {
      await api(initial ? `/submissions/${initial.id}` : `/providers/${providerId}/submissions`, {
        method: initial ? 'PUT' : 'POST',
        body: input,
      });
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className={styles.form} onSubmit={submit}>
      <Alert open={Boolean(error)} tone="danger" title={error} />
      {initial?.reason && <Alert open tone="warning" title={initial.reason} />}
      <Select
        label="补充什么"
        value={kind}
        onValueChange={(value) => setKind(value as LeadKind)}
        options={Object.entries(leadLabels).map(([value, label]) => ({ value, label }))}
      />
      {kind === 'website' && (
        <Input
          label="官网"
          type="url"
          required
          maxLength={4096}
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
        />
      )}
      <Textarea
        label="线索"
        required
        minLength={3}
        maxLength={2000}
        rows={5}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <Textarea
        label="公开证据链接"
        maxLength={20480}
        rows={3}
        value={evidence}
        onChange={(e) => setEvidence(e.target.value)}
      />
      <Button type="submit" size="lg" loading={busy} disabled={body.trim().length < 3}>
        {initial ? '补交线索' : '提交线索'}
      </Button>
    </form>
  );
}
