/**
 * Thumb-first form controls (ADD §16.3): every target ≥ 48 px, minimal typing, label +
 * error wired with aria-describedby, state never conveyed by colour alone.
 */
import { Check, Minus, Plus } from 'lucide-react';
import { type InputHTMLAttributes, type ReactNode, forwardRef, useId } from 'react';

import { cn } from '@/lib/cn';

export function FieldShell({
  id,
  label,
  help,
  error,
  required,
  requiredLabel,
  children,
  as = 'div',
}: {
  id: string;
  label: string;
  help?: string | undefined;
  error?: string | undefined;
  required?: boolean | undefined;
  requiredLabel?: string;
  children: ReactNode;
  as?: 'div' | 'fieldset';
}) {
  const Tag = as;
  const LabelTag = as === 'fieldset' ? 'legend' : 'label';
  return (
    <Tag
      className="flex flex-col gap-2"
      {...(as === 'fieldset'
        ? { 'aria-describedby': error ? `${id}-error` : help ? `${id}-help` : undefined }
        : {})}
    >
      <LabelTag
        {...(as === 'div' ? { htmlFor: id } : {})}
        className="text-lg font-semibold leading-snug"
      >
        {label}
        {required && (
          <span className="ml-1 text-base font-normal text-muted-foreground">
            ({requiredLabel ?? 'required'})
          </span>
        )}
      </LabelTag>
      {help && (
        <p id={`${id}-help`} className="-mt-1 text-muted-foreground">
          {help}
        </p>
      )}
      {children}
      {error && (
        <p
          id={`${id}-error`}
          role="alert"
          className="flex items-start gap-1.5 font-medium text-status-failed"
        >
          <span aria-hidden>⚠</span>
          {error}
        </p>
      )}
    </Tag>
  );
}

export const TextInput = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }
>(({ className, invalid, ...props }, ref) => (
  <input
    ref={ref}
    aria-invalid={invalid || undefined}
    className={cn(
      'min-h-tap w-full rounded-lg border-2 border-input bg-card px-4 text-lg text-foreground placeholder:text-muted-foreground',
      invalid && 'border-status-failed',
      className,
    )}
    {...props}
  />
));
TextInput.displayName = 'TextInput';

