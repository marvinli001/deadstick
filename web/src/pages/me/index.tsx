import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, NavLink, Outlet, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Alert } from '@/components/arc/alert/alert';
import { Button } from '@/components/arc/button/button';
import { HoldToConfirm } from '@/components/arc/hold-to-confirm/hold-to-confirm';
import { Input } from '@/components/arc/input/input';
import { Switch } from '@/components/arc/switch/switch';
import { PasswordField } from '@/components/arc/password-field/password-field';
import { PasswordStrength } from '@/components/arc/password-strength/password-strength';
import { useToastStack } from '@/components/arc/toast-stack/toast-stack';
import { api, errorText, telegramErrorText } from '@/lib/api';
import { passwordFieldMessages, passwordRules, passwordStrengthMessages } from '@/lib/copy';
import { roleLabel } from '@/lib/format';
import { isReviewer, useSession } from '@/lib/session';
import { isMiniApp, telegram } from '@/lib/telegram';
import type { Session, User } from '@/lib/types';
import { TelegramButton } from '../Auth';
import styles from './me.module.css';

export { MeFollows, MeSubmissions } from './lists';

const tabs = [
  { to: '/me', label: '资料', end: true },
  { to: '/me/follows', label: '关注' },
  { to: '/me/submissions', label: '投稿' },
  { to: '/me/security', label: '安全' },
];

function useUser() {
  return useSession().user as User;
}

export function MeLayout() {
  const user = useUser();
  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <h1>{user.display_name}</h1>
        {user.role !== 'user' && <span className={styles.role}>{roleLabel[user.role]}</span>}
        {isReviewer(user) && <Link to="/console">管理台</Link>}
      </header>
      <nav className={styles.tabs} aria-label="用户中心">
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) => (isActive ? styles.active : undefined)}
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}

export function MeProfile() {
  const user = useUser();
  const { refresh } = useSession();
  const { toast } = useToastStack();
  const [name, setName] = useState(user.display_name);
  const [busy, setBusy] = useState(false);
  const changed = name.trim() && name.trim() !== user.display_name;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!changed) return;
    setBusy(true);
    try {
      await api('/auth/me', { method: 'PATCH', body: { displayName: name.trim() } });
      await refresh();
      toast({ type: 'success', title: '已保存' });
    } catch (error) {
      toast({ type: 'error', title: errorText(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.panel}>
      <form className={styles.inline} onSubmit={save}>
        <Input
          label="昵称"
          required
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Button type="submit" loading={busy} disabled={!changed}>
          保存
        </Button>
      </form>
      <dl className={styles.facts}>
        <div>
          <dt>邮箱</dt>
          <dd>{user.email ?? '—'}</dd>
        </div>
        <div>
          <dt>Telegram</dt>
          <dd className="mono">{user.telegram_id ?? '—'}</dd>
        </div>
        <div>
          <dt>角色</dt>
          <dd>{roleLabel[user.role]}</dd>
        </div>
      </dl>
      {isMiniApp && <TelegramPreferences />}
    </div>
  );
}

function TelegramPreferences() {
  const user = useUser();
  const { toast } = useToastStack();
  const [busy, setBusy] = useState(false);
  const [allowed, setAllowed] = useState(false);
  const notifications = useQuery({
    queryKey: ['telegram', 'review-notifications'],
    queryFn: () => api<{ enabled: boolean }>('/admin/telegram/notifications'),
    enabled: isReviewer(user),
  });
  return (
    <div className={styles.form}>
      {telegram?.isVersionAtLeast('6.9') && (
        <Button
          variant="secondary"
          disabled={allowed}
          onClick={() =>
            telegram!.requestWriteAccess((granted) => {
              setAllowed(granted);
              if (!granted) toast({ type: 'error', title: '未开启 Bot 私信' });
            })
          }
        >
          {allowed ? 'Bot 私信已开启' : '接收 Bot 私信'}
        </Button>
      )}
      {isReviewer(user) && (
        <Switch
          label="审核待办私信"
          checked={notifications.data?.enabled ?? false}
          disabled={busy || notifications.isPending || notifications.isError}
          onCheckedChange={async (enabled) => {
            setBusy(true);
            try {
              await api('/admin/telegram/notifications', { method: 'PUT', body: { enabled } });
              await notifications.refetch();
            } catch (error) {
              toast({ type: 'error', title: errorText(error) });
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
    </div>
  );
}

function PasswordForm() {
  const { signIn } = useSession();
  const { toast } = useToastStack();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (next.length < 12) return setError('新密码至少 12 位');
    setBusy(true);
    setError(null);
    try {
      const session = await api<Session>('/auth/password', {
        method: 'POST',
        body: { currentPassword: current, newPassword: next },
      });
      signIn({ ...session, user: { ...session.user, has_password: true } });
      setCurrent('');
      setNext('');
      toast({ type: 'success', title: '密码已更新，其他设备已退出' });
    } catch (err) {
      setError(errorText(err) === '邮箱或密码不对' ? '当前密码不对' : errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className={styles.form} onSubmit={submit}>
      <Alert open={Boolean(error)} tone="danger" title={error ?? ''} />
      <PasswordField
        label="当前密码"
        autoComplete="current-password"
        required
        messages={passwordFieldMessages}
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
      />
      <PasswordStrength
        label="新密码"
        autoComplete="new-password"
        required
        value={next}
        onValueChange={setNext}
        rules={passwordRules}
        shortLength={12}
        messages={passwordStrengthMessages}
      />
      <Button type="submit" loading={busy} disabled={!current || !next} className={styles.start}>
        更新密码
      </Button>
    </form>
  );
}

function TelegramLink() {
  const user = useUser();
  const { refresh } = useSession();
  const { toast } = useToastStack();
  const [params, setParams] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const handled = useRef(false);

  useEffect(() => {
    const code = params.get('telegram');
    if (!code || handled.current) return;
    handled.current = true;
    if (code === 'linked') toast({ type: 'success', title: 'Telegram 已绑定' });
    else setError(telegramErrorText(code));
    setParams({}, { replace: true });
  }, [params, setParams, toast]);

  const unlink = async () => {
    setError(null);
    try {
      await api('/auth/telegram', { method: 'DELETE' });
      await refresh();
      toast({ type: 'success', title: '已解绑' });
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className={styles.form}>
      <Alert open={Boolean(error)} tone="danger" title={error ?? ''} />
      {user.telegram_id ? (
        <div className={styles.linked}>
          <span className="mono">{user.telegram_id}</span>
          <HoldToConfirm
            label="按住解绑"
            confirmedLabel="已解绑"
            tone="danger"
            onConfirm={() => void unlink()}
          />
        </div>
      ) : (
        <div className={styles.start}>
          <TelegramButton mode="link" />
        </div>
      )}
    </div>
  );
}

export function MeSecurity() {
  const user = useUser();
  return (
    <div className={styles.panel}>
      <section className={styles.section}>
        <h2>密码</h2>
        {user.has_password ? <PasswordForm /> : <p className={styles.muted}>仅 Telegram 登录</p>}
      </section>
      <section className={styles.section}>
        <h2>Telegram</h2>
        <TelegramLink />
      </section>
    </div>
  );
}
