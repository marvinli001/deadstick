import type { Health, Lifecycle, Role } from './types';

const pad = (n: number) => String(n).padStart(2, '0');

export function day(value: string | null | undefined) {
  if (!value) return '—';
  const d = new Date(value);
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
}

export function dateTime(value: string | null | undefined) {
  if (!value) return '—';
  const d = new Date(value);
  return `${day(value)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ago(value: string | null | undefined, now = Date.now()) {
  if (!value) return '从未';
  const seconds = Math.round((now - new Date(value).getTime()) / 1000);
  if (seconds < 0) {
    const ahead = -seconds;
    if (ahead < 3600) return `${Math.max(1, Math.round(ahead / 60))} 分钟后`;
    if (ahead < 86400) return `${Math.round(ahead / 3600)} 小时后`;
    return `${Math.round(ahead / 86400)} 天后`;
  }
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} 小时前`;
  if (seconds < 86400 * 30) return `${Math.round(seconds / 86400)} 天前`;
  return day(value);
}

export function daysBetween(from: string, to: string | null) {
  const end = to ? new Date(to).getTime() : Date.now();
  return Math.max(0, Math.floor((end - new Date(from).getTime()) / 86400000));
}

export const lifecycleLabel: Record<Lifecycle, string> = {
  active: '存活',
  suspected: '疑似跑路',
  dead: '已跑路',
};

export const healthLabel: Record<Health, string> = {
  healthy: '正常',
  degraded: '部分异常',
  down: '不可用',
  unknown: '未知',
};

export const plot = (n: number) => `No.${String(n).padStart(3, '0')}`;

export const count = (n: number) => new Intl.NumberFormat('zh-CN').format(n);

export const roleLabel: Record<Role, string> = {
  user: '用户',
  moderator: '审核员',
  admin: '管理员',
};

export function host(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
