import { afterEach, describe, expect, it, vi } from 'vitest';
import { miniAppPath } from '../web/src/lib/telegram.js';
import { miniAppButton, miniAppLink, providerKeyboard } from '../src/telegram/format.js';
import { loadConfig } from '../src/config.js';
import { randomBytes } from 'node:crypto';

const config = loadConfig({
  APP_KEY: randomBytes(32).toString('base64'),
  PUBLIC_URL: 'https://deadstick.example',
  TELEGRAM_BOT_USERNAME: 'deadstick_test_bot',
});
const id = '12345678-1234-1234-1234-123456789012';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('Telegram Mini App navigation', () => {
  it('maps only known destinations and provider IDs to internal routes', () => {
    expect(miniAppPath('admin')).toBe('/console');
    expect(miniAppPath('review_submissions')).toBe('/console/submissions');
    expect(miniAppPath(`search_${Buffer.from('测试 /console').toString('base64url')}`)).toBe(
      `/airports?q=${encodeURIComponent('测试 /console')}`,
    );
    expect(miniAppPath(`p_${id.replace(/-/g, '')}`)).toBe(`/airports/${id}`);
    expect(miniAppPath(`i_${id.replace(/-/g, '')}`)).toBe(`/console/incidents?id=${id}`);
    expect(miniAppPath(`s_${id.replace(/-/g, '')}`)).toBe(`/console/submissions?id=${id}`);
    expect(miniAppPath(`m_${id.replace(/-/g, '')}`)).toBe(`/console/memorials?id=${id}`);
    expect(miniAppPath('users')).toBe('/console/users');
    expect(miniAppPath(`report_${id.replace(/-/g, '')}`)).toBe(`/submit?provider=${id}`);
    expect(miniAppPath('group_100123')).toBe('/groups/-100123');
    expect(miniAppPath('notification_preferences')).toBe('/me/notifications');
    for (const payload of [
      'https://evil.example',
      '//evil.example',
      '__proto__',
      '/console',
      'p_invalid',
      'report_invalid',
      'group_-100123',
      'group_100123/console',
      null,
    ])
      expect(miniAppPath(payload)).toBeUndefined();
  });
  it('uses web_app buttons only in private chats and Telegram links in shared messages', () => {
    expect(miniAppButton(config, '投稿', 'submit', true)).toEqual([
      { text: '投稿', web_app: { url: 'https://deadstick.example/?tgWebAppStartParam=submit' } },
    ]);
    expect(miniAppLink(config, 'admin')).toBe('https://t.me/deadstick_test_bot?startapp=admin');
    const keyboard = providerKeyboard(
      { id, name: '<test>', slug: 'test', lifecycle: 'active', health: 'healthy', epitaph: null },
      config,
      { interactive: true },
    );
    expect(JSON.stringify(keyboard)).toContain(`startapp=p_${id.replace(/-/g, '')}`);
    expect(JSON.stringify(keyboard)).not.toContain('https://deadstick.example/airports');
    expect(JSON.stringify(keyboard)).not.toContain('web_app');
  });
  it('captures launch data once, strips it from the URL and opens the Telegram destination before routing', async () => {
    const sdk = {
      initData: 'signed-launch',
      ready: vi.fn(),
      expand: vi.fn(),
      isVersionAtLeast: vi.fn(() => true),
      setHeaderColor: vi.fn(),
      setBackgroundColor: vi.fn(),
      setBottomBarColor: vi.fn(),
    };
    const history = { state: null, replaceState: vi.fn() };
    const document = { documentElement: { dataset: {} as Record<string, string> } };
    vi.stubGlobal('window', {
      Telegram: { WebApp: sdk },
      location: new URL(
        'https://deadstick.example/?tgWebAppStartParam=admin#tgWebAppData=signed-launch',
      ),
    });
    vi.stubGlobal('history', history);
    vi.stubGlobal('document', document);
    vi.resetModules();
    const runtime = await import('../web/src/lib/telegram.js');
    expect(runtime.isMiniApp).toBe(true);
    expect(runtime.telegramInitData).toBe('signed-launch');
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/console');
    expect(document.documentElement.dataset.telegram).toBe('true');
    expect(sdk.ready).toHaveBeenCalledOnce();
    expect(sdk.expand).toHaveBeenCalledOnce();
    vi.stubGlobal('window', {
      Telegram: { WebApp: { ...sdk, initData: 'start_param=admin' } },
      location: new URL('https://deadstick.example/me/follows'),
    });
    vi.resetModules();
    await import('../web/src/lib/telegram.js');
    expect(history.replaceState).toHaveBeenLastCalledWith(null, '', '/me/follows');
  });
});
