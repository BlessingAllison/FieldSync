/**
 * Admin form builder: edit a draft template (steps, questions, answer types, choices, rules,
 * conditions) with autosave and a live preview that uses the field team's own form widgets
 * and validation engine. Published versions open read-only.
 *
 * Saving: every change is validated on the server (dry run) after a short pause; only a
 * valid definition is stored. Problems are listed in plain words with their location.
 */
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  GitBranchPlus,
  ListPlus,
  Plus,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { api } from '@/app/runtime';
import type { FormTemplateAdmin } from '@/core/api/client';
import { validate, visibleFieldIds } from '@/core/validation/engine';
import type {
  Condition,
  FieldSpec,
  FieldType,
  FieldValue,
  Payload,
  Rules,
  StepSpec,
  TemplateDefinition,
  Widget,
} from '@/core/validation/types';
import { FieldRenderer } from '@/features/forms/FieldRenderer';
import { type MessageKey, useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { ruleMessage, tx } from '@/lib/template-text';
import { useNetwork } from '@/stores/network';
import { Button } from '@/ui/button';
import { TextInput } from '@/ui/form-controls';
import { PageSkeleton } from '@/ui/skeleton';

import {
  FIELD_TYPES,
  RULES_BY_TYPE,
  WIDGETS_BY_TYPE,
  allFields,
  asNewVersion,
  changeType,
  cleanRules,
  describeProblem,
  earlierFields,
  failureText,
  move,
  newField,
  newStep,
  optionValue,
  repairReferences,
  slugId,
  toPayload,
  uniqueId,
} from './builder-model';

type SaveState = 'saved' | 'saving' | 'invalid' | 'error';
const SAVE_DELAY_MS = 900;

// ── Small inputs ─────────────────────────────────────────────────────────────

function Labeled({
  id,
  label,
  help,
  children,
}: {
  id: string;
  label: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="font-semibold">
        {label}
      </label>
      {children}
      {help && (
        <p id={`${id}-help`} className="text-sm text-muted-foreground">
          {help}
        </p>
      )}
    </div>
  );
}

function Select<T extends string>({
  id,
  value,
  options,
  onChange,
  ariaLabel,
}: {
  id: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  /** For selects without a visible <label for>. */
  ariaLabel?: string;
}) {
  return (
    <select
      id={id}
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className="min-h-tap w-full rounded-lg border-2 border-input bg-card px-3 text-base"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function Check({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label htmlFor={id} className="flex min-h-tap items-center gap-3">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-5 shrink-0"
      />
      <span>{label}</span>
    </label>
  );
}

const numberOrUndefined = (raw: string): number | undefined => {
  if (raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
};

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

// ── Field editor ─────────────────────────────────────────────────────────────

function ConditionEditor({
  field,
  definition,
  onChange,
}: {
  field: FieldSpec;
  definition: TemplateDefinition;
  onChange: (condition: Condition | undefined) => void;
}) {
  const { t, locale } = useT();
  const candidates = earlierFields(definition, field.id);
  const condition = field.showIf;
  const source = candidates.find((f) => f.id === condition?.field);
  const base = `fb-${field.id}-if`;

  if (candidates.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('fb.showIf.noEarlier')}</p>;
  }

  const defaultCondition = (spec: FieldSpec): Condition => {
    if (spec.type === 'boolean') return { field: spec.id, equals: true };
    if (spec.type === 'select') return { field: spec.id, equals: spec.options?.[0]?.value ?? '' };
    return { field: spec.id, notEmpty: true };
  };

  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend className="mb-1 font-semibold">{t('fb.showIf')}</legend>
      <Select
        id={`${base}-field`}
        ariaLabel={t('fb.showIf')}
        value={condition?.field ?? ''}
        options={[
          { value: '', label: t('fb.showIf.always') },
          ...candidates.map((spec) => ({ value: spec.id, label: tx(spec.label, locale) })),
        ]}
        onChange={(id) => {
          const spec = candidates.find((f) => f.id === id);
          onChange(spec ? defaultCondition(spec) : undefined);
        }}
      />
      {source && condition && (
        <div className="flex flex-col gap-2 sm:flex-row">
          {source.type !== 'multiselect' && (
            <Select
              id={`${base}-op`}
              ariaLabel={t('fb.showIf')}
              value={condition.notEmpty ? 'answered' : 'equals'}
              options={[
                { value: 'equals', label: t('fb.showIf.answer') },
                { value: 'answered', label: t('fb.showIf.answered') },
              ]}
              onChange={(op) =>
                onChange(
                  op === 'answered'
                    ? { field: source.id, notEmpty: true }
                    : { ...defaultCondition(source), notEmpty: undefined },
                )
              }
            />
          )}
          {!condition.notEmpty && source.type === 'boolean' && (
            <Select
              id={`${base}-value`}
              ariaLabel={t('fb.showIf.value')}
              value={String(condition.equals)}
              options={[
                { value: 'true', label: t('fb.yes') },
                { value: 'false', label: t('fb.no') },
              ]}
              onChange={(v) => onChange({ field: source.id, equals: v === 'true' })}
            />
          )}
          {!condition.notEmpty && source.type === 'select' && (
            <Select
              id={`${base}-value`}
              ariaLabel={t('fb.showIf.value')}
              value={String(condition.equals ?? '')}
              options={(source.options ?? []).map((o) => ({
                value: o.value,
                label: o.label ? tx(o.label, locale) : o.value,
              }))}
              onChange={(v) => onChange({ field: source.id, equals: v })}
            />
          )}
          {!condition.notEmpty &&
            source.type !== 'boolean' &&
            source.type !== 'select' &&
            source.type !== 'multiselect' && (
              <TextInput
                id={`${base}-value`}
                aria-label={t('fb.showIf.value')}
                value={String(condition.equals ?? '')}
                onChange={(e) => {
                  const raw = e.target.value;
                  const numeric = source.type === 'integer' || source.type === 'decimal';
                  onChange({
                    field: source.id,
                    equals: numeric ? (numberOrUndefined(raw) ?? 0) : raw,
                  });
                }}
              />
            )}
        </div>
      )}
    </fieldset>
  );
}

function OptionsEditor({
  field,
  onChange,
}: {
  field: FieldSpec;
  onChange: (options: NonNullable<FieldSpec['options']>) => void;
}) {
  const { t } = useT();
  const options = field.options ?? [];
  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend className="mb-1 font-semibold">{t('fb.options')}</legend>
      <ol className="flex flex-col gap-2">
        {options.map((option, index) => (
          <li key={`${option.value}-${index}`} className="flex items-center gap-1">
            <TextInput
              aria-label={t('fb.option', { n: index + 1 })}
              value={option.label?.en ?? ''}
              onChange={(e) => {
                const label = e.target.value;
                const next = [...options];
                // A choice's stored value follows its label until the form is published.
                const others = options.filter((_, i) => i !== index).map((o) => o.value);
                next[index] = {
                  value: label.trim() ? optionValue(label, others) : option.value,
                  label: { ...option.label, en: label },
                };
                onChange(next);
              }}
            />
            <IconButton
              label={t('fb.moveUp')}
              disabled={index === 0}
              onClick={() => onChange(move(options, index, index - 1))}
            >
              <ArrowUp aria-hidden />
            </IconButton>
            <IconButton
              label={t('fb.moveDown')}
              disabled={index === options.length - 1}
              onClick={() => onChange(move(options, index, index + 1))}
            >
              <ArrowDown aria-hidden />
            </IconButton>
            <IconButton
              label={t('fb.removeOption')}
              disabled={options.length <= 2}
              onClick={() => onChange(options.filter((_, i) => i !== index))}
            >
              <Trash2 aria-hidden />
            </IconButton>
          </li>
        ))}
      </ol>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        disabled={options.length >= 60}
        onClick={() => {
          const label = `${t('fb.newOption')} ${options.length + 1}`;
          onChange([
            ...options,
            {
              value: optionValue(
                label,
                options.map((o) => o.value),
              ),
              label: { en: label },
            },
          ]);
        }}
      >
        <Plus aria-hidden />
        {t('fb.addOption')}
      </Button>
    </fieldset>
  );
}

function RulesEditor({
  field,
  onChange,
}: {
  field: FieldSpec;
  onChange: (rules: Rules | undefined) => void;
}) {
  const { t } = useT();
  const rules = field.rules ?? {};
  const allowed = RULES_BY_TYPE[field.type];
  const base = `fb-${field.id}`;
  const set = (patch: Rules) => onChange(cleanRules(field.type, { ...rules, ...patch }));
  const numberInput = (
    key: 'min' | 'max' | 'minLength' | 'maxLength' | 'minSelected' | 'maxSelected',
    label: MessageKey,
  ) => (
    <Labeled id={`${base}-${key}`} label={t(label)}>
      <TextInput
        id={`${base}-${key}`}
        inputMode="decimal"
        value={rules[key] ?? ''}
        onChange={(e) => set({ [key]: numberOrUndefined(e.target.value) })}
      />
    </Labeled>
  );

  if (allowed.length === 0) return null;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {allowed.includes('min') && numberInput('min', 'fb.min')}
      {allowed.includes('max') && numberInput('max', 'fb.max')}
      {allowed.includes('minLength') && numberInput('minLength', 'fb.minLength')}
      {allowed.includes('maxLength') && numberInput('maxLength', 'fb.maxLength')}
      {allowed.includes('minSelected') && numberInput('minSelected', 'fb.minSelected')}
      {allowed.includes('maxSelected') && numberInput('maxSelected', 'fb.maxSelected')}
      {allowed.includes('pastOnly') && (
        <Labeled id={`${base}-date`} label={t('fb.dateRule')}>
          <Select
            id={`${base}-date`}
            value={rules.pastOnly ? 'past' : rules.futureOnly ? 'future' : 'any'}
            options={[
              { value: 'any', label: t('fb.dateRule.any') },
              { value: 'past', label: t('fb.dateRule.past') },
              { value: 'future', label: t('fb.dateRule.future') },
            ]}
            onChange={(v) =>
              onChange(
                cleanRules(field.type, {
                  ...(v === 'past' ? { pastOnly: true } : {}),
                  ...(v === 'future' ? { futureOnly: true } : {}),
                }),
              )
            }
          />
        </Labeled>
      )}
      {allowed.includes('pattern') && (
        <div className="sm:col-span-2">
          <Labeled id={`${base}-pattern`} label={t('fb.pattern')} help={t('fb.patternHelp')}>
            <TextInput
              id={`${base}-pattern`}
              className="font-mono"
              value={rules.pattern ?? ''}
              aria-describedby={`${base}-pattern-help`}
              onChange={(e) => set({ pattern: e.target.value || undefined })}
            />
          </Labeled>
        </div>
      )}
    </div>
  );
}

