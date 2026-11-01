import { useSearchParams, Link } from 'react-router';
import { Pagination } from '@/components/arc/pagination/pagination';
import { Chrysanthemum } from '@/components/art';
import { Empty, ErrorView, Loading } from '@/components/states';
import { count, day, daysBetween, plot } from '@/lib/format';
import { useGraveyard } from '@/lib/queries';
import styles from './Cemetery.module.css';

const LIMIT = 24;

export default function Cemetery() {
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get('page')) || 1);
  const graveyard = useGraveyard(LIMIT, (page - 1) * LIMIT);
  const total = graveyard.data?.total ?? 0;
  const items = graveyard.data?.items ?? [];

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <h1>墓园</h1>
        {graveyard.data && <span className={`${styles.total} mono`}>{count(total)}</span>}
      </header>
      {graveyard.isPending ? (
        <Loading lines={6} />
      ) : graveyard.isError ? (
        <ErrorView error={graveyard.error} onRetry={() => graveyard.refetch()} />
      ) : items.length === 0 ? (
        <Empty title="暂无新坟" />
      ) : (
        <ol className={styles.register}>
          {items.map((item, index) => (
            <li key={item.id}>
              <Link to={`/airports/${item.slug}`} className={styles.row}>
                <span className={`${styles.plot} mono`}>
                  {plot(total - (page - 1) * LIMIT - index)}
                </span>
                <span className={styles.name}>{item.name}</span>
                <span className={`${styles.dates} mono`}>
                  {day(item.created_at)} — {day(item.death_at)}
                  <em>{daysBetween(item.created_at, item.death_at)} 天</em>
                </span>
                {item.epitaph && <span className={styles.epitaph}>{item.epitaph}</span>}
                <span className={`${styles.tributes} mono`}>
                  <Chrysanthemum size={16} simple />
                  {count(item.tribute_count ?? 0)}
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
      {total > LIMIT && (
        <div className={styles.pager}>
          <Pagination
            page={page}
            pageCount={Math.ceil(total / LIMIT)}
            onPageChange={(next) => {
              setParams(next > 1 ? { page: String(next) } : {});
              window.scrollTo({ top: 0 });
            }}
          />
        </div>
      )}
    </div>
  );
}
