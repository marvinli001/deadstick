import { useEffect, useId, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { SearchField } from '@/components/arc/search-field/search-field';
import { safeSearchTerm } from '@/lib/submissionDraft';
import { useProviders } from '@/lib/queries';
import { LifecycleMark } from './marks';
import styles from './AirportSearch.module.css';

export function useDebounced<T>(value: T, delay = 220) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export function AirportSearch({ autoFocus = false }: { autoFocus?: boolean }) {
  const [q, setQ] = useState('');
  const term = useDebounced(safeSearchTerm(q));
  const navigate = useNavigate();
  const listId = useId();
  const results = useProviders({ q: term, limit: 6 }, term.length > 0);
  const items = term ? (results.data?.items ?? []) : [];

  return (
    <form
      className={styles.root}
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        if (q.trim()) navigate(`/airports?q=${encodeURIComponent(safeSearchTerm(q))}`);
      }}
    >
      <SearchField
        label="搜机场"
        placeholder="搜机场"
        value={q}
        onValueChange={setQ}
        autoFocus={autoFocus}
        autoComplete="off"
        aria-controls={items.length ? listId : undefined}
      />
      {term && results.data && (
        <ul id={listId} className={styles.results}>
          {items.map((item) => (
            <li key={item.id}>
              <Link to={`/airports/${item.slug}`}>
                <span className={styles.name}>{item.name}</span>
                <span className={`${styles.slug} mono`}>{item.slug}</span>
                <LifecycleMark value={item.lifecycle} size="sm" />
              </Link>
            </li>
          ))}
          {items.length === 0 && (
            <li className={styles.none}>
              <Link to={`/submit?q=${encodeURIComponent(term)}`}>没有收录，去投稿</Link>
            </li>
          )}
        </ul>
      )}
    </form>
  );
}
