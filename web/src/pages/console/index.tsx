import type { ReactNode } from 'react';
import { Link, NavLink, Navigate, Route, Routes } from 'react-router';
import {
  ArrowUpRight,
  Bell,
  FileClock,
  Gauge,
  Inbox,
  ListChecks,
  MessageSquare,
  Plane,
  Send,
  Settings2,
  TriangleAlert,
  Users as UsersIcon,
} from 'lucide-react';
import { Wordmark } from '@/components/art';
import { AccountControl } from '@/components/PublicLayout';
import { useSession } from '@/lib/session';
import NotFound from '../NotFound';
import { isAdmin, useQueue, type Queue } from './shared';
import Overview from './Overview';
import Providers from './Providers';
import Incidents from './Incidents';
import Submissions from './Submissions';
import Memorials from './Memorials';
import Jobs from './Jobs';
import Users from './Users';
import Settings from './Settings';
import Notifications from './Notifications';
import Audit from './Audit';
import Telegram from './Telegram';
import styles from './console.module.css';

const icon = (Icon: typeof Gauge) => <Icon size={17} strokeWidth={1.75} aria-hidden="true" />;

function Badge({ queue }: { queue: Queue }) {
  const { data } = useQueue(queue);
  if (!data) return null;
  return <span className={`${styles.badge} mono`}>{data >= 100 ? '99+' : data}</span>;
}

interface Item {
  to: string;
  label: string;
  icon: ReactNode;
  queue?: Queue;
  end?: boolean;
}

const review: Item[] = [
  { to: '/console', label: '总览', icon: icon(Gauge), end: true },
  { to: '/console/incidents', label: '异常', icon: icon(TriangleAlert), queue: 'incidents' },
  { to: '/console/submissions', label: '投稿', icon: icon(Inbox), queue: 'submissions' },
  { to: '/console/memorials', label: '留言', icon: icon(MessageSquare), queue: 'memorials' },
];
const catalog: Item[] = [
  { to: '/console/providers', label: '机场', icon: icon(Plane) },
  { to: '/console/jobs', label: '任务', icon: icon(ListChecks) },
];
const system: Item[] = [
  { to: '/console/users', label: '用户', icon: icon(UsersIcon) },
  { to: '/console/settings', label: '设置', icon: icon(Settings2) },
  { to: '/console/notifications', label: '通知', icon: icon(Bell) },
  { to: '/console/audit', label: '审计', icon: icon(FileClock) },
  { to: '/console/telegram', label: 'Telegram', icon: icon(Send) },
];

function NavGroup({ items }: { items: Item[] }) {
  return (
    <ul>
      {items.map((item) => (
        <li key={item.to}>
          <NavLink
            to={item.to}
            end={item.end}
            className={({ isActive }) => (isActive ? styles.current : undefined)}
          >
            {item.icon}
            <span>{item.label}</span>
            {item.queue && <Badge queue={item.queue} />}
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

function AdminOnly({ children }: { children: ReactNode }) {
  const { user } = useSession();
  return isAdmin(user) ? children : <Navigate to="/console" replace />;
}

export default function Console() {
  const { user } = useSession();
  return (
    <div className={styles.shell}>
      <div className={styles.frame} aria-hidden="true" />
      <aside className={styles.side}>
        <Link to="/console" className={styles.brand} aria-label="后台总览">
          <Wordmark />
        </Link>
        <nav className={styles.nav} aria-label="后台">
          <NavGroup items={review} />
          <NavGroup items={catalog} />
          {isAdmin(user) && <NavGroup items={system} />}
        </nav>
      </aside>
      <div className={styles.body}>
        <header className={styles.top}>
          <Link to="/" className={styles.site}>
            站点
            <ArrowUpRight size={14} strokeWidth={1.75} aria-hidden="true" />
          </Link>
          <AccountControl />
        </header>
        <main className={styles.main}>
          <Routes>
            <Route index element={<Overview />} />
            <Route path="providers" element={<Providers />} />
            <Route path="incidents" element={<Incidents />} />
            <Route path="submissions" element={<Submissions />} />
            <Route path="memorials" element={<Memorials />} />
            <Route path="jobs" element={<Jobs />} />
            <Route
              path="users"
              element={
                <AdminOnly>
                  <Users />
                </AdminOnly>
              }
            />
            <Route
              path="settings"
              element={
                <AdminOnly>
                  <Settings />
                </AdminOnly>
              }
            />
            <Route
              path="notifications"
              element={
                <AdminOnly>
                  <Notifications />
                </AdminOnly>
              }
            />
            <Route
              path="audit"
              element={
                <AdminOnly>
                  <Audit />
                </AdminOnly>
              }
            />
            <Route
              path="telegram"
              element={
                <AdminOnly>
                  <Telegram />
                </AdminOnly>
              }
            />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
