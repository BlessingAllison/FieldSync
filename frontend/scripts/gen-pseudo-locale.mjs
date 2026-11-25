// Generates the Kpelle placeholder locale (kpe.json) from en.json as a *pseudo-locale*.
//
// No machine-generated Kpelle is shipped (ADD §16.6). Every string is rendered as
// "⟦kpe⟧ <English> ··" with ~30% padding so that:
//   - untranslated strings are unmistakable on screen, and
//   - layouts are exercised for the text expansion real translations will need.
// {placeholders} are preserved verbatim. A qualified translator replaces this file.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, '../src/i18n/locales');

export function pseudo(value) {
  const padding = '·'.repeat(Math.max(2, Math.round(value.length * 0.3)));
  return `⟦kpe⟧ ${value} ${padding}`;
}

export function buildPseudoLocale(en) {
  return Object.fromEntries(Object.entries(en).map(([key, value]) => [key, pseudo(value)]));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const en = JSON.parse(readFileSync(path.join(dir, 'en.json'), 'utf8'));
  const out = {
    $comment:
      'PLACEHOLDER — pseudo-localised from en.json by scripts/gen-pseudo-locale.mjs. This is NOT Kpelle. Replace with translations by a qualified Kpelle translator, reviewed with community health workers.',
    ...buildPseudoLocale(en),
  };
  writeFileSync(path.join(dir, 'kpe.json'), JSON.stringify(out, null, 2) + '\n');
  console.warn(`wrote kpe.json (${Object.keys(en).length} strings)`);
}
