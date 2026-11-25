import { create } from 'zustand';

import en from './locales/en.json';
import type { Locale, Translator } from './translator';
import { createTranslator } from './translator';

export type { Locale, MessageKey, PluralKey, Translator } from './translator';
export { formatBytes } from './translator';

export const LOCALES: readonly Locale[] = ['en', 'kpe'];

/** Non-English catalogues are separate lazy chunks (precached by the SW like any asset). */
const loaders: Record<Exclude<Locale, 'en'>, () => Promise<{ default: Record<string, string> }>> = {
  kpe: () => import('./locales/kpe.json'),
};

interface I18nState {
  translator: Translator;
  setLocale: (locale: Locale) => Promise<void>;
}

export const useI18n = create<I18nState>((set) => ({
  translator: createTranslator('en', en, en),
  setLocale: async (locale) => {
    const messages = locale === 'en' ? en : (await loaders[locale]()).default;
    document.documentElement.lang = locale;
    set({ translator: createTranslator(locale, messages, en) });
  },
}));

/** `const { t, plural } = useT();` */
export const useT = (): Translator => useI18n((state) => state.translator);
