import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { X } from 'lucide-react';
import { SearchField } from '@/components/arc/search-field/search-field';
import SegmentedControl from '@/components/arc/segmented-control/segmented-control';
import { Pagination } from '@/components/arc/pagination/pagination';
import { useDebounced } from '@/components/AirportSearch';
import { HealthMark, LifecycleMark } from '@/components/marks';
import { Empty, ErrorView, Loading } from '@/components/states';
import { ago, count } from '@/lib/format';
import { safeSearchTerm } from '@/lib/submissionDraft';
import { useProviders } from '@/lib/queries';
import type { Lifecycle } from '@/lib/types';
import styles from './Airports.module.css';

const LIMIT = 30;
const lifecycles = [
  { value: 'all', label: '全部' },
  { value: 'active', label: '存活' },
  { value: 'suspected', label: '疑似' },
  { value: 'dead', label: '已跑路' },
];

export default function Airports() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(safeSearchTerm(params.get('q') ?? ''));
  const term = useDebounced(safeSearchTerm(q));
  const lifecycle = (params.get('lifecycle') as Lifecycle | null) ?? undefined;
  const tag = params.get('tag') ?? undefined;
  const page = Math.max(1, Number(params.get('page')) || 1);

  const update = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(patch))
      value ? next.set(key, value) : next.delete(key);
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  };

  useEffect(() => {
    if ((params.get('q') ?? '') !== term) update({ q: term || undefined });
  }, [term]);

  const providers = useProviders({
    q: term,
    lifecycle,
    tag,
    limit: LIMIT,
    offset: (page - 1) * LIMIT,
  });
  const items = providers.data?.items ?? [];
  const total = providers.data?.total ?? 0;

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <h1>机场</h1>
        {providers.data && <span className={`${styles.total} mono`}>{count(total)}</span>}
      </header>
      <div className={styles.filters}>
        <div className={styles.search}>
          <SearchField
            label="搜机场"
            placeholder="名称、旧名或官网"
            value={q}
            onValueChange={setQ}
            autoComplete="off"
          />
        </div>
        <SegmentedControl
          label="状态"
          options={lifecycles}
          value={lifecycle ?? 'all'}
          onValueChange={(value) => update({ lifecycle: value === 'all' ? undefined : value })}
        />
        {tag && (
          <button
            type="button"
            className={styles.tagFilter}
            onClick={() => update({ tag: undefined })}
          >
            #{tag}
            <X size={14} strokeWidth={1.75} aria-label="移除标签筛选" />
          </button>
        )}
      </div>
      {providers.isPending ? (
        <Loading lines={6} />
      ) : providers.isError ? (
        <ErrorView error={providers.error} onRetry={() => providers.refetch()} />
      ) : items.length === 0 ? (
        <Empty
          title={term || tag || lifecycle ? '没有符合的机场' : '还没有收录'}
          action={<Link to={`/submit${term ? `?q=${encodeURIComponent(term)}` : ''}`}>去投稿</Link>}
        />
      ) : (
        <ul className={styles.list}>
          {items.map((item) => (
            <li key={item.id} data-lifecycle={item.lifecycle}>
              <Link to={`/airports/${item.slug}`} className={styles.name}>
                {item.name}
              </Link>
              <span className={`${styles.slug} mono`}>{item.slug}</span>
              <span className={styles.tags}>
                {item.tags.map((t) => (
                  <button key={t} type="button" onClick={() => update({ tag: t })}>
                    #{t}
                  </button>
                ))}
              </span>
              <HealthMark value={item.health} />
              <span className={`${styles.checked} mono`}>{ago(item.last_checked_at)}</span>
              <LifecycleMark value={item.lifecycle} />
            </li>
          ))}
        </ul>
      )}
      {total > LIMIT && (
        <div className={styles.pager}>
          <Pagination
            page={page}
            pageCount={Math.ceil(total / LIMIT)}
            onPageChange={(next) => {
              update({ page: next > 1 ? String(next) : undefined });
              window.scrollTo({ top: 0 });
            }}
          />
        </div>
      )}
    </div>
  );
}
