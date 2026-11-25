import { cn } from '@/lib/cn';

/**
 * Four signal bars. Decorative: the caller always shows or announces the status in words
 * (colour and bar count are never the only cue).
 */
export function SignalBars({
  level,
  className,
  tone = 'current',
}: {
  level: 0 | 1 | 2 | 3 | 4;
  className?: string;
  /** `current`: inherit text colour (header). `status`: red / amber / green by level. */
  tone?: 'current' | 'status';
}) {
  const filled =
    tone === 'current'
      ? 'fill-current'
      : level >= 3
        ? 'fill-status-sent'
        : level === 2
          ? 'fill-status-pending'
          : 'fill-status-failed';
  return (
    <svg viewBox="0 0 20 16" aria-hidden className={cn('size-5', className)}>
      {[0, 1, 2, 3].map((i) => {
        const height = 4 + i * 4;
        return (
          <rect
            key={i}
            x={i * 5 + 0.5}
            y={16 - height}
            width={3.5}
            height={height}
            rx={1}
            className={cn(
              i < level ? filled : tone === 'current' ? 'fill-current opacity-35' : 'fill-muted',
            )}
          />
        );
      })}
    </svg>
  );
}
