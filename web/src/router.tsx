import { lazy, Suspense, type ReactNode } from 'react';
import { createBrowserRouter, Navigate, useLocation } from 'react-router';
import { PublicLayout } from '@/components/PublicLayout';
import { Loading } from '@/components/states';
import { isReviewer, useSession } from '@/lib/session';
import type { Role } from '@/lib/types';
import Home from '@/pages/Home';
import Cemetery from '@/pages/Cemetery';
import Airports from '@/pages/Airports';
import Airport from '@/pages/Airport';
import Submit from '@/pages/Submit';
import { GroupSettings, PersonalNotificationSettings } from '@/pages/NotificationSettings';
import { Login, Register } from '@/pages/Auth';
import NotFound from '@/pages/NotFound';
import { MeLayout, MeProfile, MeFollows, MeSubmissions, MeSecurity } from '@/pages/me';

const Console = lazy(() => import('@/pages/console'));

function RequireUser({ children, role }: { children: ReactNode; role?: Role }) {
  const { user, ready } = useSession();
  const location = useLocation();
  if (!ready) return <Loading />;
  if (!user)
    return (
      <Navigate
        to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`}
        replace
      />
    );
  if (role === 'moderator' && !isReviewer(user)) return <NotFound />;
  return children;
}

export const router = createBrowserRouter([
  {
    element: <PublicLayout />,
    children: [
      { path: '/', element: <Home /> },
      { path: '/cemetery', element: <Cemetery /> },
      { path: '/airports', element: <Airports /> },
      { path: '/airports/:slug', element: <Airport /> },
      { path: '/submit', element: <Submit /> },
      {
        path: '/groups/:chatId',
        element: (
          <RequireUser>
            <GroupSettings />
          </RequireUser>
        ),
      },
      { path: '/login', element: <Login /> },
      { path: '/register', element: <Register /> },
      {
        path: '/me',
        element: (
          <RequireUser>
            <MeLayout />
          </RequireUser>
        ),
        children: [
          { index: true, element: <MeProfile /> },
          { path: 'follows', element: <MeFollows /> },
          { path: 'submissions', element: <MeSubmissions /> },
          { path: 'security', element: <MeSecurity /> },
          { path: 'notifications', element: <PersonalNotificationSettings /> },
        ],
      },
      { path: '*', element: <NotFound /> },
    ],
  },
  {
    path: '/console/*',
    element: (
      <RequireUser role="moderator">
        <Suspense fallback={<Loading />}>
          <Console />
        </Suspense>
      </RequireUser>
    ),
  },
]);
