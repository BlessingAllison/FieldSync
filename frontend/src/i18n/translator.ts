/**
 * Typed, dependency-free translator (~1 KB). Keys are checked against en.json at compile
 * time; interpolation uses {name}; plurals use `<key>.<Intl.PluralRules category>` with
 * `.other` as the fallback.
 */
import type en from './locales/en.json';

export type Messages = typeof en;
export type MessageKey = keyof Messages;
export type Locale = 'en' | 'kpe';

/** Base keys that have plural variants: "x.one" + "x.other" → "x". */
type PluralBase<K> = K extends `${infer Base}.other` ? Base : never;
export type PluralKey = PluralBase<MessageKey>;

export type Params = Record<string, string | number>;

export interface Translator {
  locale: Locale;
  t: (key: MessageKey, params?: Params) => string;
  plural: (base: PluralKey, count: number, params?: Params) => string;
}

const PLACEHOLDER_RE = /\{(\w+)\}/g;

function interpolate(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(PLACEHOLDER_RE, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

/** Intl locale used for plural rules and number/date formatting. */
const INTL_LOCALE: Record<Locale, string> = {
  en: 'en',
  // Pseudo-locale: format like English until real Kpelle rules are reviewed.
  kpe: 'en',
};

export function createTranslator(
  locale: Locale,
  messages: Partial<Record<string, string>>,
  fallback: Messages,
): Translator {
  const lookup = (key: string): string =>
    messages[key] ?? (fallback as Record<string, string>)[key] ?? key;
  const rules = new Intl.PluralRules(INTL_LOCALE[locale]);
  return {
    locale,
    t: (key, params) => interpolate(lookup(key), params),
    plural: (base, count, params) => {
      const category = rules.select(count);
      const specific = `${base}.${category}`;
      const key = specific in fallback || specific in messages ? specific : `${base}.other`;
      return interpolate(lookup(key), { count, ...params });
    },
  };
}

export function formatBytes(bytes: number, locale: Locale): string {
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return new Intl.NumberFormat(INTL_LOCALE[locale], {
    style: 'unit',
    unit: units[unit],
    unitDisplay: 'short',
    maximumFractionDigits: value < 10 && unit > 0 ? 1 : 0,
  }).format(value);
}
