/** Form template definition types (mirror of contracts/form-template.schema.json). */

export type Locale = 'en' | 'kpe';
export type I18nText = { en: string } & Partial<Record<Exclude<Locale, 'en'>, string>>;
export type FieldType =
  | 'text'
  | 'integer'
  | 'decimal'
  | 'boolean'
  | 'select'
  | 'multiselect'
  | 'date'
  | 'phone';
export type Widget = 'default' | 'stepper' | 'cards' | 'muac' | 'toggle' | 'textarea';
export type Scalar = string | number | boolean;

export interface Condition {
  field: string;
  equals?: Scalar;
  in?: Scalar[];
  notEmpty?: true;
}

export interface Rules {
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minSelected?: number;
  maxSelected?: number;
  pastOnly?: true;
  futureOnly?: true;
}

export interface FieldSpec {
  id: string;
  type: FieldType;
  label: I18nText;
  help?: I18nText;
  required?: boolean;
  pii?: boolean;
  widget?: Widget;
  /** i18n map for unit words; a bare string is a language-neutral symbol (mm, °C). */
  unit?: string | I18nText;
  options?: Array<{ value: string; label?: I18nText }>;
  rules?: Rules;
  showIf?: Condition;
}

export interface StepSpec {
  id: string;
  title: I18nText;
  fields: FieldSpec[];
}

export interface CrossRule {
  id: string;
  when: Condition;
  require: string;
  message: I18nText;
}

export interface TemplateDefinition {
  code: string;
  version: number;
  subject: 'patient' | 'facility';
  title: I18nText;
  description?: I18nText;
  retain_after_sync_days?: number;
  steps: StepSpec[];
  crossRules?: CrossRule[];
}

export type FieldValue = string | number | boolean | string[] | null | undefined;
export type Payload = Record<string, FieldValue>;
export type FieldErrors = Record<string, string[]>;

export interface ValidationResult {
  valid: boolean;
  errors: FieldErrors;
  normalized: Record<string, Exclude<FieldValue, null | undefined>>;
}
