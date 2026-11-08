import { afterEach, describe, expect, it } from 'vitest';
import { day, daysBetween, deathNotice, operatingDates } from '../web/src/lib/format.js';

const originalTimezone = process.env.TZ;
afterEach(() => {
  if (originalTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimezone;
});

describe('operating calendar dates', () => {
  it.each(['UTC', 'America/Los_Angeles', 'Pacific/Auckland'])(
    'keeps calendar dates and a four-day span in %s',
    (timezone) => {
      process.env.TZ = timezone;
      expect(day('2026-10-30')).toBe('2026.10.30');
      expect(day('2026-11-03')).toBe('2026.11.03');
      expect(operatingDates('2026-10-30', '2026-11-03')).toBe('2026.10.30 — 2026.11.03');
      expect(daysBetween('2026-10-30', '2026-11-03')).toBe(4);
      expect(daysBetween('2026-11-03', '2026-11-03')).toBe(0);
      expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2);
    },
  );

  it('does not infer dates or a duration from missing history', () => {
    expect(operatingDates(null, null)).toBe('运营日期不详');
    expect(operatingDates(null, '2026-11-03')).toBe('起始不详 — 2026.11.03');
    expect(operatingDates('2026-10-30', null)).toBe('2026.10.30 — 结束不详');
    expect(daysBetween(null, null)).toBeNull();
    expect(daysBetween('2026-10-30', null)).toBeNull();
    expect(daysBetween(null, '2026-11-03')).toBeNull();
  });

  it.each([
    ['UTC', '2026-11-07'],
    ['America/Los_Angeles', '2026-11-07'],
    ['Pacific/Auckland', '2026-11-08'],
  ])('formats the confirmation notice in %s', (timezone, expectedDate) => {
    process.env.TZ = timezone;
    expect(deathNotice('2026-11-07T11:17:44.928Z')).toBe(
      `已跑路 · ${expectedDate.replaceAll('-', '.')}`,
    );
  });

  it('does not invent a confirmation date when it is unknown', () => {
    expect(deathNotice(null)).toBe('已跑路');
  });
});
