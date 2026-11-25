import { AlertTriangle, CheckCircle2, Loader2, XCircle } from 'lucide-react';

import { cn } from '@/lib/cn';

export type BadgeTone = 'ok' | 'warn' | 'fail' | 'checking';

const TONE: Record<BadgeTone, { className: string; Icon: typeof CheckCircle2 }> = {
  ok: { className: 'bg-status-sent-bg text-status-sent', Icon: CheckCircle2 },
  warn: { className: 'bg-status-pending-bg text-status-pending', Icon: AlertTriangle },
  fail: { className: 'bg-status-failed-bg text-status-failed', Icon: XCircle },
  checking: { className: 'bg-muted text-muted-foreground', Icon: Loader2 },
};

/** Status is always icon + text, never colour alone (WCAG 1.4.1). */
export function StatusBadge({ tone, label }: { tone: BadgeTone; label: string }) {
  const { className, Icon } = TONE[tone];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold',
        className,
      )}
    >
      <Icon aria-hidden className={cn('size-4', tone === 'checking' && 'animate-spin')} />
      {label}
    </span>
  );
}
