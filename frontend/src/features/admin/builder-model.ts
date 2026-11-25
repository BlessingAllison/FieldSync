/**
 * Form builder model: pure helpers that keep a template definition valid while an admin edits
 * it. The server re-validates everything (meta-schema + semantic rules); these helpers exist
 * so the admin rarely meets a server error: ids are generated from labels, options get safe
 * values, rules are limited to what each type allows, and conditions only point backwards.
 */
import type { ApiResult } from '@/core/api/http';
import type {
  Condition,
  FieldSpec,
  FieldType,
  I18nText,
  Rules,
  StepSpec,
  TemplateDefinition,
  Widget,
} from '@/core/validation/types';

/** Mirror of backend RULES_BY_TYPE (formtemplates/services.py). */
export const RULES_BY_TYPE: Record<FieldType, ReadonlyArray<keyof Rules>> = {
  text: ['minLength', 'maxLength', 'pattern'],
  phone: ['minLength', 'maxLength', 'pattern'],
  integer: ['min', 'max'],
  decimal: ['min', 'max'],
  boolean: [],
  select: [],
  multiselect: ['minSelected', 'maxSelected'],
  date: ['pastOnly', 'futureOnly'],
};

/** Widgets that make sense per type (the runner falls back to the default otherwise). */
export const WIDGETS_BY_TYPE: Record<FieldType, ReadonlyArray<Widget>> = {
  text: ['default', 'textarea'],
  phone: ['default'],
  integer: ['default', 'stepper', 'muac'],
  decimal: ['default'],
  boolean: ['default'],
  select: ['default', 'cards'],
  multiselect: ['default'],
  date: ['default'],
};

export const FIELD_TYPES: readonly FieldType[] = [
  'text',
  'integer',
  'decimal',
  'boolean',
  'select',
  'multiselect',
  'date',
  'phone',
];

const ID_MAX = 48;
const CODE_MAX = 64;

/** "Danger signs (any)" → "danger_signs_any"; always a valid DSL id. */
export function slugId(text: string, fallback = 'field'): string {
  const base = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, ID_MAX);
  const id = /^[a-z]/.test(base) ? base : `${fallback}_${base}`.replace(/_+$/, '');
  return id.slice(0, ID_MAX) || fallback;
}

/** Template code: lowercase words joined by hyphens ("Malaria case report" → "malaria-case-report"). */
export function slugCode(text: string): string {
  const base = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, CODE_MAX);
  const code = /^[a-z]/.test(base) ? base : `form-${base}`;
  return code.length >= 3 ? code.replace(/-+$/, '') : `${code}-form`;
}

