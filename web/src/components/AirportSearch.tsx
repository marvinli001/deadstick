import { useEffect, useId, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { SearchField } from '@/components/arc/search-field/search-field';
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
  const term = useDebounced(q.trim());
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
        if (q.trim()) navigate(`/airports?q=${encodeURIComponent(q.trim())}`);
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
          {items.length === 0 && <li className={styles.none}>没有收录</li>}
        </ul>
      )}
    </form>
  );
}
