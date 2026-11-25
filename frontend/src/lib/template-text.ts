import type { Locale, Translator } from '@/i18n';
import type { FieldSpec, I18nText, TemplateDefinition } from '@/core/validation/types';

/** Same pseudo-localisation as scripts/gen-pseudo-locale.mjs (templates ship English only). */
export const pseudo = (value: string): string =>
  `⟦kpe⟧ ${value} ${'·'.repeat(Math.max(2, Math.round(value.length * 0.3)))}`;

export function tx(text: I18nText | undefined, locale: Locale): string {
  if (!text) return '';
  if (locale === 'kpe') return text.kpe ?? pseudo(text.en);
  return text.en;
}

/** Human message for a validation code (codes come from the contract; values never do). */
export function ruleMessage(
  translator: Translator,
  code: string,
  spec: FieldSpec | undefined,
  definition: TemplateDefinition | null,
): string {
  const { t, locale } = translator;
  if (code.startsWith('rule:')) {
    const rule = definition?.crossRules?.find((r) => `rule:${r.id}` === code);
    return rule ? tx(rule.message, locale) : t('rule.type');
  }
  const rules = spec?.rules ?? {};
  switch (code) {
    case 'required':
      return t('rule.required');
    case 'option':
      return t('rule.option');
    case 'min':
      return t('rule.min', { min: rules.min ?? '' });
    case 'max':
      return t('rule.max', { max: rules.max ?? '' });
    case 'minLength':
      return t('rule.minLength');
    case 'maxLength':
      return t('rule.maxLength', { max: rules.maxLength ?? '' });
    case 'pattern':
      return t('rule.pattern');
    case 'minSelected':
      return t('rule.minSelected', { min: rules.minSelected ?? '' });
    case 'maxSelected':
      return t('rule.maxSelected', { max: rules.maxSelected ?? '' });
    case 'pastOnly':
      return t('rule.pastOnly');
    case 'futureOnly':
      return t('rule.futureOnly');
    case 'unknown':
      return t('rule.unknown');
    default:
      return t('rule.type');
  }
}

/** Localised unit: i18n maps are translated; bare strings are symbols (not translated). */
export function unitText(
  unit: FieldSpec['unit'],
  locale: Locale,
): { text: string; symbol: boolean } | null {
  if (unit === undefined) return null;
  return typeof unit === 'string'
    ? { text: unit, symbol: true }
    : { text: tx(unit, locale), symbol: false };
}

export function findField(
  definition: TemplateDefinition | null,
  id: string,
): FieldSpec | undefined {
  return definition?.steps.flatMap((s) => s.fields).find((f) => f.id === id);
}

/** Display a stored answer (used in conflict diffs). */
export function displayValue(
  spec: FieldSpec | undefined,
  value: unknown,
  locale: Locale,
  yes: string,
  no: string,
  empty: string,
): string {
  if (
    value === null ||
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  )
    return empty;
  if (typeof value === 'boolean') return value ? yes : no;
  const option = (v: unknown) => {
    const match = spec?.options?.find((o) => o.value === v);
    return match?.label ? tx(match.label, locale) : typeof v === 'string' ? v : JSON.stringify(v);
  };
  if (Array.isArray(value)) return value.map(option).join(', ');
  if (spec?.options) return option(value);
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value as string | number);
  const unit = unitText(spec?.unit, locale);
  return unit ? `${text} ${unit.text}` : text;
}