function FieldEditor({
  field,
  index,
  count,
  definition,
  expanded,
  onToggle,
  onChange,
  onMove,
  onRemove,
  editable,
}: {
  editable: boolean;
  field: FieldSpec;
  index: number;
  count: number;
  definition: TemplateDefinition;
  expanded: boolean;
  onToggle: () => void;
  onChange: (field: FieldSpec) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  const { t, locale } = useT();
  const base = `fb-${field.id}`;
  const otherIds = allFields(definition)
    .map((f) => f.id)
    .filter((id) => id !== field.id);
  const set = (patch: Partial<FieldSpec>) => {
    const next = { ...field, ...patch } as FieldSpec;
    for (const key of Object.keys(patch) as Array<keyof FieldSpec>) {
      if (patch[key] === undefined) delete next[key];
    }
    onChange(next);
  };
  const unitText = typeof field.unit === 'string' ? field.unit : (field.unit?.en ?? '');

  return (
    <li className="rounded-lg border bg-background">
      <div className="flex items-center gap-1 p-1">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={`${base}-panel`}
          className="flex min-h-tap min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left hover:bg-accent"
        >
          {expanded ? (
            <ChevronDown aria-hidden className="size-5 shrink-0" />
          ) : (
            <ChevronRight aria-hidden className="size-5 shrink-0" />
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate font-semibold">
              {tx(field.label, locale) || field.id}
            </span>
            <span className="block text-sm text-muted-foreground">
              {t(`fb.type.${field.type}` as MessageKey)}
              {field.required ? ` · ${t('fb.required')}` : ''}
              {field.showIf ? ` · ${t('fb.showIf')}` : ''}
            </span>
          </span>
        </button>
        <IconButton
          label={t('fb.moveUp')}
          disabled={!editable || index === 0}
          onClick={() => onMove(index - 1)}
        >
          <ArrowUp aria-hidden />
        </IconButton>
        <IconButton
          label={t('fb.moveDown')}
          disabled={!editable || index === count - 1}
          onClick={() => onMove(index + 1)}
        >
          <ArrowDown aria-hidden />
        </IconButton>
        <IconButton
          label={t('fb.removeQuestion')}
          disabled={!editable || count <= 1}
          onClick={onRemove}
        >
          <Trash2 aria-hidden />
        </IconButton>
      </div>
      {expanded && (
        <fieldset
          id={`${base}-panel`}
          disabled={!editable}
          className="flex min-w-0 flex-col gap-4 border-t p-4"
        >
          <Labeled id={`${base}-label`} label={t('fb.question')}>
            <TextInput
              id={`${base}-label`}
              value={field.label.en}
              maxLength={300}
              onChange={(e) => set({ label: { ...field.label, en: e.target.value } })}
            />
          </Labeled>
          <Labeled id={`${base}-label-kpe`} label={t('fb.questionKpe')}>
            <TextInput
              id={`${base}-label-kpe`}
              value={field.label.kpe ?? ''}
              maxLength={400}
              onChange={(e) =>
                set({
                  label: { en: field.label.en, ...(e.target.value ? { kpe: e.target.value } : {}) },
                })
              }
            />
          </Labeled>
          <Labeled id={`${base}-help`} label={t('fb.help')}>
            <TextInput
              id={`${base}-help`}
              value={field.help?.en ?? ''}
              maxLength={300}
              onChange={(e) =>
                set({ help: e.target.value ? { ...field.help, en: e.target.value } : undefined })
              }
            />
          </Labeled>
          <div className="grid gap-3 sm:grid-cols-2">
            <Labeled id={`${base}-type`} label={t('fb.type')}>
              <Select<FieldType>
                id={`${base}-type`}
                value={field.type}
                options={FIELD_TYPES.map((type) => ({
                  value: type,
                  label: t(`fb.type.${type}` as MessageKey),
                }))}
                onChange={(type) => onChange(changeType(field, type))}
              />
            </Labeled>
            {WIDGETS_BY_TYPE[field.type].length > 1 && (
              <Labeled id={`${base}-widget`} label={t('fb.widget')}>
                <Select<Widget>
                  id={`${base}-widget`}
                  value={field.widget ?? 'default'}
                  options={WIDGETS_BY_TYPE[field.type].map((w) => ({
                    value: w,
                    label: t(`fb.widget.${w}` as MessageKey),
                  }))}
                  onChange={(widget) => set({ widget: widget === 'default' ? undefined : widget })}
                />
              </Labeled>
            )}
          </div>
          <div className="flex flex-col">
            <Check
              id={`${base}-required`}
              label={t('fb.required')}
              checked={Boolean(field.required)}
              onChange={(v) => set({ required: v || undefined })}
            />
            <Check
              id={`${base}-pii`}
              label={t('fb.pii')}
              checked={Boolean(field.pii)}
              onChange={(v) => set({ pii: v || undefined })}
            />
          </div>
          {(field.type === 'select' || field.type === 'multiselect') && (
            <OptionsEditor field={field} onChange={(options) => set({ options })} />
          )}
          {(field.type === 'integer' || field.type === 'decimal') && (
            <Labeled id={`${base}-unit`} label={t('fb.unit')}>
              <TextInput
                id={`${base}-unit`}
                value={unitText}
                maxLength={16}
                onChange={(e) => {
                  const value = e.target.value.trim();
                  // Words ("months") are translatable; short symbols ("mm", "kg") are not.
                  set({
                    unit: value ? (/^[a-z]{3,}$/i.test(value) ? { en: value } : value) : undefined,
                  });
                }}
              />
            </Labeled>
          )}
          <RulesEditor field={field} onChange={(rules) => set({ rules })} />
          <ConditionEditor
            field={field}
            definition={definition}
            onChange={(showIf) => set({ showIf })}
          />
          <details className="rounded-md border p-3">
            <summary className="cursor-pointer font-semibold">{t('fb.advanced')}</summary>
            <div className="mt-3">
              <Labeled id={`${base}-id`} label={t('fb.fieldId')}>
                <TextInput
                  id={`${base}-id`}
                  className="font-mono"
                  value={field.id}
                  onChange={(e) => set({ id: uniqueId(slugId(e.target.value), otherIds) })}
                />
              </Labeled>
            </div>
          </details>
        </fieldset>
      )}
    </li>
  );
}

// ── Preview ──────────────────────────────────────────────────────────────────

function Preview({ definition, valid }: { definition: TemplateDefinition; valid: boolean }) {
  const translator = useT();
  const { t, locale } = translator;
  const [values, setValues] = useState<Payload>({});
  const [step, setStep] = useState(0);
  const steps = definition.steps;
  const current = steps[Math.min(step, steps.length - 1)];
  const result = useMemo(() => {
    try {
      return {
        visible: visibleFieldIds(definition, values),
        check: validate(definition, values, new Date()),
      };
    } catch {
      return null; // an in-progress definition the engine cannot evaluate yet
    }
  }, [definition, values]);

  if (!valid || !result || !current) {
    return (
      <p className="rounded-lg border border-dashed p-4 text-muted-foreground">
        {t('fb.preview.invalid')}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">{t('fb.preview.help')}</p>
      <div className="flex flex-wrap gap-2" role="tablist" aria-label={t('fb.steps')}>
        {steps.map((s, index) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={index === step}
            onClick={() => setStep(index)}
            className={cn(
              'min-h-tap rounded-full border-2 px-3 text-sm font-semibold',
              index === step
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-input bg-card',
            )}
          >
            {index + 1}. {tx(s.title, locale)}
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-6 rounded-xl border-2 bg-card p-4" role="tabpanel">
        <h3 className="text-xl font-bold">{tx(current.title, locale)}</h3>
        {current.fields
          .filter((f) => result.visible.has(f.id))
          .map((spec) => {
            const codes = result.check.errors[spec.id];
            const touched = values[spec.id] !== undefined;
            return (
              <FieldRenderer
                key={spec.id}
                spec={spec}
                value={values[spec.id]}
                error={
                  touched && codes?.[0]
                    ? ruleMessage(translator, codes[0], spec, definition)
                    : undefined
                }
                onChange={(value: FieldValue) =>
                  setValues((prev) => ({ ...prev, [spec.id]: value }))
                }
                onBlur={() => undefined}
              />
            );
          })}
      </div>
      <Button type="button" variant="ghost" className="self-start" onClick={() => setValues({})}>
        <RotateCcw aria-hidden />
        {t('fb.preview.reset')}
      </Button>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function FormBuilderPage() {
  const { templateId = '' } = useParams();
  const { t, plural, locale } = useT();
  const navigate = useNavigate();
  const online = useNetwork((s) => s.online);
  const [template, setTemplate] = useState<FormTemplateAdmin | null>(null);
  const [definition, setDefinition] = useState<TemplateDefinition | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [problems, setProblems] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [tab, setTab] = useState<'edit' | 'preview'>('edit');
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<TemplateDefinition | null>(null);
  const saveSeq = useRef(0);

  useEffect(() => {
    let alive = true;
    void api.templateDetail(templateId).then((result) => {
      if (!alive) return;
      if (!result.ok) {
        setLoadError(failureText(result));
        return;
      }
      setTemplate(result.data);
      const loaded = result.data.definition as TemplateDefinition;
      setDefinition(loaded);
      latest.current = loaded;
      setExpanded(loaded.steps[0]?.fields[0]?.id ?? null);
    });
    return () => {
      alive = false;
    };
  }, [templateId]);

  const editable = template?.status === 'draft';

  const save = useCallback(async () => {
    const current = latest.current;
    if (!current || !template) return;
    const seq = ++saveSeq.current;
    setSaveState('saving');
    const payload = toPayload(current);
    const check = await api.validateTemplate(payload);
    if (seq !== saveSeq.current) return; // a newer edit superseded this save
    if (!check.ok) {
      setSaveState('error');
      setProblems([failureText(check)]);
      return;
    }
    if (!check.data.valid) {
      setSaveState('invalid');
      setProblems(check.data.problems);
      return;
    }
    const stored = await api.updateTemplate(template.id, payload);
    if (seq !== saveSeq.current) return;
    if (stored.ok) {
      setSaveState('saved');
      setProblems([]);
    } else {
      setSaveState('error');
      setProblems([failureText(stored)]);
    }
  }, [template]);

  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
        void save(); // flush the last edit when leaving
      }
    },
    [save],
  );

  const update = (change: (d: TemplateDefinition) => TemplateDefinition) => {
    if (!editable || !latest.current) return;
    const next = repairReferences(change(latest.current));
    latest.current = next;
    setDefinition(next);
    setSaveState('saving');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void save();
    }, SAVE_DELAY_MS);
  };

  const updateStep = (stepIndex: number, change: (s: StepSpec) => StepSpec) =>
    update((d) => ({ ...d, steps: d.steps.map((s, i) => (i === stepIndex ? change(s) : s)) }));

  const newVersion = async () => {
    if (!template || !definition) return;
    setBusy(true);
    const all = await api.manageTemplates();
    const created = all.ok ? await api.createTemplate(asNewVersion(definition, all.data)) : all;
    setBusy(false);
    if (created.ok) navigate(`/admin/forms/${(created.data as { id: string }).id}`);
    else setProblems([failureText(created)]);
  };

  if (loadError) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-4">
        <p role="alert" className="font-medium text-status-failed">
          {t('fb.actionFailed', { reason: loadError })}
        </p>
        <Link to="/admin/forms" className="font-semibold underline underline-offset-4">
          {t('fb.back')}
        </Link>
      </div>
    );
  }
  if (!template || !definition) return <PageSkeleton />;

  const crossRuleCount = definition.crossRules?.length ?? 0;
  const statusLine =
    saveState === 'saving'
      ? t('fb.saving')
      : saveState === 'saved'
        ? t('fb.saved')
        : plural('fb.unsaved', problems.length);

  const editor = (
    <div className="flex flex-col gap-5">
      {!editable && (
        <div className="flex flex-col gap-3 rounded-lg border border-status-pending/40 bg-status-pending-bg p-4 text-status-pending">
          <p className="font-medium">
            {t('fb.readOnly', {
              status: t(`fb.status.${template.status}` as MessageKey).toLowerCase(),
            })}
          </p>
          <Button
            className="self-start"
            disabled={!online || busy}
            onClick={() => void newVersion()}
          >
            <GitBranchPlus aria-hidden />
            {t('fb.newVersion')}
          </Button>
        </div>
      )}
      <div className="flex min-w-0 flex-col gap-5">
        <section
          aria-labelledby="fb-settings"
          className="flex flex-col gap-4 rounded-lg border bg-card p-4"
        >
          <h2 id="fb-settings" className="text-lg font-bold">
            {t('fb.settings')}
          </h2>
          <Labeled id="fb-title" label={t('fb.formTitle')}>
            <TextInput
              id="fb-title"
              disabled={!editable}
              value={definition.title.en}
              maxLength={300}
              onChange={(e) => update((d) => ({ ...d, title: { ...d.title, en: e.target.value } }))}
            />
          </Labeled>
          <Labeled id="fb-title-kpe" label={t('fb.formTitleKpe')}>
            <TextInput
              id="fb-title-kpe"
              disabled={!editable}
              value={definition.title.kpe ?? ''}
              maxLength={400}
              onChange={(e) =>
                update((d) => ({
                  ...d,
                  title: { en: d.title.en, ...(e.target.value ? { kpe: e.target.value } : {}) },
                }))
              }
            />
          </Labeled>
          <Labeled id="fb-description" label={t('fb.description')}>
            <TextInput
              id="fb-description"
              disabled={!editable}
              value={definition.description?.en ?? ''}
              maxLength={300}
              onChange={(e) =>
                update((d) => {
                  const next = { ...d };
                  if (e.target.value) next.description = { ...d.description, en: e.target.value };
                  else delete next.description;
                  return next;
                })
              }
            />
          </Labeled>
          <p className="text-sm text-muted-foreground">
            {t('fb.code')}: <span className="font-mono">{definition.code}</span> ·{' '}
            {t('fb.version', { version: definition.version })} ·{' '}
            {t(`fb.subject.${definition.subject}`)}
          </p>
        </section>

        <section aria-labelledby="fb-steps" className="flex flex-col gap-4">
          <h2 id="fb-steps" className="text-lg font-bold">
            {t('fb.steps')}
          </h2>
          {definition.steps.map((step, stepIndex) => (
            <section
              key={step.id}
              aria-label={t('fb.step', { n: stepIndex + 1 })}
              className="flex flex-col gap-3 rounded-lg border bg-card p-4"
            >
              <div className="flex items-end gap-1">
                <div className="flex-1">
                  <Labeled
                    id={`fb-step-${step.id}`}
                    label={`${t('fb.step', { n: stepIndex + 1 })} · ${t('fb.stepTitle')}`}
                  >
                    <TextInput
                      id={`fb-step-${step.id}`}
                      disabled={!editable}
                      value={step.title.en}
                      maxLength={300}
                      onChange={(e) =>
                        updateStep(stepIndex, (s) => ({
                          ...s,
                          title: { ...s.title, en: e.target.value },
                        }))
                      }
                    />
                  </Labeled>
                </div>
                <IconButton
                  label={t('fb.moveUp')}
                  disabled={!editable || stepIndex === 0}
                  onClick={() =>
                    update((d) => ({ ...d, steps: move(d.steps, stepIndex, stepIndex - 1) }))
                  }
                >
                  <ArrowUp aria-hidden />
                </IconButton>
                <IconButton
                  label={t('fb.moveDown')}
                  disabled={!editable || stepIndex === definition.steps.length - 1}
                  onClick={() =>
                    update((d) => ({ ...d, steps: move(d.steps, stepIndex, stepIndex + 1) }))
                  }
                >
                  <ArrowDown aria-hidden />
                </IconButton>
                <IconButton
                  label={t('fb.removeStep')}
                  disabled={!editable || definition.steps.length <= 1}
                  onClick={() =>
                    update((d) => ({ ...d, steps: d.steps.filter((_, i) => i !== stepIndex) }))
                  }
                >
                  <Trash2 aria-hidden />
                </IconButton>
              </div>
              <p className="text-sm text-muted-foreground">
                {plural('fb.questionCount', step.fields.length)}
              </p>
              <ol className="flex flex-col gap-2">
                {step.fields.map((field, fieldIndex) => (
                  <FieldEditor
                    key={`${step.id}-${fieldIndex}`}
                    editable={editable}
                    field={field}
                    index={fieldIndex}
                    count={step.fields.length}
                    definition={definition}
                    expanded={expanded === field.id}
                    onToggle={() => setExpanded(expanded === field.id ? null : field.id)}
                    onChange={(next) => {
                      if (expanded === field.id && next.id !== field.id) setExpanded(next.id);
                      updateStep(stepIndex, (s) => ({
                        ...s,
                        fields: s.fields.map((f, i) => (i === fieldIndex ? next : f)),
                      }));
                    }}
                    onMove={(to) =>
                      updateStep(stepIndex, (s) => ({
                        ...s,
                        fields: move(s.fields, fieldIndex, to),
                      }))
                    }
                    onRemove={() =>
                      updateStep(stepIndex, (s) => ({
                        ...s,
                        fields: s.fields.filter((_, i) => i !== fieldIndex),
                      }))
                    }
                  />
                ))}
              </ol>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                disabled={!editable || step.fields.length >= 40}
                onClick={() => {
                  const field = newField(
                    'text',
                    t('fb.newQuestion'),
                    allFields(definition).map((f) => f.id),
                  );
                  updateStep(stepIndex, (s) => ({ ...s, fields: [...s.fields, field] }));
                  setExpanded(field.id);
                }}
              >
                <ListPlus aria-hidden />
                {t('fb.addQuestion')}
              </Button>
            </section>
          ))}
          <Button
            type="button"
            variant="outline"
            className="self-start"
            disabled={!editable}
            onClick={() => {
              const step = newStep(
                t('fb.newStepTitle'),
                definition.steps.map((s) => s.id),
                allFields(definition).map((f) => f.id),
              );
              update((d) => ({ ...d, steps: [...d.steps, step] }));
              setExpanded(step.fields[0]?.id ?? null);
            }}
          >
            <Plus aria-hidden />
            {t('fb.addStep')}
          </Button>
          {crossRuleCount > 0 && (
            <p className="text-sm text-muted-foreground">
              {plural('fb.crossRules', crossRuleCount)}
            </p>
          )}
        </section>
      </div>
    </div>
  );

  const valid = saveState === 'saved' || (saveState === 'saving' && problems.length === 0);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Link
            to="/admin/forms"
            aria-label={t('fb.back')}
            className="flex size-11 shrink-0 items-center justify-center rounded-full border bg-card hover:bg-accent"
          >
            <ArrowLeft aria-hidden className="size-5" />
          </Link>
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-bold tracking-tight">
              {tx(definition.title, locale) || definition.code}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t('fb.version', { version: definition.version })} ·{' '}
              {t(`fb.status.${template.status}` as MessageKey)}
            </p>
          </div>
        </div>
        {editable && (
          <p
            role="status"
            aria-live="polite"
            className={cn(
              'font-semibold',
              saveState === 'saved' && 'text-status-sent',
              (saveState === 'invalid' || saveState === 'error') && 'text-status-failed',
              saveState === 'saving' && 'text-muted-foreground',
            )}
          >
            {statusLine}
          </p>
        )}
      </div>

      {!online && editable && (
        <p
          role="status"
          className="rounded-lg border border-status-pending/40 bg-status-pending-bg p-3 font-medium text-status-pending"
        >
          {t('fb.offline')}
        </p>
      )}

      {problems.length > 0 && saveState !== 'saving' && (
        <div
          role="alert"
          className="rounded-lg border-2 border-status-failed bg-status-failed-bg p-4 text-status-failed"
        >
          <p className="font-bold">{t('fb.problems')}</p>
          <ul className="mt-1 list-disc pl-5">
            {problems.map((problem) => (
              <li key={problem}>
                {describeProblem(definition, problem, t('fb.step', { n: '' }).trim())}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex gap-2 lg:hidden" role="tablist" aria-label={t('fb.title')}>
        {(['edit', 'preview'] as const).map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            onClick={() => setTab(name)}
            className={cn(
              'min-h-tap flex-1 rounded-lg border-2 font-semibold',
              tab === name
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-input bg-card',
            )}
          >
            {t(`fb.tab.${name}`)}
          </button>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className={cn('min-w-0', tab !== 'edit' && 'hidden lg:block')}>{editor}</div>
        <aside
          aria-labelledby="fb-preview-title"
          className={cn(
            'min-w-0 lg:sticky lg:top-20 lg:self-start',
            tab !== 'preview' && 'hidden lg:block',
          )}
        >
          <h2 id="fb-preview-title" className="mb-3 text-lg font-bold">
            {t('fb.preview.title')}
          </h2>
          <Preview definition={definition} valid={!editable || valid} />
        </aside>
      </div>
    </div>
  );
}
