interface TelegramWebApp {
  initData: string;
  version: string;
  ready(): void;
  expand(): void;
  isVersionAtLeast(version: string): boolean;
  setHeaderColor(color: string): void;
  setBackgroundColor(color: string): void;
  setBottomBarColor(color: string): void;
  openTelegramLink(url: string): void;
  requestWriteAccess(callback: (allowed: boolean) => void): void;
  SettingsButton: {
    show(): void;
    hide(): void;
    onClick(callback: () => void): void;
    offClick(callback: () => void): void;
  };
  BackButton: {
    show(): void;
    hide(): void;
    onClick(callback: () => void): void;
    offClick(callback: () => void): void;
  };
}

declare global {
  interface Window {
    Telegram?: { WebApp: TelegramWebApp };
  }
}

const browser = typeof window !== 'undefined';
export const telegram = browser ? window.Telegram?.WebApp : undefined;
const hash = new URLSearchParams(browser ? window.location.hash.slice(1) : '');
export const telegramInitData = telegram?.initData || hash.get('tgWebAppData') || '';
export const isMiniApp = Boolean(telegramInitData);

export function miniAppPath(payload: string | null): string | undefined {
  const paths: Record<string, string> = {
    airports: '/airports',
    graveyard: '/cemetery',
    submit: '/submit',
    following: '/me/follows',
    submissions: '/me/submissions',
    me: '/me',
    admin: '/console',
    incidents: '/console/incidents',
    review_submissions: '/console/submissions',
    memorials: '/console/memorials',
    telegram: '/console/telegram',
    users: '/console/users',
    jobs: '/console/jobs',
    notifications: '/console/notifications',
    audit: '/console/audit',
  };
  if (!payload) return undefined;
  if (Object.hasOwn(paths, payload)) return paths[payload];
  const search = /^search_([A-Za-z0-9_-]{1,480})$/.exec(payload);
  if (search) {
    try {
      const bytes = Uint8Array.from(atob(search[1]!.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
        c.charCodeAt(0),
      );
      const query = new TextDecoder('utf-8', { fatal: true }).decode(bytes).slice(0, 120);
      return `/airports?q=${encodeURIComponent(query)}`;
    } catch {
      return undefined;
    }
  }
  const match =
    /^([pism])_([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})$/.exec(payload);
  if (!match) return undefined;
  const id = match.slice(2).join('-');
  const routes: Record<string, string> = { i: 'incidents', s: 'submissions', m: 'memorials' };
  return match[1] === 'p' ? `/airports/${id}` : `/console/${routes[match[1]!]}?id=${id}`;
}

if (browser && isMiniApp) {
  document.documentElement.dataset.telegram = 'true';
  const url = new URL(window.location.href);
  const freshLaunch =
    hash.has('tgWebAppData') || url.searchParams.has('tgWebAppStartParam') || url.pathname === '/';
  const payload = freshLaunch
    ? (url.searchParams.get('tgWebAppStartParam') ??
      new URLSearchParams(telegramInitData).get('start_param'))
    : null;
  const path = miniAppPath(payload);
  if (path) {
    const target = new URL(path, url.origin);
    url.pathname = target.pathname;
    url.search = target.search;
  } else {
    url.searchParams.delete('tgWebAppStartParam');
    if (url.pathname === '/') url.pathname = '/airports';
  }
  url.hash = '';
  history.replaceState(history.state, '', url.pathname + url.search);
  telegram?.ready();
  telegram?.expand();
  if (telegram?.isVersionAtLeast('6.1')) {
    telegram.setHeaderColor('#ffffff');
    telegram.setBackgroundColor('#ffffff');
  }
  if (telegram?.isVersionAtLeast('7.10')) telegram.setBottomBarColor('#ffffff');
}
