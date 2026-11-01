import { Tooltip } from '@/components/arc/tooltip/tooltip';
import { dateTime, healthLabel } from '@/lib/format';
import type { CheckRun } from '@/lib/types';
import styles from './CheckStrip.module.css';

function detail(run: CheckRun) {
  const s = run.summary;
  const parts = [`${dateTime(run.created_at)} ${healthLabel[run.health]}`];
  if (s?.website?.total) parts.push(`官网 ${s.website.up}/${s.website.total}`);
  if (s?.subscription?.total) parts.push(`订阅 ${s.subscription.up}/${s.subscription.total}`);
  return parts.join(' · ');
}

export function CheckStrip({
  runs,
  onSelect,
}: {
  runs: CheckRun[];
  onSelect?: (run: CheckRun) => void;
}) {
  const ordered = [...runs].reverse();
  return (
    <div className={styles.strip} role="list" aria-label="检测记录">
      {ordered.map((run) => (
        <Tooltip key={run.id} content={detail(run)}>
          <button
            type="button"
            role="listitem"
            className={styles.cell}
            data-health={run.health}
            aria-label={detail(run)}
            onClick={onSelect ? () => onSelect(run) : undefined}
            data-interactive={onSelect ? true : undefined}
          />
        </Tooltip>
      ))}
    </div>
  );
}
