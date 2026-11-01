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
import { api, ApiError, setCsrfToken } from './api';
import type { Session, User } from './types';

interface SessionState {
  user: User | null;
  ready: boolean;
  signIn: (session: Session) => void;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

// Telegram puts Mini App launch data in the URL hash as tgWebAppData.
function miniAppInitData() {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  return hash.get('tgWebAppData');
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
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
    const initData = miniAppInitData();
    const boot = initData
      ? api<Session>('/auth/telegram/miniapp', { method: 'POST', body: { initData } })
          .then(signIn)
          .catch(refresh)
          .finally(() =>
            history.replaceState(null, '', window.location.pathname + window.location.search),
          )
      : refresh();
    boot.catch(() => undefined).finally(() => setReady(true));
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
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession outside SessionProvider');
  return value;
}

export const isReviewer = (user: User | null) =>
  user?.role === 'admin' || user?.role === 'moderator';
