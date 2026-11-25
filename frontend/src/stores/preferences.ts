import { create } from 'zustand';

import {
  type Preferences,
  type ThemePreference,
  readPreferences,
  writePreference,
} from '@/core/db/schema';
import { useI18n } from '@/i18n';

interface PreferencesState {
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => Promise<void>;
  setLocale: (locale: Preferences['locale']) => Promise<void>;
}

/** Browser chrome colour per theme (status bar on Android). */
const THEME_COLOR: Record<Exclude<ThemePreference, 'system'>, string> = {
  light: '#0b4f55',
  dark: '#0d1416',
  outdoor: '#002b2f',
};

export function applyTheme(theme: ThemePreference): void {
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
  const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
  metas.forEach((meta) => {
    if (theme === 'system') {
      meta.content = meta.media.includes('dark') ? THEME_COLOR.dark : THEME_COLOR.light;
    } else {
      meta.content = THEME_COLOR[theme];
    }
  });
}

export const usePreferences = create<PreferencesState>((set) => ({
  theme: 'system',
  setTheme: async (theme) => {
    applyTheme(theme);
    set({ theme });
    await writePreference('theme', theme);
  },
  setLocale: async (locale) => {
    // Persist first: if the app is closed while the catalogue chunk loads, the choice survives.
    await writePreference('locale', locale);
    await useI18n.getState().setLocale(locale);
  },
}));

/** Before first render: apply stored theme and language (no flash of the wrong theme). */
export async function loadPreferences(): Promise<void> {
  try {
    const prefs = await readPreferences();
    applyTheme(prefs.theme);
    usePreferences.setState({ theme: prefs.theme });
    if (prefs.locale !== 'en') await useI18n.getState().setLocale(prefs.locale);
  } catch {
    // Private mode / blocked storage: defaults are fine.
  }
}
