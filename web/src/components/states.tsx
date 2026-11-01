import type { ReactNode } from 'react';
import { CircleAlert } from 'lucide-react';
import { Skeleton } from '@/components/arc/skeleton/skeleton';
import { EmptyState } from '@/components/arc/empty-state/empty-state';
import { Button } from '@/components/arc/button/button';
import { errorText } from '@/lib/api';
import { Chrysanthemum } from './art';
import styles from './states.module.css';

export function Loading({ lines = 3 }: { lines?: number }) {
  return (
    <div className={styles.loading}>
      <Skeleton label="加载中" lines={lines} />
    </div>
  );
}

export function ErrorView({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <EmptyState
      className={styles.state}
      icon={<CircleAlert size={22} strokeWidth={1.5} />}
      title={errorText(error)}
      description=""
      action={
        onRetry && (
          <Button variant="secondary" size="sm" onClick={onRetry}>
            重试
          </Button>
        )
      }
    />
  );
}

export function Empty({
  title,
  action,
  icon,
}: {
  title: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <EmptyState
      className={styles.state}
      icon={icon ?? <Chrysanthemum size={26} simple />}
      title={title}
      description=""
      action={action}
    />
  );
}
