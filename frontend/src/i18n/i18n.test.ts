import { describe, expect, it } from 'vitest';

import { buildPseudoLocale } from '../../scripts/gen-pseudo-locale.mjs';
import en from './locales/en.json';
import kpe from './locales/kpe.json';
import { createTranslator, formatBytes } from './translator';

describe('translator', () => {
  const tr = createTranslator('en', en, en);

  it('interpolates named parameters and leaves unknown ones intact', () => {
    expect(tr.t('deviceCheck.item.storage.ok', { used: '1 MB', quota: '2 GB' })).toBe(
      '1 MB used of 2 GB available to FieldSync.',
    );
    expect(tr.t('deviceCheck.item.storage.ok')).toContain('{used}');
  });

  it('selects plural categories with an .other fallback', () => {
    expect(tr.plural('deviceCheck.summary.attention', 1)).toBe('1 item needs attention.');
    expect(tr.plural('deviceCheck.summary.attention', 3)).toBe('3 items need attention.');
    expect(tr.plural('deviceCheck.summary.attention', 0)).toBe('0 items need attention.');
  });

  it('falls back to English for keys missing in a locale', () => {
    const partial = createTranslator('kpe', { 'app.name': 'X' }, en);
    expect(partial.t('app.name')).toBe('X');
    expect(partial.t('network.online')).toBe('Online');
  });

  it('formats byte sizes', () => {
    expect(formatBytes(512, 'en')).toBe('512 byte');
    expect(formatBytes(1536 * 1024, 'en')).toBe('1.5 MB');
  });
});

describe('kpe placeholder locale', () => {
  const { $comment, ...strings } = kpe as Record<string, string>;

  it('is the committed output of the generator (run npm run gen:i18n)', () => {
    expect(strings).toEqual(buildPseudoLocale(en));
  });

  it('is clearly marked as a placeholder, not a translation', () => {
    expect($comment).toMatch(/PLACEHOLDER/);
    expect($comment).toMatch(/NOT Kpelle/);
    expect(Object.values(strings).every((s) => s.startsWith('⟦kpe⟧ '))).toBe(true);
  });

  it('preserves every {placeholder}', () => {
    for (const [key, value] of Object.entries(en)) {
      const placeholders = value.match(/\{\w+\}/g) ?? [];
      for (const p of placeholders) expect(strings[key]).toContain(p);
    }
  });
});
