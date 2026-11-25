import type { Locale } from '@/i18n';

const intlLocale = (_locale: Locale) => 'en';

export function formatRelative(ms: number, locale: Locale, now = Date.now()): string {
  const diff = ms - now;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(intlLocale(locale), { numeric: 'auto' });
  if (abs < 45_000) return rtf.format(Math.round(diff / 1000), 'second');
  if (abs < 45 * 60_000) return rtf.format(Math.round(diff / 60_000), 'minute');
  if (abs < 22 * 3_600_000) return rtf.format(Math.round(diff / 3_600_000), 'hour');
  return rtf.format(Math.round(diff / 86_400_000), 'day');
}

export function formatDateTime(ms: number, locale: Locale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(ms);
}

/** Short code a CHW can read aloud to a supervisor (no PHI: derived from a random id). */
export const supportCode = (id: string | null | undefined): string =>
  id ? `FS-${id.replace(/-/g, '').slice(-6).toUpperCase()}` : '—';
