import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError, errorText, setCsrfToken } from './api';
import type { Session, User } from './types';
import { isMiniApp, telegramInitData } from './telegram';
import { Empty, Loading } from '@/components/states';

interface SessionState {
  user: User | null;
  ready: boolean;
  signIn: (session: Session) => void;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

// One request per document, including React StrictMode's repeated effect setup.
let launchSession: Promise<Session> | undefined;
function miniAppSession() {
  return (launchSession ??= (async () => {
    try {
      const current = await api<Session>('/auth/me');
      setCsrfToken(current.csrfToken);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
    }
    return api<Session>('/auth/telegram/miniapp', {
      method: 'POST',
      body: { initData: telegramInitData },
    });
  })());
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState<unknown>(null);
  const queryClient = useQueryClient();

  const signIn = useCallback((session: Session) => {
    setCsrfToken(session.csrfToken);
    setUser(session.user);
  }, []);

  const refresh = useCallback(async () => {
    try {
      signIn(await api<Session>('/auth/me'));
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
      setCsrfToken(null);
      setUser(null);
    }
  }, [signIn]);

  useEffect(() => {
    const boot = isMiniApp ? miniAppSession().then(signIn) : refresh();
    boot.catch(setBootError).finally(() => setReady(true));
  }, [refresh, signIn]);

  const signOut = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
    }
    setCsrfToken(null);
    setUser(null);
    queryClient.clear();
  }, [queryClient]);

  const value = useMemo(
    () => ({ user, ready, signIn, signOut, refresh }),
    [user, ready, signIn, signOut, refresh],
  );
  if (isMiniApp && !ready) return <Loading />;
  if (isMiniApp && bootError)
    return <Empty title={errorText(bootError)} action={<p>请关闭后重新打开 Mini App</p>} />;
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession outside SessionProvider');
  return value;
}

export const isReviewer = (user: User | null) =>
  user?.role === 'admin' || user?.role === 'moderator';
