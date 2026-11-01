import type { SVGProps } from 'react';
import styles from './art.module.css';

type ArtProps = SVGProps<SVGSVGElement> & { size?: number };

function ring(count: number, distance: number, rx: number, ry: number, offset = 0) {
  return Array.from({ length: count }, (_, i) => (
    <ellipse
      key={`${distance}-${i}`}
      cx="50"
      cy={50 - distance}
      rx={rx}
      ry={ry}
      transform={`rotate(${(360 / count) * i + offset} 50 50)`}
    />
  ));
}

/** White chrysanthemum: three rings of outlined petals around a yellow heart. */
export function Chrysanthemum({
  size = 96,
  simple = false,
  className,
  ...props
}: ArtProps & { simple?: boolean }) {
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      aria-hidden="true"
      className={[styles.flower, className].filter(Boolean).join(' ')}
      {...props}
    >
      <g className={styles.petals}>
        {simple ? (
          ring(12, 24, 9, 22)
        ) : (
          <>
            {ring(22, 28, 5.5, 19)}
            {ring(16, 18, 5.5, 15, 11)}
            {ring(11, 9, 5, 10, 5)}
          </>
        )}
      </g>
      <circle className={styles.heart} cx="50" cy="50" r={simple ? 11 : 7} />
    </svg>
  );
}

export function Candle({
  size = 48,
  lit = false,
  className,
  ...props
}: ArtProps & { lit?: boolean }) {
  return (
    <svg
      viewBox="0 0 40 100"
      width={size * 0.4}
      height={size}
      aria-hidden="true"
      className={[styles.candle, lit && styles.lit, className].filter(Boolean).join(' ')}
      {...props}
    >
      <path className={styles.flame} d="M20 8 C26 18 27 26 20 34 C13 26 14 18 20 8 Z" />
      <line className={styles.line} x1="20" y1="34" x2="20" y2="42" />
      <rect className={styles.body} x="11" y="42" width="18" height="46" />
      <rect className={styles.base} x="4" y="88" width="32" height="8" />
    </svg>
  );
}

export function Incense({
  size = 48,
  lit = false,
  className,
  ...props
}: ArtProps & { lit?: boolean }) {
  const sticks = [18, 30, 42];
  return (
    <svg
      viewBox="0 0 60 100"
      width={size * 0.6}
      height={size}
      aria-hidden="true"
      className={[styles.incense, lit && styles.lit, className].filter(Boolean).join(' ')}
      {...props}
    >
      {sticks.map((x, i) => (
        <g key={x}>
          <path
            className={styles.smoke}
            style={{ animationDelay: `${i * 0.5}s` }}
            d={`M${x} 30 C${x - 6} 22 ${x + 6} 14 ${x} 4`}
          />
          <line className={styles.line} x1={x} y1="32" x2={x} y2="72" />
          <circle className={styles.ember} cx={x} cy="32" r="2.4" />
        </g>
      ))}
      <path className={styles.body} d="M6 72 H54 L48 94 H12 Z" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={[styles.wordmark, className].filter(Boolean).join(' ')}>
      <Chrysanthemum size={20} simple />
      <span>DEADSTICK</span>
    </span>
  );
}
