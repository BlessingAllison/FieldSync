import { m } from 'framer-motion';
import { FilePlus2, Home, Smartphone } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';

import { getVault } from '@/app/runtime';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { supportCode } from '@/lib/format';
import { useVaultQuery } from '@/lib/useVaultQuery';
import { Button } from '@/ui/button';
import { SyncChip } from '@/ui/sync-chip';

/** Drawn check mark: the path animates in once the server has the form. */
function SentCheck() {
  // pathLength={1} normalises the stroke length so a 1 → 0 dash offset "draws" it.
  const draw = { strokeDasharray: 1 };
  return (
    <svg viewBox="0 0 64 64" className="size-16" aria-hidden>
      <m.circle
        cx="32"
        cy="32"
        r="29"
        fill="none"
        stroke="currentColor"
        strokeWidth="4"
        pathLength={1}
        style={draw}
        initial={{ strokeDashoffset: 1 }}
        animate={{ strokeDashoffset: 0 }}
        transition={{ duration: 0.45, ease: 'easeOut' }}
      />
      <m.path
        d="M19 33l9 9 17-19"
        fill="none"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
        pathLength={1}
        style={draw}
        initial={{ strokeDashoffset: 1 }}
        animate={{ strokeDashoffset: 0 }}
        transition={{ duration: 0.3, delay: 0.35, ease: 'easeOut' }}
      />
    </svg>
  );
}

/** "Saved offline — will sync" made explicit (ADD §3.1), updating live when it is sent. */
export function SavedPage() {
  const { clientUuid = '' } = useParams();
  const { t } = useT();
  const { data } = useVaultQuery(async () => {
    const vault = getVault();
    const [item, receipt] = await Promise.all([
      vault.getOutboxItem(clientUuid),
      vault.getReceipt(clientUuid),
    ]);
    return { state: item?.state ?? (receipt?.status === 'synced' ? 'SYNCED' : 'PENDING') } as const;
  }, [clientUuid]);
  const sent = data?.state === 'SYNCED';

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-6 pt-6 text-center">
      <m.div
        initial={{ scale: 0.6, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 260, damping: 18 }}
        className={cn(
          'rounded-full p-6',
          sent ? 'bg-status-sent-bg text-status-sent' : 'bg-secondary text-secondary-foreground',
        )}
      >
        {sent ? <SentCheck /> : <Smartphone aria-hidden className="size-16" />}
      </m.div>
      <div role="status" aria-live="polite" className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight">
          {sent ? t('saved.sentTitle') : t('saved.title')}
        </h1>
        <p className="text-lg text-muted-foreground">
          {sent ? t('saved.sentBody') : t('saved.body')}
        </p>
      </div>
      {data && <SyncChip state={data.state} label={t(`state.${data.state}`)} />}
      <div className="flex flex-col items-center gap-1">
        <p className="rounded-lg border bg-card px-4 py-2 font-mono text-lg">
          {t('saved.receipt', { code: supportCode(clientUuid) })}
        </p>
        <p className="text-sm text-muted-foreground">{t('saved.receiptHelp')}</p>
      </div>
      <div className="flex w-full flex-col gap-3 sm:flex-row">
        <Button asChild size="lg" className="flex-1">
          <Link to="/new">
            <FilePlus2 aria-hidden />
            {t('saved.another')}
          </Link>
        </Button>
        <Button asChild size="lg" variant="outline" className="flex-1">
          <Link to="/">
            <Home aria-hidden />
            {t('saved.home')}
          </Link>
        </Button>
      </div>
    </div>
  );
}
