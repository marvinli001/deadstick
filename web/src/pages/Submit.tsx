import { useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { LeadForm, SubmissionForm } from '@/components/SubmissionForm';
import { ErrorView, Loading } from '@/components/states';
import { api } from '@/lib/api';
import { useProvider } from '@/lib/queries';
import { safeSearchTerm } from '@/lib/submissionDraft';
import { useSession } from '@/lib/session';
import type { MySubmission } from '@/lib/types';
import styles from './Submit.module.css';

function Existing({ id, onDone }: { id: string; onDone: (name: string) => void }) {
  const provider = useProvider(id);
  if (provider.isPending) return <Loading />;
  if (provider.isError) return <ErrorView error={provider.error} onRetry={() => provider.refetch()} />;
  return <><h2 className={styles.target}>{provider.data.name}</h2><LeadForm providerId={id} onDone={() => onDone(provider.data.name)} /></>;
}
function Supplement({ id, onDone }: { id: string; onDone: (name: string) => void }) {
  const submission = useQuery({ queryKey: ['submissions', id], queryFn: () => api<MySubmission>(`/submissions/${id}`) });
  if (submission.isPending) return <Loading />;
  if (submission.isError) return <ErrorView error={submission.error} onRetry={() => submission.refetch()} />;
  const s = submission.data;
  if (s.status !== 'needs_info') return <Link to="/me/submissions">查看投稿进度</Link>;
  return s.kind === 'provider' ? <SubmissionForm initial={s} onDone={onDone} /> : <><h2 className={styles.target}>{s.name}</h2><LeadForm providerId={s.provider_id!} initial={s} onDone={() => onDone(s.name)} /></>;
}

export default function Submit() {
  const { user, ready } = useSession();
  const location = useLocation();
  const [params] = useSearchParams();
  const client = useQueryClient();
  const [sent, setSent] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const providerId = params.get('provider');
  const submissionId = params.get('submission');
  const keyword = safeSearchTerm(params.get('q') ?? '');
  const done = (name: string) => {
    void client.invalidateQueries({ queryKey: ['submissions'] });
    setSent(name); window.scrollTo({ top: 0 });
  };
  if (!ready) return <Loading />;
  return <div className={styles.page}>
    <header className={styles.head}><h1>{submissionId ? '补交资料' : providerId ? '补充线索' : '投稿'}</h1></header>
    {!user ? <div className={styles.gate}><Link className={styles.primary} to={`/login?next=${encodeURIComponent(location.pathname + (providerId ? `?provider=${encodeURIComponent(providerId)}` : submissionId ? `?submission=${encodeURIComponent(submissionId)}` : keyword ? `?q=${encodeURIComponent(keyword)}` : ''))}`}>登录后投稿</Link></div>
      : sent ? <div className={styles.done} role="status">
        <span className={styles.check} aria-hidden="true"><Check size={28} strokeWidth={1.5} /></span>
        <p className={styles.doneName}>{sent}</p><p className={styles.doneState}>待审核</p>
        <div className={styles.actions}><Link className={styles.primary} to="/me/submissions">我的投稿</Link>
          {!providerId && !submissionId && <button type="button" className={styles.secondary} onClick={() => { setSent(null); setRound((n) => n + 1); }}>再投一个</button>}
        </div>
      </div>
      : submissionId ? <Supplement key={submissionId} id={submissionId} onDone={done} />
        : providerId ? <Existing key={providerId} id={providerId} onDone={done} />
          : <SubmissionForm key={round} keyword={keyword} onDone={done} />}
  </div>;
}
