import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { Send } from 'lucide-react';
import { Alert } from '@/components/arc/alert/alert';
import { Button } from '@/components/arc/button/button';
import { Input } from '@/components/arc/input/input';
import { PasswordField } from '@/components/arc/password-field/password-field';
import { PasswordStrength } from '@/components/arc/password-strength/password-strength';
import { useToastStack } from '@/components/arc/toast-stack/toast-stack';
import { api, errorText, telegramErrorText } from '@/lib/api';
import { passwordFieldMessages, passwordRules, passwordStrengthMessages } from '@/lib/copy';
import { useSession } from '@/lib/session';
import type { Session } from '@/lib/types';
import styles from './Auth.module.css';

function safeNext(value: string | null) {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/me';
}

export function TelegramButton({ mode = 'login' }: { mode?: 'login' | 'link' }) {
  const [busy, setBusy] = useState(false);
  const { toast } = useToastStack();
  const [params] = useSearchParams();
  return (
    <Button
      type="button"
      variant="secondary"
      className={styles.telegram}
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const { url } =
            mode === 'link'
              ? await api<{ url: string }>('/auth/telegram/link', { method: 'POST' })
              : await api<{ url: string }>('/auth/telegram/start', {
                  query: { next: safeNext(params.get('next')) },
                });
          window.location.assign(url);
        } catch (error) {
          toast({ type: 'error', title: errorText(error) });
          setBusy(false);
        }
      }}
    >
      <Send size={16} strokeWidth={1.75} />
      {mode === 'link' ? '绑定 Telegram' : 'Telegram 登录'}
    </Button>
  );
}

function AuthShell({
  title,
  children,
  foot,
}: {
  title: string;
  children: React.ReactNode;
  foot: React.ReactNode;
}) {
  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <h1>{title}</h1>
        {children}
        <div className={styles.or}>
          <span>或</span>
        </div>
        <TelegramButton />
        <p className={styles.foot}>{foot}</p>
      </div>
    </div>
  );
}

export function Login() {
  const { user, signIn } = useSession();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const next = safeNext(params.get('next'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(telegramErrorText(params.get('telegram')));
  const [busy, setBusy] = useState(false);
  if (user) return <Navigate to={next} replace />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const session = await api<Session>('/auth/login', {
        method: 'POST',
        body: { email, password },
      });
      signIn({ ...session, user: { ...session.user, has_password: true } });
      navigate(next, { replace: true });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title="登录"
      foot={
        <>
          没有账号？
          <Link to={`/register${params.get('next') ? `?next=${encodeURIComponent(next)}` : ''}`}>
            注册
          </Link>
        </>
      }
    >
      <form className={styles.form} onSubmit={submit}>
        <Alert open={Boolean(error)} tone="danger" title={error ?? ''} />
        <Input
          label="邮箱"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <PasswordField
          label="密码"
          autoComplete="current-password"
          required
          minLength={12}
          messages={passwordFieldMessages}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Button type="submit" size="lg" loading={busy}>
          登录
        </Button>
      </form>
    </AuthShell>
  );
}

export function Register() {
  const { user, signIn } = useSession();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const next = safeNext(params.get('next'));
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (user) return <Navigate to={next} replace />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (password.length < 12) return setError('密码至少 12 位');
    setBusy(true);
    setError(null);
    try {
      const session = await api<Session>('/auth/register', {
        method: 'POST',
        body: { email, password, displayName },
      });
      signIn({ ...session, user: { ...session.user, has_password: true } });
      navigate(next, { replace: true });
    } catch (err) {
      setError(errorText(err) === '已存在' ? '这个邮箱已注册' : errorText(err));
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title="注册"
      foot={
        <>
          已有账号？<Link to="/login">登录</Link>
        </>
      }
    >
      <form className={styles.form} onSubmit={submit}>
        <Alert open={Boolean(error)} tone="danger" title={error ?? ''} />
        <Input
          label="昵称"
          required
          maxLength={80}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
        <Input
          label="邮箱"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <PasswordStrength
          label="密码"
          autoComplete="new-password"
          required
          value={password}
          onValueChange={setPassword}
          rules={passwordRules}
          shortLength={12}
          messages={passwordStrengthMessages}
        />
        <Button type="submit" size="lg" loading={busy}>
          注册
        </Button>
      </form>
    </AuthShell>
  );
}
