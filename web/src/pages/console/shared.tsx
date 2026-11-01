import { useState, type ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/arc/button/button';
import SegmentedControl from '@/components/arc/segmented-control/segmented-control';
import {
  SortableDataTable,
  type DataColumn,
} from '@/components/arc/sortable-data-table/sortable-data-table';
import { Textarea } from '@/components/arc/textarea/textarea';
import { api } from '@/lib/api';
import { count } from '@/lib/format';
import type { Page, User } from '@/lib/types';
import styles from './console.module.css';

export const isAdmin = (user: User | null) => user?.role === 'admin';

const queuePaths = {
  incidents: ['/admin/incidents', 'open'],
  submissions: ['/admin/submissions', 'pending'],
  memorials: ['/admin/memorials', 'pending'],
} as const;
export type Queue = keyof typeof queuePaths;

/** Pending work counts, capped at the API's page size of 100. */
export function useQueue(queue: Queue) {
  const [path, status] = queuePaths[queue];
  return useQuery({
    queryKey: ['admin', 'queue', queue],
    queryFn: () =>
      api<Page<unknown>>(path, { query: { status, limit: 100 } }).then((r) => r.items.length),
    refetchInterval: 60_000,
  });
}

export function PageHead({
  title,
  total,
  children,
}: {
  title: string;
  total?: number;
  children?: ReactNode;
}) {
  return (
    <header className={styles.head}>
      <h1>
        {title}
        {total !== undefined && <span className="mono">{count(total)}</span>}
      </h1>
      {children && <div className={styles.headActions}>{children}</div>}
    </header>
  );
}

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className={styles.toolbar}>{children}</div>;
}

export function Filter<V extends string>({
  value,
  options,
  onChange,
  label = '筛选',
}: {
  value: V;
  options: { value: V; label: string }[];
  onChange: (value: V) => void;
  label?: string;
}) {
  return (
    <SegmentedControl
      label={label}
      options={options}
      value={value}
      onValueChange={(next) => onChange(next as V)}
    />
  );
}

export interface Column<T> {
  key: string;
  label: string;
  sortable?: boolean;
  numeric?: boolean;
  width?: number | string;
  render?: (value: unknown, row: T) => ReactNode;
}

/** Arc's table wants index-signature rows; our API types are interfaces, so the cast lives here once. */
export function Table<T extends { id: string }>({
  rows,
  columns,
  caption,
  empty = '暂无',
}: {
  rows: T[];
  columns: Column<T>[];
  caption: string;
  empty?: string;
}) {
  return (
    <SortableDataTable
      rows={rows as unknown as Record<string, unknown>[]}
      columns={columns as unknown as DataColumn<Record<string, unknown>>[]}
      rowKey="id"
      caption={caption}
      emptyMessage={empty}
      itemName={{ one: '行', other: '行' }}
    />
  );
}

export const PAGE = 30;

/** Offset paging for admin lists that do not return a total. */
export function usePaged<T>(
  key: unknown[],
  path: string,
  query: Record<string, string | undefined> = {},
) {
  const [offset, setOffset] = useState(0);
  const result = useQuery({
    queryKey: [...key, query, offset],
    queryFn: () => api<Page<T>>(path, { query: { ...query, limit: PAGE, offset } }),
    placeholderData: keepPreviousData,
  });
  const items = result.data?.items ?? [];
  return {
    ...result,
    items,
    offset,
    reset: () => setOffset(0),
    pager: (
      <Pager
        offset={offset}
        hasMore={items.length === PAGE}
        onChange={(next) => {
          setOffset(next);
          window.scrollTo({ top: 0 });
        }}
      />
    ),
  };
}

function Pager({
  offset,
  hasMore,
  onChange,
}: {
  offset: number;
  hasMore: boolean;
  onChange: (offset: number) => void;
}) {
  if (!offset && !hasMore) return null;
  return (
    <nav className={styles.pager} aria-label="分页">
      <Button
        variant="secondary"
        size="sm"
        disabled={!offset}
        onClick={() => onChange(Math.max(0, offset - PAGE))}
      >
        <ChevronLeft size={16} strokeWidth={1.75} />
        上一页
      </Button>
      <span className="mono">{offset / PAGE + 1}</span>
      <Button
        variant="secondary"
        size="sm"
        disabled={!hasMore}
        onClick={() => onChange(offset + PAGE)}
      >
        下一页
        <ChevronRight size={16} strokeWidth={1.75} />
      </Button>
    </nav>
  );
}

export const parseUrls = (text: string) =>
  text
    .split(/\s+/)
    .map((line) => line.trim())
    .filter(Boolean);

export function EvidenceField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Textarea
      label="证据链接"
      rows={3}
      placeholder="https://t.me/…"
      spellCheck={false}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function validEvidence(urls: string[]) {
  if (!urls.length) return '至少一条证据链接';
  if (urls.length > 10) return '最多 10 条证据链接';
  if (urls.some((url) => !/^https?:\/\/\S+$/.test(url)))
    return '证据链接要以 http:// 或 https:// 开头';
  return null;
}

export const shortId = (id: string | null) => (id ? id.slice(0, 8) : '—');
