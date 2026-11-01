import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useLocation, useNavigate } from 'react-router';
import { Button } from '@/components/arc/button/button';
import { SlotText } from '@/components/arc/slot-text/slot-text';
import { useToastStack } from '@/components/arc/toast-stack/toast-stack';
import { motionTokens } from '@/components/arc/lib/motion-tokens';
import { errorText } from '@/lib/api';
import { count } from '@/lib/format';
import { tributeCount, useTribute } from '@/lib/queries';
import { useSession } from '@/lib/session';
import type { ProviderDetail, TributeKind } from '@/lib/types';
import { Candle, Chrysanthemum, Incense } from './art';
import styles from './Tributes.module.css';

const WALL = 28;
const done: Record<TributeKind, string> = {
  flower: '今天献过花了',
  candle: '今天点过烛了',
  incense: '今天上过香了',
};

function FlowerWall({ total, fresh }: { total: number; fresh: number }) {
  const reduced = useReducedMotion();
  const shown = Math.min(total, WALL);
  return (
    <div className={styles.wall} aria-hidden="true">
      <AnimatePresence initial={false}>
        {Array.from({ length: shown }, (_, i) => (
          <motion.span
            key={i}
            className={styles.bloom}
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: -56, rotate: -140, scale: 0.4 }}
            animate={{ opacity: 1, y: 0, rotate: 0, scale: 1 }}
            transition={
              reduced
                ? { duration: motionTokens.duration.fast }
                : { type: 'spring', visualDuration: 0.7, bounce: 0.18 }
            }
            data-fresh={i >= shown - fresh || undefined}
          >
            <Chrysanthemum size={22} simple />
          </motion.span>
        ))}
      </AnimatePresence>
      {total > WALL && <span className={`${styles.more} mono`}>+{count(total - WALL)}</span>}
    </div>
  );
}

export function Tributes({ provider, slug }: { provider: ProviderDetail; slug: string }) {
  const { user } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToastStack();
  const tribute = useTribute(provider, slug);
  const [fresh, setFresh] = useState(0);
  const [pending, setPending] = useState<TributeKind | null>(null);

  const offer = (kind: TributeKind) => {
    if (!user) return navigate(`/login?next=${encodeURIComponent(location.pathname)}`);
    setPending(kind);
    tribute.mutate(kind, {
      onSuccess: (result) => {
        if (!result.created) toast({ type: 'info', title: done[kind] });
        else if (kind === 'flower') setFresh((n) => n + 1);
      },
      onError: (error) => toast({ type: 'error', title: errorText(error) }),
      onSettled: () => setPending(null),
    });
  };

  const flowers = tributeCount(provider, 'flower');
  const candles = tributeCount(provider, 'candle');
  const incense = tributeCount(provider, 'incense');
  const items: { kind: TributeKind; label: string; value: number; art: React.ReactNode }[] = [
    { kind: 'flower', label: '献花', value: flowers, art: <Chrysanthemum size={34} /> },
    { kind: 'candle', label: '点烛', value: candles, art: <Candle size={38} lit={candles > 0} /> },
    {
      kind: 'incense',
      label: '上香',
      value: incense,
      art: <Incense size={38} lit={incense > 0} />,
    },
  ];

  return (
    <div className={styles.root}>
      <FlowerWall total={flowers} fresh={fresh} />
      <div className={styles.actions}>
        {items.map((item) => (
          <div key={item.kind} className={styles.item}>
            <span className={styles.art}>{item.art}</span>
            <Button
              variant="secondary"
              className={styles.offer}
              loading={pending === item.kind}
              onClick={() => offer(item.kind)}
            >
              {item.label}
            </Button>
            <SlotText
              className={`${styles.count} mono`}
              value={item.value}
              format={count}
              spins={0}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
