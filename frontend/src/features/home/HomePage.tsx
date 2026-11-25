import { m } from 'framer-motion';
import { Building2, ChevronRight, FilePlus2, FileText, WifiOff } from 'lucide-react';
import { Link } from 'react-router-dom';

import { getVault } from '@/app/runtime';
import type { TemplateDefinition } from '@/core/validation/types';
import { SyncBanner } from '@/features/sync/SyncBanner';
import { useT } from '@/i18n';
import { formatRelative } from '@/lib/format';
import { tx } from '@/lib/template-text';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { useVaultQuery } from '@/lib/useVaultQuery';
import { useApp } from '@/stores/app';
import { EmptyState, PhoneFormsArt } from '@/ui/illustrations';
import { HomeSkeleton } from '@/ui/skeleton';
import { type ChipState, SyncChip } from '@/ui/sync-chip';

export function HomePage() {
  const { t, locale } = useT();
  const profile = useApp((s) => s.profile);
  // One banner (one live region): in the main column on phones, in the aside on desktop.
  const wide = useMediaQuery('(min-width: 1024px)');
  const { data, loading } = useVaultQuery(async () => {
    const vault = getVault();
    const [drafts, receipts, facilities, templates, outbox] = await Promise.all([
      vault.listDrafts(),
      vault.listReceipts(),
      vault.listFacilities(),
      vault.listTemplates(),
      vault.listOutbox(),
    ]);
    const titles = new Map(
      templates.map((tpl) => [
        `${tpl.code}:${tpl.version}`,
        (tpl.definition as TemplateDefinition).title,
      ]),
    );
    const states = new Map(outbox.map((i) => [i.clientUuid, i.state]));
    const recent = await Promise.all(
      receipts
        .slice(-6)
        .reverse()
        .map(async (r) => ({
          receipt: r,
          summary: await vault.receiptSummary(r),
          state: (states.get(r.clientUuid) ?? 'SYNCED') as ChipState,
        })),
    );
    return { drafts: drafts.reverse(), recent, facilities, titles };
  });

  if (loading || !data) return <HomeSkeleton />;

  const titleOf = (code: string, version: number) => {
    const title = data.titles.get(`${code}:${version}`);
    return title ? tx(title, locale) : code;
  };
  const today = new Intl.DateTimeFormat('en', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date());
  const facility = data.facilities[0];

  return (
    <div className="mx-auto grid max-w-6xl gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="flex min-w-0 flex-col gap-5">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {today}
          </p>
          <h1 className="text-2xl font-bold tracking-tight lg:text-3xl">
            {t('home.greeting', { name: profile?.display_name ?? '' })}
          </h1>
          {facility && <p className="text-muted-foreground">{facility.name}</p>}
        </div>

        <m.div whileTap={{ scale: 0.98 }}>
          <Link
            to="/new"
            className="flex min-h-20 items-center justify-center gap-3 rounded-lg bg-primary px-6 text-xl font-bold text-primary-foreground shadow-md transition-colors hover:bg-primary/90"
          >
            <FilePlus2 aria-hidden className="size-7" />
            {t('home.newForm')}
          </Link>
        </m.div>

        {!wide && <SyncBanner />}

        {data.drafts.length > 0 && (
          <section aria-labelledby="drafts-title" className="flex flex-col gap-2">
            <h2 id="drafts-title" className="text-lg font-bold">
              {t('home.drafts')}
            </h2>
            {data.drafts.map((draft) => (
              <Link
                key={draft.clientUuid}
                to={`/form/${draft.clientUuid}`}
                className="flex min-h-tap items-center gap-3 rounded-lg border border-l-4 border-l-status-pending bg-card p-4 hover:bg-accent"
              >
                <FileText aria-hidden className="size-6 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">
                    {titleOf(draft.templateCode, draft.templateVersion)}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {t('home.draftUpdated', { time: formatRelative(draft.updatedAt, locale) })}
                  </span>
                </span>
                <span className="font-semibold text-primary">{t('home.continue')}</span>
                <ChevronRight aria-hidden className="size-5" />
              </Link>
            ))}
          </section>
        )}

        <section aria-labelledby="recent-title" className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h2 id="recent-title" className="text-lg font-bold">
              {t('home.recent')}
            </h2>
            {data.recent.length > 0 && (
              <Link
                to="/sync"
                className="flex min-h-10 items-center font-semibold text-primary underline-offset-4 hover:underline"
              >
                {t('home.viewAll')}
              </Link>
            )}
          </div>
          {data.recent.length ? (
            <ul className="flex flex-col gap-2">
              {data.recent.map(({ receipt, summary, state }) => (
                <li key={receipt.clientUuid}>
                  <Link
                    to={`/sync/${receipt.clientUuid}`}
                    className="flex min-h-tap items-center gap-3 rounded-lg border bg-card p-4 hover:bg-accent"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold">
                        {summary.patientLabel ??
                          titleOf(receipt.templateCode, receipt.templateVersion)}
                      </span>
                      <span className="block truncate text-sm text-muted-foreground">
                        {titleOf(receipt.templateCode, receipt.templateVersion)} ·{' '}
                        {formatRelative(receipt.capturedAt, locale)}
                      </span>
                    </span>
                    <SyncChip state={state} label={t(`state.${state}`)} />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              Art={PhoneFormsArt}
              title={t('home.empty.title')}
              body={t('home.empty.body')}
            />
          )}
        </section>
      </div>

      <aside className="flex flex-col gap-4" aria-label={t('syncPage.title')}>
        {wide && <SyncBanner />}
        {data.facilities.length > 0 && (
          <section aria-labelledby="facility-title" className="rounded-lg border bg-card p-4">
            <h2
              id="facility-title"
              className="mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground"
            >
              <Building2 aria-hidden className="size-4" />
              {t('home.myFacility')}
            </h2>
            {data.facilities.map((f) => (
              <p key={f.id} className="font-semibold">
                {f.name}{' '}
                <span className="whitespace-nowrap text-sm font-normal text-muted-foreground">
                  ({f.code})
                </span>
              </p>
            ))}
          </section>
        )}
        <Link
          to="/help#help-offline"
          className="flex min-h-tap items-center gap-3 rounded-lg border bg-card p-4 font-semibold hover:bg-accent"
        >
          <WifiOff aria-hidden className="size-5 text-primary" />
          <span className="flex-1">{t('home.offlineHelp')}</span>
          <ChevronRight aria-hidden className="size-5" />
        </Link>
      </aside>
    </div>
  );
}
