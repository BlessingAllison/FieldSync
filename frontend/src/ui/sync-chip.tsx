import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  GitCompareArrows,
  Loader2,
  RotateCcw,
  type LucideIcon,
} from 'lucide-react';

import { cn } from '@/lib/cn';

export type ChipState = 'PENDING' | 'SYNCING' | 'RETRY_WAIT' | 'FAILED' | 'CONFLICT' | 'SYNCED';

const STYLE: Record<ChipState, { className: string; Icon: LucideIcon; spin?: boolean }> = {
  PENDING: { className: 'bg-status-pending-bg text-status-pending', Icon: Clock },
  SYNCING: { className: 'bg-status-sending-bg text-status-sending', Icon: Loader2, spin: true },
  RETRY_WAIT: { className: 'bg-status-pending-bg text-status-pending', Icon: RotateCcw },
  FAILED: { className: 'bg-status-failed-bg text-status-failed', Icon: AlertTriangle },
  CONFLICT: { className: 'bg-status-conflict-bg text-status-conflict', Icon: GitCompareArrows },
  SYNCED: { className: 'bg-status-sent-bg text-status-sent', Icon: CheckCircle2 },
};

/** Sync state: icon + text, never colour alone. */
export function SyncChip({
  state,
  label,
  className,
}: {
  state: ChipState;
  label: string;
  className?: string;
}) {
  const { className: tone, Icon, spin } = STYLE[state];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1 text-sm font-semibold',
        tone,
        className,
      )}
    >
      <Icon
        aria-hidden
        className={cn('size-4', spin && 'animate-spin motion-reduce:animate-none')}
      />
      {label}
    </span>
  );
}
