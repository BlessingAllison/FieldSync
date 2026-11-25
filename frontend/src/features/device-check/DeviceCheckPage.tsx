import { m } from 'framer-motion';
import {
  Cloud,
  Database,
  HardDrive,
  Lock,
  type LucideIcon,
  RefreshCw,
  Send,
  ShieldCheck,
  WifiOff,
} from 'lucide-react';

import type { MessageKey } from '@/i18n';
import { formatBytes, useT } from '@/i18n';
import { Button } from '@/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/card';
import { StatusBadge } from '@/ui/status-badge';

import { CHECK_ORDER, type CheckId, useDeviceCheck } from './useDeviceCheck';

const ICONS: Record<CheckId, LucideIcon> = {
  serviceWorker: WifiOff,
  indexedDb: Database,
  crypto: Lock,
  persistence: ShieldCheck,
  storage: HardDrive,
  backgroundSync: Send,
  server: Cloud,
};

export function DeviceCheckPage() {
  const { t, plural, locale } = useT();
  const { results, storage, rerun, protectStorage } = useDeviceCheck();

  const done = CHECK_ORDER.every((id) => results[id] !== 'checking');
  const attention = CHECK_ORDER.filter(
    (id) => results[id] === 'warn' || results[id] === 'fail',
  ).length;
  const storageParams = storage
    ? { used: formatBytes(storage.usage, locale), quota: formatBytes(storage.quota, locale) }
    : undefined;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t('deviceCheck.title')}</h1>
        <p className="mt-1 text-muted-foreground">{t('deviceCheck.intro')}</p>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-4 space-y-0">
          <p role="status" aria-live="polite" className="text-lg font-semibold">
            {!done
              ? t('deviceCheck.status.checking')
              : attention === 0
                ? t('deviceCheck.summary.ready')
                : plural('deviceCheck.summary.attention', attention)}
          </p>
          <Button variant="outline" onClick={() => void rerun()} disabled={!done}>
            <RefreshCw aria-hidden />
            {t('deviceCheck.rerun')}
          </Button>
        </CardHeader>
      </Card>

      <ul className="flex flex-col gap-3" aria-label={t('deviceCheck.title')}>
        {CHECK_ORDER.map((id, index) => {
          const status = results[id];
          const Icon = ICONS[id];
          const detailKey = (
            status === 'checking' ? null : `deviceCheck.item.${id}.${status}`
          ) as MessageKey | null;
          return (
            <m.li
              key={id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.18, delay: index * 0.03 }}
            >
              <Card data-check={id} data-status={status}>
                <CardContent className="flex items-start gap-4 p-4">
                  <span className="mt-0.5 rounded-md bg-secondary p-2.5 text-secondary-foreground">
                    <Icon aria-hidden className="size-6" />
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <CardTitle className="text-lg">
                        {t(`deviceCheck.item.${id}` as MessageKey)}
                      </CardTitle>
                      <StatusBadge tone={status} label={t(`deviceCheck.status.${status}`)} />
                    </div>
                    {detailKey && (
                      <CardDescription>
                        {t(detailKey, id === 'storage' ? storageParams : undefined)}
                      </CardDescription>
                    )}
                    {id === 'persistence' && status === 'warn' && (
                      <Button
                        variant="secondary"
                        className="self-start"
                        onClick={() => void protectStorage()}
                      >
                        <ShieldCheck aria-hidden />
                        {t('deviceCheck.item.persistence.request')}
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            </m.li>
          );
        })}
      </ul>
    </div>
  );
}
