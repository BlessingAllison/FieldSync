import { Languages } from 'lucide-react';

import { LOCALES, type Locale, type MessageKey, useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { usePreferences } from '@/stores/preferences';

/** Compact language switch (persisted per device; usable before sign-in). */
export function LanguagePicker({ className }: { className?: string }) {
  const { t, locale } = useT();
  const setLocale = usePreferences((s) => s.setLocale);
  return (
    <fieldset className={cn('flex flex-wrap items-center gap-2', className)}>
      <legend className="sr-only">{t('login.language')}</legend>
      <Languages aria-hidden className="size-5 text-muted-foreground" />
      {LOCALES.map((l: Locale) => (
        <label
          key={l}
          className={cn(
            'flex min-h-tap cursor-pointer items-center rounded-full border-2 px-4 text-sm font-semibold',
            locale === l
              ? 'border-primary bg-secondary text-secondary-foreground'
              : 'border-input bg-card hover:bg-accent',
          )}
        >
          <input
            type="radio"
            name="language"
            value={l}
            checked={locale === l}
            onChange={() => void setLocale(l)}
            className="sr-only"
          />
          {t(`language.${l}` as MessageKey)}
        </label>
      ))}
    </fieldset>
  );
}