/** Make `wanted` unique against `taken` by appending _2, _3, … (within the id length limit). */
export function uniqueId(wanted: string, taken: Iterable<string>, separator = '_'): string {
  const used = new Set(taken);
  if (!used.has(wanted)) return wanted;
  for (let n = 2; ; n += 1) {
    const suffix = `${separator}${n}`;
    const candidate = `${wanted.slice(0, ID_MAX - suffix.length)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

export const allFields = (definition: TemplateDefinition): FieldSpec[] =>
  definition.steps.flatMap((step) => step.fields);

export function newField(type: FieldType, label: string, taken: Iterable<string>): FieldSpec {
  const field: FieldSpec = {
    id: uniqueId(slugId(label), taken),
    type,
    label: { en: label },
  };
  if (type === 'select' || type === 'multiselect') {
    field.options = [
      { value: 'option_1', label: { en: 'Option 1' } },
      { value: 'option_2', label: { en: 'Option 2' } },
    ];
  }
  if (type === 'select') field.widget = 'cards';
  return field;
}

export function newStep(title: string, takenStepIds: Iterable<string>, takenFieldIds: Iterable<string>): StepSpec {
  return {
    id: uniqueId(slugId(title, 'step'), takenStepIds),
    title: { en: title },
    fields: [newField('text', 'New question', takenFieldIds)],
  };
}

export function emptyDefinition(title: string, subject: 'patient' | 'facility'): TemplateDefinition {
  return {
    code: slugCode(title),
    version: 1,
    subject,
    title: { en: title },
    steps: [
      {
        id: 'step_1',
        title: { en: 'Details' },
        fields: [newField('text', 'First question', [])],
      },
    ],
  };
}

/**
 * Change a field's type, keeping what still applies: label, help, required, pii and
 * showIf survive; rules, options, unit and widget are reset to what the new type allows.
 */
export function changeType(field: FieldSpec, type: FieldType): FieldSpec {
  const kept: FieldSpec = {
    id: field.id,
    type,
    label: field.label,
    ...(field.help ? { help: field.help } : {}),
    ...(field.required ? { required: true } : {}),
    ...(field.pii ? { pii: true } : {}),
    ...(field.showIf ? { showIf: field.showIf } : {}),
  };
  if (type === 'select' || type === 'multiselect') {
    kept.options = field.options ?? newField(type, 'x', []).options;
  }
  if ((type === 'integer' || type === 'decimal') && field.unit && (field.type === 'integer' || field.type === 'decimal')) {
    kept.unit = field.unit;
  }
  const rules = cleanRules(type, field.rules);
  if (rules) kept.rules = rules;
  if (field.widget && WIDGETS_BY_TYPE[type].includes(field.widget)) kept.widget = field.widget;
  return kept;
}

/** Drop rules the type does not allow and empty values; undefined when nothing is left. */
export function cleanRules(type: FieldType, rules: Rules | undefined): Rules | undefined {
  if (!rules) return undefined;
  const allowed = new Set<string>(RULES_BY_TYPE[type]);
  const out = Object.fromEntries(
    Object.entries(rules).filter(
      ([key, value]) => allowed.has(key) && value !== undefined && value !== '' && value !== null,
    ),
  ) as Rules;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Option value from its label, unique within the field. */
export function optionValue(label: string, taken: Iterable<string>): string {
  const base = slugId(label, 'option').replace(/^([^a-z0-9])/, 'o$1');
  return uniqueId(base, taken);
}

/** Fields a condition on `fieldId` may reference: those strictly before it, in form order. */
export function earlierFields(definition: TemplateDefinition, fieldId: string): FieldSpec[] {
  const fields = allFields(definition);
  const index = fields.findIndex((f) => f.id === fieldId);
  return index < 0 ? fields : fields.slice(0, index);
}

/** Remove conditions and cross-rules that point at fields which no longer come earlier. */
export function repairReferences(definition: TemplateDefinition): TemplateDefinition {
  const seen = new Set<string>();
  const steps = definition.steps.map((step) => ({
    ...step,
    fields: step.fields.map((field) => {
      const ok = !field.showIf || seen.has(field.showIf.field);
      seen.add(field.id);
      if (ok) return field;
      const rest = { ...field };
      delete rest.showIf;
      return rest;
    }),
  }));
  const crossRules = (definition.crossRules ?? []).filter(
    (rule) => seen.has(rule.when.field) && seen.has(rule.require),
  );
  return {
    ...definition,
    steps,
    ...(crossRules.length > 0 ? { crossRules } : { crossRules: undefined }),
  };
}

/** Move an item within an array (returns a new array). */
export function move<T>(items: readonly T[], from: number, to: number): T[] {
  if (to < 0 || to >= items.length || from === to) return [...items];
  const copy = [...items];
  const [item] = copy.splice(from, 1);
  copy.splice(to, 0, item as T);
  return copy;
}

/** The next free version number for a template code. */
export function nextVersion(existing: ReadonlyArray<{ code: string; version: number }>, code: string): number {
  return Math.max(0, ...existing.filter((t) => t.code === code).map((t) => t.version)) + 1;
}

/** A new draft version of an existing template (same code, next version). */
export function asNewVersion(
  definition: TemplateDefinition,
  existing: ReadonlyArray<{ code: string; version: number }>,
): TemplateDefinition {
  return { ...structuredClone(definition), version: nextVersion(existing, definition.code) };
}

/** A copy as a brand-new form (new title and code, version 1). */
export function asCopy(
  definition: TemplateDefinition,
  title: string,
  existingCodes: Iterable<string>,
): TemplateDefinition {
  return {
    ...structuredClone(definition),
    title: { en: title },
    code: uniqueId(slugCode(title), existingCodes, '-'),
    version: 1,
  };
}

/** Remove keys whose value is undefined (the server's JSON schema rejects explicit nulls). */
export function toPayload(definition: TemplateDefinition): TemplateDefinition {
  return JSON.parse(JSON.stringify(definition)) as TemplateDefinition;
}

/**
 * Turn a server problem path ("steps/1/fields/2/label: 'en' is required") into a location
 * an admin can find ("Step 2 › Age: …").
 */
export function describeProblem(definition: TemplateDefinition, problem: string, stepWord = 'Step'): string {
  const match = /^steps\/(\d+)(?:\/fields\/(\d+))?(.*?):\s*(.*)$/.exec(problem);
  if (!match) return problem;
  const step = definition.steps[Number(match[1])];
  const field = match[2] !== undefined ? step?.fields[Number(match[2])] : undefined;
  const where = [
    `${stepWord} ${Number(match[1]) + 1}`,
    ...(field ? [field.label.en || field.id] : []),
  ].join(' › ');
  const rest = (match[3] ?? '').replace(/^\//, '');
  return `${where}${rest ? ` (${rest})` : ''}: ${match[4] ?? ''}`;
}

export function i18n(en: string, previous?: I18nText): I18nText {
  return { ...previous, en };
}

export function conditionSummary(condition: Condition): string {
  if (condition.notEmpty) return 'is answered';
  if (condition.in) return `is one of ${condition.in.join(', ')}`;
  return `= ${String(condition.equals)}`;
}

/** Short reason for a failed admin API call (shown in an alert; never contains PHI). */
export function failureText(result: ApiResult<unknown>): string {
  if (result.ok) return '';
  return result.error.kind === 'api' ? result.error.message : result.error.kind;
}
