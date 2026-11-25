/**
 * Header network meter: signal bars + a word, and a details dialog with the measurements
 * and plain-language advice. Replaces the old Online/Offline text chip.
 */
import { RefreshCw, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { LINK_LEVEL, type LinkStatus } from '@/core/net/link-quality';
import { type MessageKey, useT } from '@/i18n';
import { formatRelative } from '@/lib/format';
import { checkLinkNow, useLink } from '@/stores/link';
import { Button } from '@/ui/button';
import { SignalBars } from '@/ui/signal-meter';

const statusKey = (status: LinkStatus) => `link.status.${status}` as MessageKey;

export function LinkIndicator() {
  const { t } = useT();
  const status = useLink((s) => s.status);
  const [open, setOpen] = useState(false);
  const label = t(statusKey(status));
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t('link.aria', { status: label })}
        aria-haspopup="dialog"
        data-link-status={status}
        className="flex min-h-10 items-center gap-1.5 rounded-full px-2 text-sm font-semibold hover:bg-primary-foreground/15"
      >
        <SignalBars level={LINK_LEVEL[status]} />
        <span aria-hidden>{label}</span>
      </button>
      <LinkDetails open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function LinkDetails({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, locale } = useT();
  const ref = useRef<HTMLDialogElement>(null);
  const { status, serverRttMs, lastSampleAt, netInfo, checking } = useLink();
  // Re-render every 10 s so "last measured" stays truthful while the dialog is open.
  const [, setTick] = useState(0);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
    if (!open) return;
    const timer = setInterval(() => setTick((n) => n + 1), 10_000);
    return () => clearInterval(timer);
  }, [open]);

  const rows: Array<[MessageKey, string, boolean?]> = [
    [
      'link.server',
      serverRttMs !== null ? t('link.serverValue', { ms: serverRttMs }) : t('link.notMeasured'),
    ],
    [
      'link.lastChecked',
      lastSampleAt !== null ? formatRelative(lastSampleAt, locale) : t('link.notMeasured'),
    ],
    [
      'link.type',
      netInfo?.effectiveType ? netInfo.effectiveType.toUpperCase() : t('link.unknown'),
      Boolean(netInfo?.effectiveType), // a measured value ("4G"), not UI copy
    ],
    [
      'link.speed',
      netInfo?.downlinkMbps !== undefined
        ? t('link.speedValue', { mbps: netInfo.downlinkMbps.toFixed(1) })
        : t('link.unknown'),
    ],
  ];
  if (netInfo?.saveData) rows.push(['link.dataSaver', t('link.dataSaverOn')]);

  return (
    <dialog
      ref={ref}
      aria-labelledby="link-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="w-[min(92vw,26rem)] rounded-lg border bg-card p-0 text-card-foreground shadow-xl backdrop:bg-black/60"
    >
      {open && (
        <div className="flex flex-col gap-4 p-5">
          <div className="flex items-start justify-between gap-3">
            <h2 id="link-title" className="text-xl font-bold">
              {t('link.title')}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('common.close')}
              className="-m-2 flex size-11 items-center justify-center rounded-full hover:bg-accent"
            >
              <X aria-hidden className="size-5" />
            </button>
          </div>
          <div className="flex items-center gap-3" role="status" aria-live="polite">
            <SignalBars level={LINK_LEVEL[status]} tone="status" className="size-10" />
            <p className="text-2xl font-bold">{t(statusKey(status))}</p>
          </div>
          <p>{t(`link.advice.${status}` as MessageKey)}</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            {rows.map(([key, value, data]) => (
              <div key={key} className="contents">
                <dt className="text-muted-foreground">{t(key)}</dt>
                <dd className="font-medium" translate={data ? 'no' : undefined}>
                  {value}
                </dd>
              </div>
            ))}
          </dl>
          <Button variant="outline" disabled={checking} onClick={() => void checkLinkNow()}>
            <RefreshCw
              aria-hidden
              className={checking ? 'animate-spin motion-reduce:animate-none' : ''}
            />
            {checking ? t('link.checking') : t('link.checkNow')}
          </Button>
        </div>
      )}
    </dialog>
  );
}
