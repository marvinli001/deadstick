import { describe, expect, it } from 'vitest';
import {
  deliveryTime,
  defaultPolicy,
  isQuiet,
  matchesPolicy,
  presets,
  validatePolicy,
} from '../src/telegram/notification-policy.js';
import { eventTitle } from '../src/telegram/policy-delivery.js';
import { miniAppPath } from '../web/src/lib/telegram.js';

describe('notification policy', () => {
  it('matches explicit provider/tag/event scopes and separates manual conclusions from automatic recovery', () => {
    const p = { id: 'one', tags: ['国际', '月付'] };
    const base = { ...defaultPolicy, enabled: true };
    expect(matchesPolicy(base, 'anomaly', p)).toBe(true);
    expect(
      matchesPolicy({ ...base, scope: 'providers', providerIds: ['two'] }, 'dead', p, true),
    ).toBe(false);
    expect(matchesPolicy({ ...base, scope: 'tags', tags: ['国际'] }, 'dead', p, true)).toBe(true);
    expect(matchesPolicy({ ...base, events: ['dead'] }, 'anomaly', p)).toBe(false);
    expect(matchesPolicy({ ...base, conclusionsOnly: true }, 'recovery', p)).toBe(false);
    expect(matchesPolicy({ ...base, conclusionsOnly: true }, 'recovery', p, true)).toBe(true);
    expect(eventTitle({ type: 'anomaly' })).toBe('检测异常 · 尚未确认跑路');
    expect(eventTitle({ type: 'recovery', manual: true })).toBe('人工核验：服务恢复');
  });
  it('keeps the spectator preset limited to confirmed deaths and revivals', () => {
    const provider = { id: 'one', tags: [] };
    expect(matchesPolicy(presets.spectator!, 'dead', provider, true)).toBe(true);
    expect(matchesPolicy(presets.spectator!, 'revival', provider, true)).toBe(true);
    expect(matchesPolicy(presets.spectator!, 'recovery', provider, true)).toBe(false);
    expect(matchesPolicy(presets.spectator!, 'dismissed', provider, true)).toBe(false);
  });
  it('defers through overnight quiet hours in the configured timezone', () => {
    const p = {
      ...defaultPolicy,
      quietStart: '23:00',
      quietEnd: '08:00',
      timezone: 'Asia/Shanghai',
    };
    expect(isQuiet(p, new Date('2026-11-02T15:30:00Z'))).toBe(true);
    expect(isQuiet(p, new Date('2026-11-02T23:59:00Z'))).toBe(true);
    expect(isQuiet(p, new Date('2026-11-03T00:00:00Z'))).toBe(false);
    expect(deliveryTime(p, new Date('2026-11-02T15:30:00Z')).toISOString()).toBe(
      '2026-11-03T00:00:00.000Z',
    );
    expect(
      deliveryTime(
        { ...p, quietStart: '10:00', quietEnd: '12:00' },
        new Date('2026-11-02T03:00:00Z'),
      ).toISOString(),
    ).toBe('2026-11-02T04:00:00.000Z');
  });
  it('schedules daily summaries across timezone/DST changes and applies rate and merge windows', () => {
    const p = {
      ...defaultPolicy,
      mode: 'digest' as const,
      timezone: 'America/New_York',
      digestAt: '09:00',
    };
    expect(deliveryTime(p, new Date('2026-10-31T14:00:00Z')).toISOString()).toBe(
      '2026-11-01T14:00:00.000Z',
    );
    const quiet = {
      ...defaultPolicy,
      timezone: 'America/New_York',
      quietStart: '22:00',
      quietEnd: '08:00',
    };
    expect(deliveryTime(quiet, new Date('2026-11-01T03:00:00Z')).toISOString()).toBe(
      '2026-11-01T13:00:00.000Z',
    );
    expect(deliveryTime(quiet, new Date('2026-03-08T04:00:00Z')).toISOString()).toBe(
      '2026-03-08T12:00:00.000Z',
    );
    const realtime = { ...defaultPolicy, mergeSeconds: 60, minIntervalSeconds: 300 };
    expect(
      deliveryTime(
        realtime,
        new Date('2026-11-02T01:00:00Z'),
        new Date('2026-11-02T00:59:00Z'),
      ).toISOString(),
    ).toBe('2026-11-02T01:04:00.000Z');
    expect(() => validatePolicy({ ...defaultPolicy, timezone: 'Mars/Cloud' })).toThrow();
    expect(() => validatePolicy({ ...defaultPolicy, quietStart: '23:00' })).toThrow();
    expect(() => validatePolicy({ ...defaultPolicy, scope: 'tags' })).toThrow();
    expect(presets.spectator!.conclusionsOnly).toBe(true);
  });
  it('maps group settings without treating the link as authorization', () => {
    expect(miniAppPath('group_100123')).toBe('/groups/-100123');
    expect(miniAppPath('notification_preferences')).toBe('/me/notifications');
    expect(miniAppPath('group_-100123')).toBeUndefined();
  });
});