export function TextArea({
  invalid,
  className,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return (
    <textarea
      aria-invalid={invalid || undefined}
      className={cn(
        'min-h-28 w-full rounded-lg border-2 border-input bg-card p-4 text-lg text-foreground',
        invalid && 'border-status-failed',
        className,
      )}
      {...props}
    />
  );
}

export interface ChoiceOption {
  value: string;
  label: string;
}

/** Large radio cards (single choice) — replaces dropdowns for ≤ ~8 options. */
export function ChoiceCards({
  id,
  name,
  options,
  value,
  onChange,
  describedBy,
}: {
  id?: string;
  name: string;
  options: ChoiceOption[];
  value: string | null;
  onChange: (value: string) => void;
  describedBy?: string | undefined;
}) {
  return (
    <div
      id={id}
      tabIndex={id ? -1 : undefined}
      role="radiogroup"
      aria-describedby={describedBy}
      className="grid grid-cols-1 gap-2 sm:grid-cols-2"
    >
      {options.map((option) => {
        const checked = value === option.value;
        return (
          <label
            key={option.value}
            className={cn(
              'flex min-h-tap cursor-pointer items-center gap-3 rounded-lg border-2 bg-card px-4 py-3 text-lg font-medium transition-colors',
              checked
                ? 'border-primary bg-secondary text-secondary-foreground'
                : 'border-input hover:bg-accent',
            )}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={checked}
              onChange={() => onChange(option.value)}
              className="sr-only"
            />
            <span
              aria-hidden
              className={cn(
                'flex size-6 shrink-0 items-center justify-center rounded-full border-2',
                checked ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
              )}
            >
              {checked && <Check className="size-4" strokeWidth={3} />}
            </span>
            {option.label}
          </label>
        );
      })}
    </div>
  );
}

/** Checkbox cards (multiple choice). */
export function MultiCards({
  id,
  name,
  options,
  value,
  onChange,
  describedBy,
}: {
  id?: string;
  name: string;
  options: ChoiceOption[];
  value: string[];
  onChange: (value: string[]) => void;
  describedBy?: string | undefined;
}) {
  return (
    <div
      id={id}
      tabIndex={id ? -1 : undefined}
      role="group"
      aria-describedby={describedBy}
      className="grid grid-cols-1 gap-2 sm:grid-cols-2"
    >
      {options.map((option) => {
        const checked = value.includes(option.value);
        return (
          <label
            key={option.value}
            className={cn(
              'flex min-h-tap cursor-pointer items-center gap-3 rounded-lg border-2 bg-card px-4 py-3 text-lg font-medium transition-colors',
              checked
                ? 'border-primary bg-secondary text-secondary-foreground'
                : 'border-input hover:bg-accent',
            )}
          >
            <input
              type="checkbox"
              name={name}
              value={option.value}
              checked={checked}
              onChange={() =>
                onChange(
                  checked ? value.filter((v) => v !== option.value) : [...value, option.value],
                )
              }
              className="sr-only"
            />
            <span
              aria-hidden
              className={cn(
                'flex size-6 shrink-0 items-center justify-center rounded-md border-2',
                checked ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
              )}
            >
              {checked && <Check className="size-4" strokeWidth={3} />}
            </span>
            {option.label}
          </label>
        );
      })}
    </div>
  );
}

/** − value + with direct entry; avoids the keyboard for most numeric answers. */
export function NumberStepper({
  id,
  value,
  onChange,
  min,
  max,
  step = 1,
  unit,
  decreaseLabel,
  increaseLabel,
  describedBy,
  invalid,
  onBlur,
}: {
  id: string;
  value: number | null;
  onChange: (value: number | null) => void;
  min?: number | undefined;
  max?: number | undefined;
  step?: number;
  unit?: { text: string; symbol: boolean } | null | undefined;
  decreaseLabel: string;
  increaseLabel: string;
  describedBy?: string | undefined;
  invalid?: boolean;
  onBlur?: () => void;
}) {
  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
  const start = value ?? min ?? 0;
  return (
    <div className="flex items-stretch gap-2">
      <button
        type="button"
        aria-label={decreaseLabel}
        aria-controls={id}
        onClick={() => onChange(clamp(value === null ? start : start - step))}
        className="flex size-14 shrink-0 items-center justify-center rounded-lg border-2 border-input bg-card hover:bg-accent"
      >
        <Minus aria-hidden className="size-6" />
      </button>
      <div className="relative flex-1">
        <input
          id={id}
          type="number"
          inputMode={step % 1 === 0 ? 'numeric' : 'decimal'}
          step={step}
          value={value ?? ''}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          onBlur={onBlur}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
          className={cn(
            'h-14 w-full rounded-lg border-2 border-input bg-card px-4 text-center text-2xl font-semibold tabular-nums text-foreground',
            unit && 'pr-16',
            invalid && 'border-status-failed',
          )}
        />
        {unit && (
          <span
            translate={unit.symbol ? 'no' : undefined}
            className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground"
          >
            {unit.text}
          </span>
        )}
      </div>
      <button
        type="button"
        aria-label={increaseLabel}
        aria-controls={id}
        onClick={() => onChange(clamp(value === null ? start : start + step))}
        className="flex size-14 shrink-0 items-center justify-center rounded-lg border-2 border-input bg-card hover:bg-accent"
      >
        <Plus aria-hidden className="size-6" />
      </button>
    </div>
  );
}

/** Yes / No as two big buttons (no tiny switches outdoors). */
export function YesNo({
  id,
  name,
  value,
  onChange,
  yesLabel,
  noLabel,
  describedBy,
}: {
  id?: string;
  name: string;
  value: boolean | null;
  onChange: (value: boolean) => void;
  yesLabel: string;
  noLabel: string;
  describedBy?: string | undefined;
}) {
  return (
    <ChoiceCards
      {...(id ? { id } : {})}
      name={name}
      describedBy={describedBy}
      options={[
        { value: 'yes', label: yesLabel },
        { value: 'no', label: noLabel },
      ]}
      value={value === null ? null : value ? 'yes' : 'no'}
      onChange={(v) => onChange(v === 'yes')}
    />
  );
}

/** MUAC tape colour bands (WHO cut-offs for 6–59 months) + exact mm entry. */
export function MuacInput({
  id,
  value,
  onChange,
  labels,
  describedBy,
  invalid,
}: {
  id: string;
  value: number | null;
  onChange: (value: number | null) => void;
  labels: { red: string; yellow: string; green: string; decrease: string; increase: string };
  describedBy?: string | undefined;
  invalid?: boolean;
}) {
  const band = value === null ? null : value < 115 ? 'red' : value < 125 ? 'yellow' : 'green';
  const bands = [
    { key: 'red', label: labels.red, preset: 110, className: 'bg-[#b42318] text-white' },
    { key: 'yellow', label: labels.yellow, preset: 120, className: 'bg-[#f5c518] text-black' },
    { key: 'green', label: labels.green, preset: 130, className: 'bg-[#1a7f37] text-white' },
  ] as const;
  const groupId = useId();
  return (
    <div className="flex flex-col gap-3">
      <div role="radiogroup" aria-labelledby={groupId} className="grid grid-cols-3 gap-2">
        <span id={groupId} className="sr-only">
          MUAC
        </span>
        {bands.map((b) => (
          <button
            key={b.key}
            type="button"
            role="radio"
            aria-checked={band === b.key}
            onClick={() => onChange(b.preset)}
            className={cn(
              'min-h-tap rounded-lg px-2 py-3 text-base font-bold ring-offset-2 ring-offset-background',
              b.className,
              band === b.key ? 'ring-4 ring-foreground' : 'opacity-100',
            )}
          >
            {b.label}
          </button>
        ))}
      </div>
      <NumberStepper
        id={id}
        value={value}
        onChange={onChange}
        min={80}
        max={200}
        unit={{ text: 'mm', symbol: true }}
        decreaseLabel={labels.decrease}
        increaseLabel={labels.increase}
        describedBy={describedBy}
        invalid={invalid ?? false}
      />
    </div>
  );
}
