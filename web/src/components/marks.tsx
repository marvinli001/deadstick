import type { Health, Lifecycle } from '@/lib/types';
import { healthLabel, lifecycleLabel } from '@/lib/format';
import styles from './marks.module.css';

export function LifecycleMark({ value, size = 'md' }: { value: Lifecycle; size?: 'sm' | 'md' }) {
  return (
    <span className={styles.lifecycle} data-value={value} data-size={size}>
      {lifecycleLabel[value]}
    </span>
  );
}

export function HealthMark({ value, label = true }: { value: Health; label?: boolean }) {
  return (
    <span className={styles.health} data-value={value} title={healthLabel[value]}>
      <i aria-hidden="true" />
      {label ? healthLabel[value] : <span className="visually-hidden">{healthLabel[value]}</span>}
    </span>
  );
}

const statusText: Record<string, string> = {
  pending: '待审',
  approved: '已通过',
  rejected: '已驳回',
  open: '待核验',
  resolved: '已恢复',
  confirmed_dead: '确认跑路',
  dismissed: '已排除',
  running: '进行中',
  done: '完成',
  failed: '失败',
  sent: '已发送',
  visible: '公开',
  hidden: '隐藏',
};

const tone: Record<string, string> = {
  pending: 'wait',
  open: 'wait',
  running: 'wait',
  approved: 'ok',
  resolved: 'ok',
  done: 'ok',
  sent: 'ok',
  visible: 'ok',
  rejected: 'muted',
  dismissed: 'muted',
  hidden: 'muted',
  failed: 'bad',
  confirmed_dead: 'dead',
};

export function StatusTag({ value }: { value: string }) {
  return (
    <span className={styles.tag} data-tone={tone[value] ?? 'muted'}>
      {statusText[value] ?? value}
    </span>
  );
}
