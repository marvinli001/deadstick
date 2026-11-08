import { Type, type Static } from '@sinclair/typebox';
import { AppError } from '../errors.js';

export const eventLabels = {
  anomaly: '检测异常',
  recovery: '检测恢复',
  dead: '已跑路',
  dismissed: '异常解除',
  revival: '恢复运营',
};
export type EventType = keyof typeof eventLabels;
const clock = Type.String({ pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' });
export const NotificationPolicy = Type.Object(
  {
    enabled: Type.Boolean(),
    conclusionsOnly: Type.Boolean(),
    scope: Type.Union([Type.Literal('all'), Type.Literal('providers'), Type.Literal('tags')]),
    providerIds: Type.Array(Type.String({ format: 'uuid' }), { maxItems: 100, uniqueItems: true }),
    tags: Type.Array(Type.String({ minLength: 1, maxLength: 40 }), {
      maxItems: 20,
      uniqueItems: true,
    }),
    events: Type.Array(
      Type.Union([
        Type.Literal('anomaly'),
        Type.Literal('recovery'),
        Type.Literal('dead'),
        Type.Literal('dismissed'),
        Type.Literal('revival'),
      ]),
      { maxItems: 5, uniqueItems: true },
    ),
    mode: Type.Union([Type.Literal('realtime'), Type.Literal('digest')]),
    timezone: Type.String({ minLength: 1, maxLength: 80 }),
    quietStart: Type.Union([clock, Type.Null()]),
    quietEnd: Type.Union([clock, Type.Null()]),
    digestAt: clock,
    minIntervalSeconds: Type.Integer({ minimum: 0, maximum: 86400 }),
    mergeSeconds: Type.Integer({ minimum: 0, maximum: 900 }),
    tone: Type.Union([Type.Literal('restrained'), Type.Literal('playful')]),
  },
  { additionalProperties: false },
);
export type NotificationPolicy = Static<typeof NotificationPolicy>;
export const defaultPolicy: NotificationPolicy = {
  enabled: false,
  conclusionsOnly: false,
  scope: 'all',
  providerIds: [],
  tags: [],
  events: ['anomaly', 'recovery', 'dead', 'dismissed', 'revival'],
  mode: 'realtime',
  timezone: 'Asia/Shanghai',
  quietStart: null,
  quietEnd: null,
  digestAt: '09:00',
  minIntervalSeconds: 0,
  mergeSeconds: 0,
  tone: 'restrained',
};
export const presets: Record<string, NotificationPolicy> = {
  duty: { ...defaultPolicy, enabled: true, minIntervalSeconds: 60, mergeSeconds: 30 },
  spectator: {
    ...defaultPolicy,
    enabled: true,
    conclusionsOnly: true,
    events: ['dead', 'revival'],
    tone: 'playful',
    quietStart: '23:00',
    quietEnd: '08:00',
    mergeSeconds: 120,
    minIntervalSeconds: 300,
  },
  daily: { ...defaultPolicy, enabled: true, mode: 'digest', minIntervalSeconds: 3600 },
};
export function policyWithDefaults(
  value: Partial<NotificationPolicy> | null,
  personal = false,
): NotificationPolicy {
  return { ...defaultPolicy, enabled: personal, ...value };
}
export function validatePolicy(policy: NotificationPolicy) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: policy.timezone }).format();
  } catch {
    throw new AppError(400, 'TIMEZONE', '请选择有效时区');
  }
  if (
    (policy.quietStart === null) !== (policy.quietEnd === null) ||
    (policy.quietStart !== null && policy.quietStart === policy.quietEnd)
  )
    throw new AppError(400, 'QUIET_HOURS', '静默开始和结束须成对设置且不能相同');
  if (
    (policy.scope === 'providers' && !policy.providerIds.length) ||
    (policy.scope === 'tags' && !policy.tags.length)
  )
    throw new AppError(400, 'NOTIFICATION_SCOPE', '请选择机场或标签');
}
export function matchesPolicy(
  policy: NotificationPolicy,
  event: EventType,
  provider: { id: string; tags: string[] },
  manual = false,
) {
  return (
    policy.enabled &&
    (!policy.conclusionsOnly || manual) &&
    policy.events.includes(event) &&
    (policy.scope === 'all' ||
      (policy.scope === 'providers' && policy.providerIds.includes(provider.id)) ||
      (policy.scope === 'tags' && policy.tags.some((tag) => provider.tags.includes(tag))))
  );
}
export function localClock(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return {
    minute: Number(get('hour')) * 60 + Number(get('minute')),
    day: `${get('year')}-${get('month')}-${get('day')}`,
  };
}
const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
export function isQuiet(policy: NotificationPolicy, date: Date) {
  if (policy.quietStart === null || policy.quietEnd === null) return false;
  const now = localClock(date, policy.timezone).minute,
    start = minutes(policy.quietStart),
    end = minutes(policy.quietEnd);
  return start < end ? now >= start && now < end : now >= start || now < end;
}
/** Minute scanning follows real timezone transitions, including skipped or repeated DST hours. */
export function deliveryTime(policy: NotificationPolicy, createdAt: Date, lastSent?: Date | null) {
  let due = new Date(createdAt.getTime() + policy.mergeSeconds * 1000);
  if (policy.mode === 'digest') {
    due = new Date(Math.floor(createdAt.getTime() / 60000) * 60000 + 60000);
    for (let i = 0; i < 3000; i++, due = new Date(due.getTime() + 60000)) {
      if (localClock(due, policy.timezone).minute === minutes(policy.digestAt)) break;
    }
  }
  if (lastSent)
    due = new Date(Math.max(due.getTime(), lastSent.getTime() + policy.minIntervalSeconds * 1000));
  for (let i = 0; i < 3000 && isQuiet(policy, due); i++)
    due = new Date(Math.floor(due.getTime() / 60000) * 60000 + 60000);
  return due;
}
