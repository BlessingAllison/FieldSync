import { AnimatePresence, m } from 'framer-motion';
import { Cloud, FlaskConical, Send, Smartphone, UserCog } from 'lucide-react';
import { useState } from 'react';

import {
  addSyntheticForms,
  getVault,
  setSimProfile,
  simulateSupervisorEdit,
  syncNow,
} from '@/app/runtime';
import { NETWORK_PROFILES, type NetworkProfile } from '@/core/api/conditions';
import { type MessageKey, useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { useSim, useSync } from '@/stores/sync';
import { Button } from '@/ui/button';
import { type ChipState, SyncChip } from '@/ui/sync-chip';

import { useQueue } from '../sync/useQueue';

const LANE_LIMIT = 24;

export default function SimulatorPage() {
  const { t } = useT();
  const { profile, stats, log } = useSim();
  const breaker = useSync((s) => s.breaker);
  const { data } = useQueue();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const phone = [
    ...(data?.action ?? []),
    ...(data?.waiting ?? []).filter((r) => r.item.state !== 'SYNCING'),
  ];
  const sending = (data?.waiting ?? []).filter((r) => r.item.state === 'SYNCING');
  const server = data?.sent ?? [];

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setNote(null);
    try {
      await fn();
    } catch {
      // e.g. a chunk that could not download offline before the first install finished.
      setNote(t('sim.failed'));
    } finally {
      setBusy(false);
    }
  };

  const lane = (
    title: string,
    Icon: typeof Smartphone,
    rows: Array<{ key: string; label: string; state: ChipState; attempts?: number }>,
  ) => (
    <section
      aria-label={title}
      className="flex min-h-48 flex-col gap-2 rounded-lg border bg-muted/40 p-3"
    >
      <h2 className="flex items-center gap-2 font-bold">
        <Icon aria-hidden className="size-5" />
        {title}
        <span className="ml-auto rounded-full bg-card px-2 text-sm tabular-nums">
          {rows.length}
        </span>
      </h2>
      <ul className="flex flex-col gap-1.5">
        <AnimatePresence initial={false}>
          {rows.slice(0, LANE_LIMIT).map((row) => (
            <m.li
              key={row.key}
              layoutId={row.key}
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.2 }}
              className="flex items-center justify-between gap-2 rounded-md border bg-card px-2 py-1.5 text-sm"
            >
              <span className="truncate font-mono">{row.label}</span>
              <span className="flex items-center gap-1">
                {row.attempts ? (
                  <span className="text-xs text-muted-foreground">×{row.attempts}</span>
                ) : null}
                <SyncChip
                  state={row.state}
                  label={t(`state.${row.state}`)}
                  className="px-2 py-0.5 text-xs"
                />
              </span>
            </m.li>
          ))}
        </AnimatePresence>
      </ul>
      {rows.length > LANE_LIMIT && (
        <p className="text-sm text-muted-foreground">
          {t('sim.more', { count: rows.length - LANE_LIMIT })}
        </p>
      )}
    </section>
  );

  const statTiles: Array<{ label: MessageKey; value: number; tone?: string }> = [
    { label: 'sim.stat.requests', value: stats.requests },
    { label: 'sim.stat.sent', value: stats.sent, tone: 'text-status-sent' },
    { label: 'sim.stat.duplicates', value: stats.duplicatesPrevented, tone: 'text-status-sent' },
    { label: 'sim.stat.retries', value: stats.retries, tone: 'text-status-pending' },
    { label: 'sim.stat.acksLost', value: stats.acksLost, tone: 'text-status-failed' },
    { label: 'sim.stat.conflicts', value: stats.conflicts, tone: 'text-status-conflict' },
  ];

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5">
      <div className="flex items-start gap-3">
        <FlaskConical aria-hidden className="mt-1 size-7 text-primary" />
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('sim.title')}</h1>
          <p className="text-muted-foreground">{t('sim.intro')}</p>
          <p className="text-sm text-muted-foreground">{t('sim.trainingNote')}</p>
        </div>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 font-semibold">{t('sim.network')}</legend>
        <div role="radiogroup" className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {NETWORK_PROFILES.map((p: NetworkProfile) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={profile === p}
              onClick={() => void setSimProfile(p)}
              className={cn(
                'min-h-tap rounded-lg border-2 px-3 font-semibold',
                profile === p
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-input bg-card hover:bg-accent',
              )}
            >
              {t(`sim.profile.${p}` as MessageKey)}
            </button>
          ))}
        </div>
        <p role="status" aria-live="polite" className="text-sm font-medium text-muted-foreground">
          {t('sim.connection', { state: t(`sim.breaker.${breaker}`) })}
        </p>
      </fieldset>

      <div className="flex flex-wrap gap-2">
        {[5, 50, 500].map((n) => (
          <Button
            key={n}
            variant="secondary"
            disabled={busy}
            onClick={() => void act(() => addSyntheticForms(n))}
          >
            {t('sim.addForms', { count: n })}
          </Button>
        ))}
        <Button variant="outline" disabled={busy} onClick={() => void act(() => syncNow())}>
          <Send aria-hidden />
          {t('sync.syncNow')}
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              const synced = (await getVault().listReceipts())
                .filter((r) => r.status === 'synced')
                .at(-1);
              if (!synced) {
                setNote(t('sim.noSentForm'));
                return;
              }
              await simulateSupervisorEdit(synced.clientUuid);
            })
          }
        >
          <UserCog aria-hidden />
          {t('sim.supervisorEdit')}
        </Button>
      </div>
      {note && (
        <p role="status" className="text-muted-foreground">
          {note}
        </p>
      )}

      {/* <dl> may only contain dt/dd, or one wrapping <div> per group. */}
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-6">
        {statTiles.map((s) => (
          <div
            key={s.label}
            className="rounded-lg border bg-card p-3 text-card-foreground shadow-sm"
          >
            <dt className="text-sm text-muted-foreground">{t(s.label)}</dt>
            <dd className={cn('text-2xl font-bold tabular-nums', s.tone)}>{s.value}</dd>
          </div>
        ))}
      </dl>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {lane(
          t('sim.lane.phone'),
          Smartphone,
          phone.map((r) => ({
            key: r.item.clientUuid,
            label: r.summary.patientLabel ?? r.item.clientUuid.slice(-8),
            state: r.item.state,
            attempts: r.item.attempts,
          })),
        )}
        {lane(
          t('sim.lane.sending'),
          Send,
          sending.map((r) => ({
            key: r.item.clientUuid,
            label: r.summary.patientLabel ?? r.item.clientUuid.slice(-8),
            state: r.item.state,
            attempts: r.item.attempts,
          })),
        )}
        {lane(
          t('sim.lane.server'),
          Cloud,
          server.map((r) => ({
            key: r.receipt.clientUuid,
            label: r.summary.patientLabel ?? r.receipt.clientUuid.slice(-8),
            state: 'SYNCED',
          })),
        )}
      </div>

      <section aria-labelledby="sim-log" className="flex flex-col gap-2">
        <h2 id="sim-log" className="text-lg font-bold">
          {t('sim.log')}
        </h2>
        <ol
          className="flex max-h-80 flex-col gap-1 overflow-y-auto rounded-lg border bg-card p-3 font-mono text-sm"
          aria-live="off"
        >
          {log.map((entry) => (
            <li
              key={entry.id}
              className={cn(
                entry.tone === 'good' && 'text-status-sent',
                entry.tone === 'warn' && 'text-status-pending',
                entry.tone === 'bad' && 'text-status-failed',
              )}
            >
              <time className="text-muted-foreground">
                {new Date(entry.at).toLocaleTimeString()}
              </time>{' '}
              {entry.text}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
