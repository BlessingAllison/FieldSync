import { HardDriveDownload } from 'lucide-react';

import { type MessageKey, useT } from '@/i18n';
import {
  ConflictArt,
  InstallArt,
  LabelsArt,
  LockedPhoneArt,
  OfflineArt,
  PhoneFormsArt,
  SharedPhoneArt,
} from '@/ui/illustrations';

const SECTIONS: Array<{
  id: string;
  Art: typeof PhoneFormsArt;
  title: MessageKey;
  body: MessageKey;
}> = [
  { id: 'saving', Art: PhoneFormsArt, title: 'help.saving.title', body: 'help.saving.body' },
  { id: 'offline', Art: OfflineArt, title: 'help.offline.title', body: 'help.offline.body' },
  { id: 'labels', Art: LabelsArt, title: 'help.colours.title', body: 'help.colours.body' },
  { id: 'problems', Art: ConflictArt, title: 'help.problems.title', body: 'help.problems.body' },
  { id: 'install', Art: InstallArt, title: 'help.install.title', body: 'help.install.body' },
  { id: 'lost', Art: LockedPhoneArt, title: 'help.lost.title', body: 'help.lost.body' },
  { id: 'shared', Art: SharedPhoneArt, title: 'help.shared.title', body: 'help.shared.body' },
];

export default function HelpPage() {
  const { t } = useT();
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight lg:text-3xl">{t('help.title')}</h1>
        <p className="mt-1 text-lg text-muted-foreground">{t('help.intro')}</p>
      </div>
      <nav aria-label={t('help.title')} className="-mx-4 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
        <ul className="flex gap-2 sm:flex-wrap">
          {SECTIONS.map((s) => (
            <li key={s.id} className="shrink-0">
              <a
                href={`#help-${s.id}`}
                className="inline-flex min-h-tap items-center whitespace-nowrap rounded-full border bg-card px-4 text-sm font-semibold hover:bg-accent"
              >
                {t(s.title)}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      {SECTIONS.map(({ id, Art, title, body }) => (
        <section
          key={id}
          id={`help-${id}`}
          aria-labelledby={`help-${id}-title`}
          className="scroll-mt-20 rounded-lg border bg-card p-5 sm:flex sm:items-center sm:gap-6"
        >
          <Art className="mx-auto mb-3 w-36 shrink-0 sm:mx-0 sm:mb-0" />
          <div className="min-w-0">
            <h2 id={`help-${id}-title`} className="mb-1 text-xl font-bold">
              {t(title)}
            </h2>
            <p className="text-lg leading-relaxed">{t(body)}</p>
          </div>
        </section>
      ))}
      <p className="flex items-start gap-2 rounded-lg border border-dashed p-4 text-muted-foreground">
        <HardDriveDownload aria-hidden className="mt-0.5 size-5 shrink-0" />
        {t('help.support')}
      </p>
    </div>
  );
}
