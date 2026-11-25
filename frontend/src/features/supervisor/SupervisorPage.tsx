import { AnimatePresence, m } from 'framer-motion';
import {
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  CloudOff,
  RefreshCw,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { api, getVault } from '@/app/runtime';
import type { FacilityHealth, SyncStatus } from '@/core/api/client';
import { type MessageKey, useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { formatRelative } from '@/lib/format';
import { useApp } from '@/stores/app';
import { Button } from '@/ui/button';
import { DashboardSkeleton } from '@/ui/skeleton';

import { HEALTH_ORDER, type Health } from './health';
import { HealthBar } from './HealthBar';

const HEALTH: Record<FacilityHealth['health'], { Icon: LucideIcon; className: string }> = {
  healthy: {
    Icon: CheckCircle2,
    className: 'bg-status-sent-bg text-status-sent border-status-sent/40',
  },
  degraded: {
    Icon: AlertTriangle,
    className: 'bg-status-pending-bg text-status-pending border-status-pending/40',
  },
  stale: {
    Icon: XCircle,
    className: 'bg-status-failed-bg text-status-failed border-status-failed/40',
  },
  unknown: { Icon: CircleHelp, className: 'bg-muted text-muted-foreground border-border' },
};
const ORDER = HEALTH_ORDER;

export default function SupervisorPage() {
  const { t, locale } = useT();
  const [data, setData] = useState<{ status: SyncStatus; asOf: number; cached: boolean } | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Health | 'all'>('all');
  const profile = useApp((state) => state.profile);

  const load = useCallback(async () => {
    setLoading(true);
    const vault = getVault();
    const result = await api.syncStatus();
    if (result.ok) {
      const asOf = Date.now();
      await vault.cacheDashboard({ scope: 'default', asOf, data: result.data });
      setData({ status: result.data, asOf, cached: false });
    } else {
      const cached = await vault.getDashboard('default');
      setData(
        cached ? { status: cached.data as SyncStatus, asOf: cached.asOf, cached: true } : null,
      );
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !data) return <DashboardSkeleton />;
  if (!data) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col items-center gap-4 rounded-lg border border-dashed p-8 text-center">
        <CloudOff aria-hidden className="size-10 text-muted-foreground" />
        <p className="text-lg">{t('dash.noData')}</p>
        <Button onClick={() => void load()}>{t('common.retry')}</Button>
      </div>
    );
  }

  const { status } = data;
  const summary = status.summary as Record<string, number | null>;
  const counts = Object.fromEntries(
    HEALTH_ORDER.map((h) => [h, Number(summary[h] ?? 0)]),
  ) as Record<Health, number>;
  const facilities = [...status.facilities]
    .sort(
      (a, b) => ORDER.indexOf(a.health) - ORDER.indexOf(b.health) || a.code.localeCompare(b.code),
    )
    .filter((f) => filter === 'all' || f.health === filter);
  const pct = (v: number | null | undefined) =>
    v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`;

  const tiles: Array<{ label: MessageKey; value: string | number; tone?: string }> = [
    {
      label: 'dash.pending',
      value: summary.pending_on_devices ?? 0,
      tone: (summary.pending_on_devices ?? 0) > 0 ? 'text-status-pending' : '',
    },
    {
      label: 'dash.stuck',
      value: summary.stuck ?? 0,
      tone: (summary.stuck ?? 0) > 0 ? 'text-status-failed' : '',
    },
    {
      label: 'dash.conflicts',
      value: summary.conflicts_open ?? 0,
      tone: (summary.conflicts_open ?? 0) > 0 ? 'text-status-conflict' : '',
    },
    { label: 'dash.rejected', value: summary.rejected_open ?? 0 },
    { label: 'dash.successRate', value: pct(summary.first_attempt_success_7d) },
  ];

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight lg:text-3xl">{t('dash.title')}</h1>
          <p className="text-muted-foreground">
            {profile?.county ? `${profile.county.name} · ` : ''}
            {t('dash.asOf', { time: formatRelative(data.asOf, locale) })}
          </p>
        </div>
        <Button variant="outline" onClick={() => void load()} disabled={loading}>
          <RefreshCw
            aria-hidden
            className={cn(loading && 'animate-spin motion-reduce:animate-none')}
          />
          {t('dash.refresh')}
        </Button>
      </div>
      {data.cached && (
        <p
          role="status"
          className="flex items-center gap-2 rounded-lg border border-status-pending/40 bg-status-pending-bg p-3 font-medium text-status-pending"
        >
          <CloudOff aria-hidden className="size-5 shrink-0" />
          {t('dash.offlineCached')}
        </p>
      )}

      <section className="rounded-lg border bg-card p-4 lg:p-5">
        <HealthBar counts={counts} selected={filter} onSelect={setFilter} />
      </section>

      {/* <dl> may only contain dt/dd, or one wrapping <div> per group. */}
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {tiles.map((tile, index) => (
          <div
            key={tile.label}
            className={cn(
              'rounded-lg border bg-card p-4 text-card-foreground shadow-sm',
              index === tiles.length - 1 && 'col-span-2 sm:col-span-1',
            )}
          >
            <dt className="text-sm text-muted-foreground">{t(tile.label)}</dt>
            <dd className={cn('text-3xl font-bold', tile.tone)}>{tile.value}</dd>
          </div>
        ))}
      </dl>

      <div
        role="group"
        aria-label={t('dash.filter')}
        className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0"
      >
        {(['all', ...ORDER] as const).map((h) => {
          const count = h === 'all' ? status.facilities.length : counts[h];
          return (
            <button
              key={h}
              type="button"
              aria-pressed={filter === h}
              onClick={() => setFilter(h)}
              className={cn(
                'min-h-tap shrink-0 whitespace-nowrap rounded-full border-2 px-4 font-semibold',
                filter === h
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-input bg-card hover:bg-accent',
              )}
            >
              {h === 'all' ? t('dash.filterAll') : t(`dash.health.${h}`)} ({count})
            </button>
          );
        })}
      </div>

      <section aria-label={t('dash.facilities')}>
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
          <AnimatePresence initial={false}>
            {facilities.map((f) => {
              const { Icon, className } = HEALTH[f.health];
              return (
                <m.li
                  key={f.facility_id}
                  layout
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15 }}
                >
                  <article className="flex h-full flex-col gap-3 rounded-lg border bg-card p-4">
                    <header className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <h2 className="text-lg font-bold leading-tight">{f.name}</h2>
                        <p className="text-sm text-muted-foreground">{f.code}</p>
                      </div>
                      <span
                        className={cn(
                          'inline-flex shrink-0 items-center gap-1.5 self-start rounded-full border px-3 py-1 text-sm font-bold',
                          className,
                        )}
                      >
                        <Icon aria-hidden className="size-4" />
                        {t(`dash.health.${f.health}`)}
                      </span>
                    </header>
                    {f.reasons.length > 0 && (
                      <ul className="flex flex-wrap gap-1.5">
                        {f.reasons.map((r) => (
                          <li
                            key={r}
                            className="rounded-md bg-muted px-2 py-0.5 text-sm font-medium"
                          >
                            {t(`dash.reason.${r}` as MessageKey)}
                          </li>
                        ))}
                      </ul>
                    )}
                    <dl className="mt-auto grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 border-t pt-3 text-sm">
                      <dt className="text-muted-foreground">{t('dash.lastSync')}</dt>
                      <dd className="text-right font-semibold">
                        {f.last_success_at
                          ? formatRelative(Date.parse(f.last_success_at), locale)
                          : t('dash.never')}
                      </dd>
                      <dt className="text-muted-foreground">{t('dash.pending')}</dt>
                      <dd className="text-right font-semibold tabular-nums">
                        {f.pending_on_devices}
                      </dd>
                      {f.oldest_pending_at && (
                        <>
                          <dt className="text-muted-foreground">{t('dash.oldestPending')}</dt>
                          <dd className="text-right font-semibold">
                            {formatRelative(Date.parse(f.oldest_pending_at), locale)}
                          </dd>
                        </>
                      )}
                      <dt className="text-muted-foreground">{t('dash.today')}</dt>
                      <dd className="text-right font-semibold tabular-nums">{f.submissions_24h}</dd>
                      <dt className="text-muted-foreground">{t('dash.successRate')}</dt>
                      <dd className="text-right font-semibold tabular-nums">
                        {pct(f.first_attempt_success_7d)}
                      </dd>
                      <dt className="text-muted-foreground">{t('dash.devices')}</dt>
                      <dd className="text-right font-semibold tabular-nums">{f.devices_active}</dd>
                    </dl>
                  </article>
                </m.li>
              );
            })}
          </AnimatePresence>
        </ul>
      </section>
    </div>
  );
}
