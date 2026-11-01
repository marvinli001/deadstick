import { Link } from 'react-router';
import { AirportSearch } from '@/components/AirportSearch';
import { Chrysanthemum } from '@/components/art';
import { LifecycleMark, HealthMark } from '@/components/marks';
import { Tributes } from '@/components/Tributes';
import { ErrorView, Loading } from '@/components/states';
import { ago, count, day, daysBetween } from '@/lib/format';
import { useGraveyard, useProvider, useProviders, useStats } from '@/lib/queries';
import type { Provider } from '@/lib/types';
import styles from './Home.module.css';

function Obituary({ latest }: { latest: Provider }) {
  const detail = useProvider(latest.slug);
  return (
    <article className={styles.obituary}>
      <Chrysanthemum size={88} className={styles.flower} />
      <h1 className={styles.name}>
        <Link to={`/airports/${latest.slug}`}>{latest.name}</Link>
      </h1>
      <p className={`${styles.dates} mono`}>
        {day(latest.created_at)} — {day(latest.death_at)}
        <span>{daysBetween(latest.created_at, latest.death_at)} 天</span>
      </p>
      {latest.epitaph && <p className={styles.epitaph}>{latest.epitaph}</p>}
      {detail.data ? (
        <Tributes provider={detail.data} slug={latest.slug} />
      ) : (
        <div className={styles.tributeSlot} />
      )}
    </article>
  );
}

function Suspected() {
  const suspected = useProviders({ lifecycle: 'suspected', limit: 8 });
  const items = suspected.data?.items ?? [];
  if (!items.length) return null;
  return (
    <section className={styles.suspected}>
      <h2>疑似跑路</h2>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <Link to={`/airports/${item.slug}`}>
              <span className={styles.rowName}>{item.name}</span>
              <HealthMark value={item.health} />
              <span className={`${styles.rowTime} mono`}>{ago(item.last_checked_at)}</span>
              <LifecycleMark value={item.lifecycle} />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function Home() {
  const graveyard = useGraveyard(16);
  const stats = useStats();
  const [latest, ...rest] = graveyard.data?.items ?? [];

  return (
    <>
      <section className={styles.sheet}>
        {stats.data && (
          <p className={`${styles.stats} mono`}>
            <span>收录 {count(stats.data.total)}</span>
            <span>疑似 {count(stats.data.suspected)}</span>
            <span>入土 {count(stats.data.dead)}</span>
          </p>
        )}
        {graveyard.isPending ? (
          <Loading lines={4} />
        ) : graveyard.isError ? (
          <ErrorView error={graveyard.error} onRetry={() => graveyard.refetch()} />
        ) : latest ? (
          <Obituary latest={latest} />
        ) : (
          <article className={styles.obituary}>
            <Chrysanthemum size={88} className={styles.flower} />
            <h1 className={styles.name}>暂无新坟</h1>
          </article>
        )}
        <div className={styles.search}>
          <AirportSearch />
        </div>
        {rest.length > 0 && (
          <nav className={styles.register} aria-label="最近入土">
            {rest.map((item) => (
              <Link key={item.id} to={`/airports/${item.slug}`}>
                {item.name}
              </Link>
            ))}
            <Link to="/cemetery" className={styles.all}>
              全部
            </Link>
          </nav>
        )}
      </section>
      <Suspected />
    </>
  );
}
