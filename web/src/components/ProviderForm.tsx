import { useState, type FormEvent } from 'react';
import { Plus, X } from 'lucide-react';
import { Alert } from '@/components/arc/alert/alert';
import { Button } from '@/components/arc/button/button';
import { Input } from '@/components/arc/input/input';
import { TagInput } from '@/components/arc/tag-input/tag-input';
import { Textarea } from '@/components/arc/textarea/textarea';
import { errorText } from '@/lib/api';
import type { EndpointInput, ProviderInput } from '@/lib/types';
import styles from './ProviderForm.module.css';

type Kind = EndpointInput['kind'];
interface Row {
  key: number;
  kind: Kind;
  url: string;
  label: string;
  hint?: string;
}

export interface ProviderFormInitial {
  name: string;
  slug: string;
  description: string;
  tags: string[];
  aliases?: string[];
  websites: { url: string; label: string }[];
  /** Subscription URLs are stored encrypted, so editing shows only their hosts and asks for them again. */
  subscriptionHosts: string[];
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
let nextKey = 0;
const row = (kind: Kind, url = '', label = '', hint?: string): Row => ({
  key: nextKey++,
  kind,
  url,
  label,
  hint,
});

const toSlug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

const isHttpUrl = (value: string) => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

function initialRows(initial?: ProviderFormInitial) {
  if (!initial) return [row('website'), row('subscription')];
  const sites = initial.websites.map((s) => row('website', s.url, s.label));
  const subs = initial.subscriptionHosts.map((host) => row('subscription', '', '', host));
  return [
    ...(sites.length ? sites : [row('website')]),
    ...(subs.length ? subs : [row('subscription')]),
  ];
}

export function ProviderForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: ProviderFormInitial;
  submitLabel: string;
  onSubmit: (input: ProviderInput) => Promise<void>;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [slug, setSlug] = useState(initial?.slug ?? '');
  const [slugTouched, setSlugTouched] = useState(Boolean(initial));
  const [description, setDescription] = useState(initial?.description ?? '');
  const [tags, setTags] = useState<string[]>(initial?.tags ?? []);
  const [aliases, setAliases] = useState<string[]>(initial?.aliases ?? []);
  const [rows, setRows] = useState<Row[]>(() => initialRows(initial));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const update = (key: number, patch: Partial<Row>) =>
    setRows((current) => current.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const remove = (key: number) => setRows((current) => current.filter((r) => r.key !== key));
  const add = (kind: Kind) => setRows((current) => [...current, row(kind)]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const endpoints = rows
      .filter((r) => r.url.trim())
      .map((r) => ({
        kind: r.kind,
        url: r.url.trim(),
        ...(r.label.trim() ? { label: r.label.trim() } : {}),
      }));
    if (!SLUG.test(slug)) return setError('标识只能用小写字母、数字和连字符');
    if (!endpoints.length) return setError('至少填一个官网或订阅');
    if (endpoints.some((e) => !isHttpUrl(e.url)))
      return setError('地址要以 http:// 或 https:// 开头');
    if (rows.some((r) => r.hint && !r.url.trim())) return setError('订阅需要重新填写');
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        name: name.trim(),
        slug,
        description: description.trim() || undefined,
        tags: tags.length ? tags : undefined,
        aliases,
        endpoints,
      });
    } catch (err) {
      setError(errorText(err) === '已存在' ? '这个标识已被占用' : errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const group = (kind: Kind, title: string) => {
    const list = rows.filter((r) => r.kind === kind);
    return (
      <fieldset className={styles.group}>
        <legend>{title}</legend>
        {list.map((r, i) => (
          <div key={r.key} className={styles.row} data-kind={kind}>
            <Input
              label={`${title} ${i + 1}`}
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder={r.hint ? `${r.hint}（重新填写）` : 'https://'}
              value={r.url}
              onChange={(e) => update(r.key, { url: e.target.value })}
            />
            {kind === 'website' && (
              <Input
                label={`${title} ${i + 1} 备注`}
                placeholder="备注"
                maxLength={80}
                value={r.label}
                onChange={(e) => update(r.key, { label: e.target.value })}
              />
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={styles.remove}
              aria-label={`删除${title} ${i + 1}`}
              onClick={() => remove(r.key)}
            >
              <X size={16} strokeWidth={1.75} />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={styles.add}
          onClick={() => add(kind)}
        >
          <Plus size={16} strokeWidth={1.75} />
          {title}
        </Button>
      </fieldset>
    );
  };

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <Alert open={Boolean(error)} tone="danger" title={error ?? ''} />
      <div className={styles.pair}>
        <Input
          label="名称"
          required
          maxLength={120}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (!slugTouched) setSlug(toSlug(e.target.value));
          }}
        />
        <Input
          label="标识"
          required
          minLength={2}
          maxLength={80}
          spellCheck={false}
          autoCapitalize="off"
          placeholder="cool-cloud"
          className="mono"
          value={slug}
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(e.target.value.toLowerCase());
          }}
        />
      </div>
      <TagInput
        label="别名 / 旧名"
        value={aliases}
        onValueChange={(next) => setAliases(next.slice(0, 20))}
      />
      <Textarea
        label="简介"
        rows={3}
        maxLength={4000}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <TagInput label="标签" value={tags} onValueChange={(next) => setTags(next.slice(0, 10))} />
      {group('website', '官网')}
      {group('subscription', '订阅')}
      <div className={styles.actions}>
        <Button
          type="submit"
          size="lg"
          loading={busy}
          disabled={!name.trim()}
          className={styles.submit}
        >
          {submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" size="lg" variant="ghost" onClick={onCancel}>
            取消
          </Button>
        )}
      </div>
    </form>
  );
}
