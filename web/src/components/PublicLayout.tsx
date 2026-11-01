import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { LayoutDashboard, Search, UserRound, Plane, Flower2, Send } from 'lucide-react';
import { UserMenu } from '@/components/arc/user-menu/user-menu';
import { useToastStack } from '@/components/arc/toast-stack/toast-stack';
import { errorText } from '@/lib/api';
import { isReviewer, useSession } from '@/lib/session';
import { Wordmark } from './art';
import { TelegramNavigation } from './TelegramNavigation';
import { isMiniApp } from '@/lib/telegram';
import styles from './PublicLayout.module.css';

const nav = [
  { to: '/cemetery', label: '墓园' },
  { to: '/airports', label: '机场' },
  { to: '/submit', label: '投稿' },
];

export function AccountControl() {
  const { user, ready, signOut } = useSession();
  const { toast } = useToastStack();
  const navigate = useNavigate();
  const location = useLocation();
  if (!ready) return <span className={styles.accountSlot} />;
  if (!user)
    return (
      <Link
        className={styles.signIn}
        to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`}
      >
        登录
      </Link>
    );
  if (isMiniApp)
    return (
      <Link to="/me" className={styles.signIn}>
        {user.display_name}
      </Link>
    );
  return (
    <UserMenu
      user={{
        name: user.display_name,
        email: user.email ?? (user.telegram_id ? 'Telegram 账号' : ''),
      }}
      showTheme={false}
      items={[
        {
          label: '用户中心',
          icon: <UserRound size={16} strokeWidth={1.75} />,
          onSelect: () => navigate('/me'),
        },
        ...(isReviewer(user)
          ? [
              {
                label: '后台',
                icon: <LayoutDashboard size={16} strokeWidth={1.75} />,
                onSelect: () => navigate('/console'),
              },
            ]
          : []),
      ]}
      onSignOut={async () => {
        try {
          await signOut();
          navigate('/');
        } catch (error) {
          toast({ type: 'error', title: errorText(error) });
        }
      }}
    />
  );
}

export function PublicLayout() {
  if (isMiniApp)
    return (
      <div className={styles.miniPage}>
        <TelegramNavigation />
        <main className={styles.main}>
          <Outlet />
        </main>
        <nav className={styles.tabs} aria-label="主导航">
          {[
            { to: '/airports', label: '机场', Icon: Plane },
            { to: '/cemetery', label: '墓园', Icon: Flower2 },
            { to: '/submit', label: '投稿', Icon: Send },
            { to: '/me', label: '我的', Icon: UserRound },
          ].map(({ to, label, Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => (isActive ? styles.selected : undefined)}
            >
              <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
      </div>
    );
  return (
    <div className={styles.page}>
      <div className={styles.frame} aria-hidden="true" />
      <header className={styles.header}>
        <Link to="/" className={styles.home} aria-label="Deadstick 首页">
          <Wordmark />
        </Link>
        <nav className={styles.nav} aria-label="主导航">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => (isActive ? styles.active : undefined)}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className={styles.tools}>
          <Link to="/airports" className={styles.searchLink} aria-label="搜机场">
            <Search size={18} strokeWidth={1.75} />
          </Link>
          <AccountControl />
        </div>
      </header>
      <main className={styles.main}>
        <Outlet />
      </main>
      <footer className={styles.footer}>
        <span className="mono">DEADSTICK</span>
        <a href="/docs">API</a>
      </footer>
    </div>
  );
}
