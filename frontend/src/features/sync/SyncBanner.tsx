import {
  CheckCircle2,
  CloudOff,
  Inbox,
  KeyRound,
  Loader2,
  type LucideIcon,
  Send,
  ShieldAlert,
} from 'lucide-react';
import { Link } from 'react-router-dom';

import { syncNow } from '@/app/runtime';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { formatRelative } from '@/lib/format';
import { needsActionCount, useSync, waitingCount } from '@/stores/sync';
import { Button } from '@/ui/button';

/** One-line truth about the queue, announced politely to screen readers (ADD §16.4). */
export function SyncBanner({ compact = false }: { compact?: boolean }) {
  const { t, plural, locale } = useT();
  const { engine, counts, lastSuccessAt, stuck } = useSync();
  const waiting = waitingCount(counts);
  const action = needsActionCount(counts);

  // Before anything was ever sent, "All forms sent" would be a false claim.
  const nothingYet = lastSuccessAt === null && waiting === 0;
  let tone = nothingYet ? 'bg-card text-foreground' : 'bg-status-sent-bg text-status-sent';
  let Icon: LucideIcon = nothingYet ? Inbox : CheckCircle2;
  let headline = nothingYet ? t('sync.banner.nothingYet') : t('sync.banner.allSent');
  if (engine === 'PAUSED_AUTH') {
    tone = 'bg-status-pending-bg text-status-pending';
    Icon = KeyRound;
    headline = t('sync.banner.auth');
  } else if (engine === 'PAUSED_QUOTA') {
    tone = 'bg-status-failed-bg text-status-failed';
    Icon = ShieldAlert;
    headline = t('sync.banner.quota');
  } else if (engine === 'DRAINING' && waiting > 0) {
    tone = 'bg-status-sending-bg text-status-sending';
    Icon = Loader2;
    headline = t('sync.banner.sending');
  } else if (engine === 'PAUSED_OFFLINE' && waiting > 0) {
    tone = 'bg-status-pending-bg text-status-pending';
    Icon = CloudOff;
    headline = t('sync.banner.offline');
  } else if (waiting > 0) {
    tone = 'bg-status-pending-bg text-status-pending';
    Icon = Send;
    headline = plural('sync.banner.waiting', waiting);
  }

  return (
    <section aria-label={t('syncPage.title')} className={cn('rounded-lg border p-4', tone)}>
      <div className="flex items-start gap-3">
        <Icon
          aria-hidden
          className={cn(
            'mt-0.5 size-6 shrink-0',
            Icon === Loader2 && 'animate-spin motion-reduce:animate-none',
          )}
        />
        <div className="min-w-0 flex-1" role="status" aria-live="polite">
          <p className="text-lg font-bold leading-snug">{headline}</p>
          {waiting > 0 && engine !== 'DRAINING' && (
            <p className="font-medium">{plural('sync.banner.waiting', waiting)}</p>
          )}
          {action > 0 && (
            <Link to="/sync" className="font-semibold underline underline-offset-4">
              {plural('sync.needsAction', action)}
            </Link>
          )}
          {stuck > 0 && <p className="font-semibold">{plural('sync.stuck', stuck)}</p>}
          {!compact && (
            <p className="text-sm font-medium">
              {lastSuccessAt
                ? t('sync.lastSync', { time: formatRelative(lastSuccessAt, locale) })
                : t('sync.neverSynced')}
            </p>
          )}
        </div>
        {waiting > 0 && engine !== 'DRAINING' && (
          <Button
            size="sm"
            variant="outline"
            className="shrink-0 bg-card"
            onClick={() => void syncNow()}
          >
            {t('sync.syncNow')}
          </Button>
        )}
      </div>
    </section>
  );
}
