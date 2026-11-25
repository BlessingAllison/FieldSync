/**
 * Form validation engine — TypeScript twin of backend/fieldsync/formtemplates/validation.py.
 * Normative semantics: contracts/README.md. Conformance: contracts/validation-cases.json.
 */
import type {
  Condition,
  FieldSpec,
  FieldValue,
  Payload,
  Scalar,
  TemplateDefinition,
  ValidationResult,
} from './types';

export const RULE_ORDER = [
  'min',
  'max',
  'minLength',
  'maxLength',
  'pattern',
  'minSelected',
  'maxSelected',
  'pastOnly',
  'futureOnly',
] as const;

const PHONE_RE = /^\+?[0-9]{7,15}$/;
const PHONE_STRIP_RE = /[\s\-.()]/g;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type Value = Exclude<FieldValue, null | undefined>;

export const iterFields = (definition: TemplateDefinition): FieldSpec[] =>
  definition.steps.flatMap((step) => step.fields);

const isNumber = (v: unknown): v is number => typeof v === 'number';

/** JavaScript === on JSON scalars (the Python twin emulates this). */
const strictEqual = (a: unknown, b: Scalar): boolean => a === b;

function normalize(type: FieldSpec['type'], value: FieldValue): FieldValue {
  if (typeof value !== 'string') return value;
  let out = value.normalize('NFC').trim();
  if (type === 'phone') out = out.replace(PHONE_STRIP_RE, '');
  return out;
}

export function isEmpty(value: FieldValue): boolean {
  return (
    value === null ||
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

/** Calendar-valid YYYY-MM-DD, compared as a UTC date. */
function parseDate(value: string): number | null {
  if (!DATE_RE.test(value)) return null;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const time = Date.UTC(y, m - 1, d);
  const check = new Date(time);
  return check.getUTCFullYear() === y && check.getUTCMonth() === m - 1 && check.getUTCDate() === d
    ? time
    : null;
}

const codePoints = (s: string): number => [...s].length;

function typeError(spec: FieldSpec, value: Value): string | null {
  const options = new Set((spec.options ?? []).map((o) => o.value));
  switch (spec.type) {
    case 'text':
    case 'phone':
      return typeof value === 'string' ? null : 'type';
    case 'integer':
      return isNumber(value) && Number.isFinite(value) && Number.isInteger(value) ? null : 'type';
    case 'decimal':
      return isNumber(value) && Number.isFinite(value) ? null : 'type';
    case 'boolean':
      return typeof value === 'boolean' ? null : 'type';
    case 'select':
      if (typeof value !== 'string') return 'type';
      return options.has(value) ? null : 'option';
    case 'multiselect':
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) return 'type';
      if (new Set(value).size !== value.length) return 'type';
      return value.every((v) => options.has(v)) ? null : 'option';
    case 'date':
      return typeof value === 'string' && parseDate(value) !== null ? null : 'type';
  }
}

function ruleErrors(spec: FieldSpec, value: Value, todayUtc: number): string[] {
  const rules = spec.rules ?? {};
  const failed = new Set<string>();
  if ((spec.type === 'integer' || spec.type === 'decimal') && isNumber(value)) {
    if (rules.min !== undefined && value < rules.min) failed.add('min');
    if (rules.max !== undefined && value > rules.max) failed.add('max');
  }
  if ((spec.type === 'text' || spec.type === 'phone') && typeof value === 'string') {
    const length = codePoints(value);
    if (rules.minLength !== undefined && length < rules.minLength) failed.add('minLength');
    if (rules.maxLength !== undefined && length > rules.maxLength) failed.add('maxLength');
    if (rules.pattern !== undefined && !new RegExp(rules.pattern, 'u').test(value))
      failed.add('pattern');
    if (spec.type === 'phone' && !PHONE_RE.test(value)) failed.add('pattern');
  }
  if (spec.type === 'multiselect' && Array.isArray(value)) {
    if (rules.minSelected !== undefined && value.length < rules.minSelected)
      failed.add('minSelected');
    if (rules.maxSelected !== undefined && value.length > rules.maxSelected)
      failed.add('maxSelected');
  }
  if (spec.type === 'date' && typeof value === 'string') {
    const date = parseDate(value);
    if (date !== null) {
      if (rules.pastOnly && date > todayUtc) failed.add('pastOnly');
      if (rules.futureOnly && date < todayUtc) failed.add('futureOnly');
    }
  }
  return RULE_ORDER.filter((code) => failed.has(code));
}

export function conditionHolds(condition: Condition, values: Record<string, Value>): boolean {
  if (!(condition.field in values)) return false;
  const value = values[condition.field];
  if (condition.equals !== undefined) return strictEqual(value, condition.equals);
  if (condition.in !== undefined)
    return condition.in.some((candidate) => strictEqual(value, candidate));
  if (condition.notEmpty) return !isEmpty(value);
  return false;
}

/** Which fields are visible for the current answers (drives the form runner). */
export function visibleFieldIds(definition: TemplateDefinition, payload: Payload): Set<string> {
  const visible = new Set<string>();
  const values: Record<string, Value> = {};
  for (const spec of iterFields(definition)) {
    if (spec.showIf && !conditionHolds(spec.showIf, values)) continue;
    visible.add(spec.id);
    const value = normalize(spec.type, payload[spec.id]);
    if (!isEmpty(value) && typeError(spec, value as Value) === null)
      values[spec.id] = value as Value;
  }
  return visible;
}

export function validate(
  definition: TemplateDefinition,
  payload: Payload,
  now: Date,
): ValidationResult {
  const fields = iterFields(definition);
  const known = new Set(fields.map((f) => f.id));
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const errors: Record<string, string[]> = {};
  for (const key of Object.keys(payload)) {
    if (!known.has(key)) errors[key] = ['unknown'];
  }

  const values: Record<string, Value> = {};
  for (const spec of fields) {
    if (spec.showIf && !conditionHolds(spec.showIf, values)) continue;
    const value = normalize(spec.type, payload[spec.id]);
    if (isEmpty(value)) {
      if (spec.required) errors[spec.id] = ['required'];
      continue;
    }
    const tError = typeError(spec, value as Value);
    if (tError) {
      errors[spec.id] = [tError];
      continue;
    }
    values[spec.id] = value as Value;
    const rErrors = ruleErrors(spec, value as Value, todayUtc);
    if (rErrors.length) errors[spec.id] = rErrors;
  }

  for (const rule of definition.crossRules ?? []) {
    if (conditionHolds(rule.when, values) && !(rule.require in values)) {
      (errors[rule.require] ??= []).push(`rule:${rule.id}`);
    }
  }

  return { valid: Object.keys(errors).length === 0, errors, normalized: values };
}
