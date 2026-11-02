import { useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { ArrowUpRight, Bell, BellOff } from 'lucide-react';
import { Button } from '@/components/arc/button/button';
import { Textarea } from '@/components/arc/textarea/textarea';
import { useToastStack } from '@/components/arc/toast-stack/toast-stack';
import { Chrysanthemum } from '@/components/art';
import { CheckStrip } from '@/components/CheckStrip';
import { HealthMark, LifecycleMark, StatusTag } from '@/components/marks';
import { Tributes } from '@/components/Tributes';
import { Empty, ErrorView, Loading } from '@/components/states';
import { api, ApiError, errorText } from '@/lib/api';
import { ago, count, dateTime, day, daysBetween } from '@/lib/format';
import { useChecks, useFollow, useMemorials, useProvider } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { isMiniApp, telegram } from '@/lib/telegram';
import type { ProviderDetail } from '@/lib/types';
import NotFound from './NotFound';
import styles from './Airport.module.css';

const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

function FollowButton({ provider, slug }: { provider: ProviderDetail; slug: string }) {
  const { user } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToastStack();
  const follow = useFollow(provider, slug);
  const following = Boolean(provider.following);
  return (
    <Button
      variant={following ? 'secondary' : 'primary'}
      loading={follow.isPending}
      onClick={() => {
        if (!user) return navigate(`/login?next=${encodeURIComponent(location.pathname)}`);
        const update = (writeAllowed = true) =>
          follow.mutate(!following, {
            onSuccess: () => {
              if (!writeAllowed) toast({ type: 'info', title: '已关注，Bot 私信未开启' });
            },
            onError: (error) => toast({ type: 'error', title: errorText(error) }),
          });
        if (!following && isMiniApp && telegram?.isVersionAtLeast('6.9')) {
          telegram.requestWriteAccess(update);
          return;
        }
        update();
      }}
    >
      {following ? <BellOff size={16} strokeWidth={1.75} /> : <Bell size={16} strokeWidth={1.75} />}
      {following ? '已关注' : '关注'}
    </Button>
  );
}

function Websites({ provider }: { provider: ProviderDetail }) {
  if (!provider.websites.length) return null;
  return (
    <section className={styles.section}>
      <h2>官网</h2>
      <ul className={styles.links}>
        {provider.websites.map((site) => (
          <li key={site.id}>
            <a href={site.public_url} target="_blank" rel="noopener noreferrer nofollow">
              <span>{site.label || host(site.public_url)}</span>
              <span className="mono">{host(site.public_url)}</span>
              <ArrowUpRight size={16} strokeWidth={1.75} aria-hidden="true" />
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Checks({ provider }: { provider: ProviderDetail }) {
  const checks = useChecks(provider.id);
  const runs = checks.data?.items ?? [];
  return (
    <section className={styles.section}>
      <h2>检测</h2>
      {checks.isPending ? (
        <Loading lines={1} />
      ) : checks.isError ? (
        <ErrorView error={checks.error} onRetry={() => checks.refetch()} />
      ) : runs.length ? (
        <CheckStrip runs={runs} />
      ) : (
        <p className={styles.muted}>还没有检测</p>
      )}
    </section>
  );
}

function Incidents({ provider }: { provider: ProviderDetail }) {
  if (!provider.incidents.length) return null;
  return (
    <section className={styles.section}>
      <h2>异常</h2>
      <ol className={styles.incidents}>
        {provider.incidents.map((incident) => (
          <li key={incident.id}>
            <span className={`${styles.when} mono`}>{dateTime(incident.created_at)}</span>
            <div>
              <p>{incident.summary}</p>
              {incident.resolution && <p className={styles.resolution}>{incident.resolution}</p>}
              {incident.evidence_urls.length > 0 && (
                <p className={styles.evidence}>
                  {incident.evidence_urls.map((url) => (
                    <a key={url} href={url} target="_blank" rel="noopener noreferrer nofollow">
                      {host(url)}
                    </a>
                  ))}
                </p>
              )}
            </div>
            <StatusTag value={incident.status} />
          </li>
        ))}
      </ol>
    </section>
  );
}

function Memorials({ provider }: { provider: ProviderDetail }) {
  const { user } = useSession();
  const location = useLocation();
  const { toast } = useToastStack();
  const memorials = useMemorials(provider.id);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const items = memorials.data?.items ?? [];

  const submit = async () => {
    if (!body.trim()) return;
    setSending(true);
    try {
      await api(`/providers/${provider.id}/memorials`, {
        method: 'POST',
        body: { body: body.trim() },
      });
      setBody('');
      toast({ type: 'success', title: '已提交，审核后公开' });
    } catch (error) {
      toast({ type: 'error', title: errorText(error) });
    } finally {
      setSending(false);
    }
  };

  return (
    <section className={styles.section}>
      <h2>
        留言 <span className="mono">{count(provider.memorial_count ?? items.length)}</span>
      </h2>
      {user ? (
        <form
          className={styles.compose}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Textarea
            label="留言"
            value={body}
            maxLength={1000}
            rows={3}
            onChange={(e) => setBody(e.target.value)}
          />
          <Button type="submit" loading={sending} disabled={!body.trim()}>
            寄出
          </Button>
        </form>
      ) : (
        <p className={styles.muted}>
          <Link to={`/login?next=${encodeURIComponent(location.pathname)}`}>登录</Link>后留言
        </p>
      )}
      {memorials.isPending ? (
        <Loading lines={2} />
      ) : memorials.isError ? (
        <ErrorView error={memorials.error} onRetry={() => memorials.refetch()} />
      ) : (
        <ul className={styles.memorials}>
          {items.map((m) => (
            <li key={m.id}>
              <p>{m.body}</p>
              <span className="mono">
                {m.display_name} · {day(m.created_at)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ObituaryView({ provider, slug }: { provider: ProviderDetail; slug: string }) {
  const cause = provider.incidents.find((i) => i.status === 'confirmed_dead');
  return (
    <div className={styles.obituary}>
      <header className={styles.notice}>
        <Chrysanthemum size={92} />
        <h1>{provider.name}</h1>
        <p className={`${styles.dates} mono`}>
          {day(provider.created_at)} — {day(provider.death_at)}
          <span>{daysBetween(provider.created_at, provider.death_at)} 天</span>
        </p>
        {provider.epitaph && <p className={styles.epitaph}>{provider.epitaph}</p>}
        <Tributes provider={provider} slug={slug} />
        <FollowButton provider={provider} slug={slug} />
        <Link to={`/submit?provider=${provider.id}`}>补充线索</Link>
      </header>
      {cause && (
        <section className={styles.section}>
          <h2>死因</h2>
          <p className={styles.cause}>{cause.resolution ?? cause.summary}</p>
          {cause.evidence_urls.length > 0 && (
            <p className={styles.evidence}>
              {cause.evidence_urls.map((url) => (
                <a key={url} href={url} target="_blank" rel="noopener noreferrer nofollow">
                  {host(url)}
                </a>
              ))}
            </p>
          )}
        </section>
      )}
      <Memorials provider={provider} />
      <Websites provider={provider} />
      <Checks provider={provider} />
    </div>
  );
}

function StatusView({ provider, slug }: { provider: ProviderDetail; slug: string }) {
  const open = provider.incidents.find((i) => i.status === 'open');
  return (
    <div className={styles.status}>
      {provider.lifecycle === 'suspected' && (
        <div className={styles.band} role="status">
          <strong>疑似跑路</strong>
          {open && <span>{open.summary}</span>}
          {open && <span className="mono">{ago(open.created_at)}</span>}
        </div>
      )}
      <header className={styles.head}>
        <div className={styles.title}>
          <h1>{provider.name}</h1>
          <span className={`${styles.slug} mono`}>{provider.slug}</span>
        </div>
        <FollowButton provider={provider} slug={slug} />
        <Link to={`/submit?provider=${provider.id}`}>补充线索</Link>
      </header>
      <dl className={styles.facts}>
        <div>
          <dt>状态</dt>
          <dd>
            <LifecycleMark value={provider.lifecycle} />
          </dd>
        </div>
        <div>
          <dt>健康</dt>
          <dd>
            <HealthMark value={provider.health} />
          </dd>
        </div>
        <div>
          <dt>最近检测</dt>
          <dd className="mono">{ago(provider.last_checked_at)}</dd>
        </div>
        <div>
          <dt>收录</dt>
          <dd className="mono">{day(provider.created_at)}</dd>
        </div>
        <div>
          <dt>关注</dt>
          <dd className="mono">{count(provider.follower_count ?? 0)}</dd>
        </div>
      </dl>
      {(provider.tags.length > 0 || provider.description) && (
        <div className={styles.about}>
          {provider.tags.length > 0 && (
            <p className={styles.tags}>
              {provider.tags.map((tag) => (
                <Link key={tag} to={`/airports?tag=${encodeURIComponent(tag)}`}>
                  #{tag}
                </Link>
              ))}
            </p>
          )}
          {provider.description && <p className={styles.description}>{provider.description}</p>}
        </div>
      )}
      <Checks provider={provider} />
      <Websites provider={provider} />
      <Incidents provider={provider} />
    </div>
  );
}

export default function Airport() {
  const { slug = '' } = useParams();
  const provider = useProvider(slug);
  if (provider.isPending) return <Loading lines={6} />;
  if (provider.isError) {
    if (provider.error instanceof ApiError && [400, 404].includes(provider.error.status))
      return <NotFound />;
    return <ErrorView error={provider.error} onRetry={() => provider.refetch()} />;
  }
  if (!provider.data) return <Empty title="找不到" />;
  return provider.data.lifecycle === 'dead' ? (
    <ObituaryView provider={provider.data} slug={slug} />
  ) : (
    <StatusView provider={provider.data} slug={slug} />
  );
}
