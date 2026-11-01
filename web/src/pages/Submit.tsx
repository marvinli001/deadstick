import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { ProviderForm } from '@/components/ProviderForm';
import { Loading } from '@/components/states';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import styles from './Submit.module.css';

export default function Submit() {
  const { user, ready } = useSession();
  const location = useLocation();
  const client = useQueryClient();
  const [sent, setSent] = useState<string | null>(null);
  const [round, setRound] = useState(0);

  if (!ready) return <Loading />;

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <h1>投稿</h1>
      </header>
      {!user ? (
        <div className={styles.gate}>
          <Link
            className={styles.primary}
            to={`/login?next=${encodeURIComponent(location.pathname)}`}
          >
            登录后投稿
          </Link>
        </div>
      ) : sent ? (
        <div className={styles.done} role="status">
          <span className={styles.check} aria-hidden="true">
            <Check size={28} strokeWidth={1.5} />
          </span>
          <p className={styles.doneName}>{sent}</p>
          <p className={styles.doneState}>待审核</p>
          <div className={styles.actions}>
            <Link className={styles.primary} to="/me/submissions">
              我的投稿
            </Link>
            <button
              type="button"
              className={styles.secondary}
              onClick={() => {
                setSent(null);
                setRound((n) => n + 1);
              }}
            >
              再投一个
            </button>
          </div>
        </div>
      ) : (
        <ProviderForm
          key={round}
          submitLabel="提交"
          onSubmit={async (input) => {
            await api('/submissions', { method: 'POST', body: input });
            void client.invalidateQueries({ queryKey: ['submissions', 'mine'] });
            setSent(input.name);
            window.scrollTo({ top: 0 });
          }}
        />
      )}
    </div>
  );
}
