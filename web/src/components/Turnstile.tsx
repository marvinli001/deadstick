import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/arc/button/button';
import { api } from '@/lib/api';
import styles from './Turnstile.module.css';

type Action = 'submission' | 'lead' | 'memorial';
interface PublicSettings {
  enabled: boolean;
  siteKey: string;
}
interface TurnstileApi {
  ready: (callback: () => void) => void;
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      action: Action;
      theme: 'light';
      size: 'flexible' | 'compact';
      'response-field': false;
      callback: (token: string) => void;
      'expired-callback': () => void;
      'error-callback': () => boolean;
      'timeout-callback': () => void;
    },
  ) => string;
  remove: (id: string) => void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let script: Promise<TurnstileApi> | undefined;
function loadTurnstile() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!script) {
    script = new Promise<TurnstileApi>((resolve, reject) => {
      const element = document.createElement('script');
      const failed = () => {
        window.clearTimeout(timeout);
        element.remove();
        reject(new Error('Turnstile unavailable'));
      };
      const timeout = window.setTimeout(failed, 15000);
      element.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      element.async = true;
      element.onerror = failed;
      element.onload = () => {
        if (!window.turnstile) return failed();
        window.turnstile.ready(() => {
          window.clearTimeout(timeout);
          resolve(window.turnstile!);
        });
      };
      document.head.append(element);
    }).catch((error: unknown) => {
      script = undefined;
      throw error;
    });
  }
  return script;
}

function Challenge({
  siteKey,
  action,
  onToken,
  onRetry,
}: {
  siteKey: string;
  action: Action;
  onToken: (token: string) => void;
  onRetry: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState('正在加载安全验证…');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    let widget: string | undefined;
    let instance: TurnstileApi | undefined;
    const fail = () => {
      if (!active) return;
      onToken('');
      setStatus('验证未完成，请重试');
      setFailed(true);
    };
    void loadTurnstile()
      .then((api) => {
        if (!active) return;
        instance = api;
        setStatus('请完成安全验证');
        widget = api.render(container.current!, {
          sitekey: siteKey,
          action,
          theme: 'light',
          size: container.current!.clientWidth < 300 ? 'compact' : 'flexible',
          'response-field': false,
          callback: (token) => {
            if (!active) return;
            onToken(token);
            setStatus('验证通过');
            setFailed(false);
          },
          'expired-callback': () => {
            if (!active) return;
            onToken('');
            setStatus('验证已过期，正在重新验证…');
          },
          'error-callback': () => {
            fail();
            return true;
          },
          'timeout-callback': fail,
        });
      })
      .catch(fail);
    return () => {
      active = false;
      if (widget !== undefined) instance!.remove(widget);
      onToken('');
    };
  }, [siteKey, action, onToken]);

  return (
    <div className={styles.root}>
      <div ref={container} className={styles.widget} />
      <div
        className={styles.status}
        role="status"
        aria-live="polite"
        data-error={failed || undefined}
      >
        <span>{status}</span>
        {failed && (
          <Button type="button" size="sm" variant="ghost" onClick={onRetry}>
            重新验证
          </Button>
        )}
      </div>
    </div>
  );
}

export function useTurnstile(action: Action) {
  const settings = useQuery({
    queryKey: ['settings', 'turnstile'],
    queryFn: () => api<PublicSettings>('/settings/turnstile'),
    staleTime: 60000,
  });
  const siteKey = settings.data?.siteKey ?? '';
  const [solution, setSolution] = useState<{
    siteKey: string;
    action: Action;
    token: string;
  } | null>(null);
  const [generation, setGeneration] = useState(0);
  const onToken = useCallback(
    (token: string) => setSolution(token ? { siteKey, action, token } : null),
    [siteKey, action],
  );
  const reset = useCallback(() => {
    setSolution(null);
    setGeneration((value) => value + 1);
    void settings.refetch();
  }, [settings.refetch]);
  const token =
    solution?.siteKey === siteKey && solution.action === action ? solution.token : undefined;
  const ready = settings.isSuccess && (!settings.data.enabled || Boolean(token));
  const widget =
    settings.isPending || settings.isError ? (
      <div className={styles.status} role="status">
        <span>{settings.isError ? '安全验证暂时不可用' : '正在加载安全验证…'}</span>
        {settings.isError && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            loading={settings.isFetching}
            onClick={() => void settings.refetch()}
          >
            重试
          </Button>
        )}
      </div>
    ) : settings.data.enabled ? (
      <Challenge
        key={`${siteKey}:${action}:${generation}`}
        siteKey={siteKey}
        action={action}
        onToken={onToken}
        onRetry={reset}
      />
    ) : null;
  return { token: settings.data?.enabled ? token : undefined, ready, reset, widget };
}
