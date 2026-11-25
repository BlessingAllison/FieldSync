import { AnimatePresence, m } from 'framer-motion';
import { ChevronRight } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { retryItem } from '@/app/runtime';
import { type I18nText } from '@/core/validation/types';
import { isStuck } from '@/core/sync/types';
import { useT } from '@/i18n';
import { formatRelative } from '@/lib/format';
import { tx } from '@/lib/template-text';
import { Button } from '@/ui/button';
import { EmptyState, SyncArt } from '@/ui/illustrations';
import { ListSkeleton } from '@/ui/skeleton';
import { type ChipState, SyncChip } from '@/ui/sync-chip';

import { SyncBanner } from './SyncBanner';
import { type QueueRow, useQueue } from './useQueue';

const PAGE = 50;

/** Ticks every second so "Next try in 12 s" counts down. */
function useNow(intervalMs = 1_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export default function SyncPage() {
  const { t, plural, locale } = useT();
  const { data, loading } = useQueue();
  const now = useNow();
  const [limit, setLimit] = useState(PAGE);
  if (loading || !data) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        <h1 className="text-2xl font-bold tracking-tight">{t('syncPage.title')}</h1>
        <ListSkeleton rows={5} />
      </div>
    );
  }

  const title = (code: string, version: number): string => {
    const text: I18nText | undefined = data.titles.get(`${code}:${version}`);
    return text ? tx(text, locale) : code;
  };

  const row = ({ item, summary }: QueueRow, extra?: ReactNode) => (
    <m.li
      key={item.clientUuid}
      layout
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.15 }}
    >
      <div className="flex items-center gap-3 rounded-lg border bg-card p-4">
        <Link to={`/sync/${item.clientUuid}`} className="flex min-w-0 flex-1 items-center gap-3">
          <span className="min-w-0 flex-1">
            <span className="block truncate font-semibold">
              {summary.patientLabel ?? t('syncPage.noLabel')}
            </span>
            <span className="block truncate text-sm text-muted-foreground">
              {title(item.templateCode, item.templateVersion)} ·{' '}
              {t('syncPage.captured', { time: formatRelative(item.capturedAt, locale, now) })}
            </span>
            {item.state === 'RETRY_WAIT' && (
              <span className="block text-sm font-medium text-status-pending">
                {plural('syncPage.attempts', item.attempts)} ·{' '}
                {t('syncPage.retryIn', {
                  time: formatRelative(Math.max(item.nextAttemptAt, now), locale, now),
                })}
              </span>
            )}
            {isStuck(item, now) && (
              <span className="block text-sm font-semibold text-status-failed">
                {t('syncPage.stuckHelp')}
              </span>
            )}
          </span>
          <SyncChip state={item.state} label={t(`state.${item.state}`)} />
          <ChevronRight aria-hidden className="size-5 shrink-0 text-muted-foreground" />
        </Link>
        {extra}
      </div>
    </m.li>
  );

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <h1 className="text-2xl font-bold tracking-tight">{t('syncPage.title')}</h1>
      <SyncBanner />

      {data.action.length > 0 && (
        <section aria-labelledby="action-title" className="flex flex-col gap-2">
          <h2 id="action-title" className="text-lg font-bold text-status-failed">
            {t('syncPage.needsAction')} ({data.action.length})
          </h2>
          <ul className="flex flex-col gap-2">
            <AnimatePresence initial={false}>{data.action.map((r) => row(r))}</AnimatePresence>
          </ul>
        </section>
      )}

      <section aria-labelledby="waiting-title" className="flex flex-col gap-2">
        <h2 id="waiting-title" className="text-lg font-bold">
          {t('syncPage.waiting')} ({data.waiting.length})
        </h2>
        {data.waiting.length === 0 ? (
          <EmptyState Art={SyncArt} title={t('syncPage.empty.title')} body={t('syncPage.empty')} />
        ) : (
          <ul className="flex flex-col gap-2">
            <AnimatePresence initial={false}>
              {data.waiting.slice(0, limit).map((r) =>
                row(
                  r,
                  r.item.state === 'RETRY_WAIT' ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void retryItem(r.item.clientUuid)}
                    >
                      {t('syncPage.retryNow')}
                    </Button>
                  ) : undefined,
                ),
              )}
            </AnimatePresence>
          </ul>
        )}
        {data.waiting.length > limit && (
          <Button variant="outline" onClick={() => setLimit(limit + PAGE)}>
            {t('syncPage.showMore')} ({data.waiting.length - limit})
          </Button>
        )}
      </section>

      <section aria-labelledby="sent-title" className="flex flex-col gap-2">
        <h2 id="sent-title" className="text-lg font-bold">
          {t('syncPage.sent')} ({data.sent.length})
        </h2>
        {data.sent.length === 0 && (
          <p className="text-muted-foreground">{t('syncPage.sentEmpty')}</p>
        )}
        <ul className="flex flex-col gap-2">
          {data.sent.slice(0, 20).map(({ receipt, summary }) => (
            <li key={receipt.clientUuid}>
              <Link
                to={`/sync/${receipt.clientUuid}`}
                className="flex min-h-tap items-center gap-3 rounded-lg border bg-card p-4 hover:bg-accent"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">
                    {summary.patientLabel ?? t('syncPage.noLabel')}
                  </span>
                  <span className="block truncate text-sm text-muted-foreground">
                    {title(receipt.templateCode, receipt.templateVersion)} ·{' '}
                    {receipt.syncedAt ? formatRelative(receipt.syncedAt, locale, now) : ''}
                  </span>
                </span>
                <SyncChip state={'SYNCED' satisfies ChipState} label={t('state.SYNCED')} />
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
