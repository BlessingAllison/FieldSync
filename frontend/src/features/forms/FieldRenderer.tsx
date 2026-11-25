/**
 * Renders one template field with the field-team widgets. Shared by the form runner and the
 * admin form builder's preview, so admins see exactly what CHWs will see.
 */
import type { FieldSpec, FieldValue } from '@/core/validation/types';
import { useT } from '@/i18n';
import { tx, unitText } from '@/lib/template-text';
import {
  ChoiceCards,
  FieldShell,
  MultiCards,
  MuacInput,
  NumberStepper,
  TextArea,
  TextInput,
  YesNo,
} from '@/ui/form-controls';

const today = () => new Date().toISOString().slice(0, 10);

export function FieldRenderer({
  spec,
  value,
  error,
  onChange,
  onBlur,
}: {
  spec: FieldSpec;
  value: FieldValue;
  error: string | undefined;
  onChange: (value: FieldValue) => void;
  onBlur: () => void;
}) {
  const { t, locale } = useT();
  const id = `field-${spec.id}`;
  const label = tx(spec.label, locale);
  const help = spec.help ? tx(spec.help, locale) : undefined;
  const describedBy = error ? `${id}-error` : help ? `${id}-help` : undefined;
  const options = (spec.options ?? []).map((o) => ({
    value: o.value,
    label: o.label ? tx(o.label, locale) : o.value,
  }));
  const common = {
    id,
    label,
    help,
    error,
    required: spec.required,
    requiredLabel: t('common.required'),
  };
  const numeric = typeof value === 'number' ? value : null;

  switch (spec.type) {
    case 'boolean':
      return (
        <FieldShell {...common} as="fieldset">
          <YesNo
            id={id}
            name={id}
            value={typeof value === 'boolean' ? value : null}
            onChange={(v) => {
              onChange(v);
              onBlur();
            }}
            yesLabel={t('common.yes')}
            noLabel={t('common.no')}
            describedBy={describedBy}
          />
        </FieldShell>
      );
    case 'select':
      if (options.length > 8) {
        return (
          <FieldShell {...common}>
            <select
              id={id}
              value={typeof value === 'string' ? value : ''}
              aria-describedby={describedBy}
              aria-invalid={Boolean(error) || undefined}
              onBlur={onBlur}
              onChange={(e) => onChange(e.target.value || null)}
              className="min-h-tap w-full rounded-lg border-2 border-input bg-card px-4 text-lg"
            >
              <option value="">{t('form.selectPlaceholder')}</option>
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </FieldShell>
        );
      }
      return (
        <FieldShell {...common} as="fieldset">
          <ChoiceCards
            id={id}
            name={id}
            options={options}
            value={typeof value === 'string' ? value : null}
            onChange={(v) => {
              onChange(v);
              onBlur();
            }}
            describedBy={describedBy}
          />
        </FieldShell>
      );
    case 'multiselect':
      return (
        <FieldShell {...common} as="fieldset">
          <MultiCards
            id={id}
            name={id}
            options={options}
            value={Array.isArray(value) ? value : []}
            onChange={(v) => {
              onChange(v);
              onBlur();
            }}
            describedBy={describedBy}
          />
        </FieldShell>
      );
    case 'integer':
    case 'decimal':
      if (spec.widget === 'muac') {
        return (
          <FieldShell {...common}>
            <MuacInput
              id={id}
              value={numeric}
              onChange={(v) => onChange(v)}
              describedBy={describedBy}
              invalid={Boolean(error)}
              labels={{
                red: t('form.muac.red'),
                yellow: t('form.muac.yellow'),
                green: t('form.muac.green'),
                decrease: t('common.decrease'),
                increase: t('common.increase'),
              }}
            />
          </FieldShell>
        );
      }
      return (
        <FieldShell {...common}>
          <NumberStepper
            id={id}
            value={numeric}
            onChange={(v) => onChange(v)}
            onBlur={onBlur}
            min={spec.rules?.min}
            max={spec.rules?.max}
            step={spec.type === 'decimal' ? 0.1 : 1}
            unit={unitText(spec.unit, locale)}
            decreaseLabel={`${t('common.decrease')}: ${label}`}
            increaseLabel={`${t('common.increase')}: ${label}`}
            describedBy={describedBy}
            invalid={Boolean(error)}
          />
        </FieldShell>
      );
    case 'date':
      return (
        <FieldShell {...common}>
          <TextInput
            id={id}
            type="date"
            value={typeof value === 'string' ? value : ''}
            max={spec.rules?.pastOnly ? today() : undefined}
            min={spec.rules?.futureOnly ? today() : undefined}
            onChange={(e) => onChange(e.target.value || null)}
            onBlur={onBlur}
            aria-describedby={describedBy}
            invalid={Boolean(error)}
          />
        </FieldShell>
      );
    case 'phone':
      return (
        <FieldShell {...common}>
          <TextInput
            id={id}
            type="tel"
            inputMode="tel"
            autoComplete="off"
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
            onBlur={onBlur}
            aria-describedby={describedBy}
            invalid={Boolean(error)}
          />
        </FieldShell>
      );
    case 'text':
      return (
        <FieldShell {...common}>
          {spec.widget === 'textarea' ? (
            <TextArea
              id={id}
              value={typeof value === 'string' ? value : ''}
              maxLength={spec.rules?.maxLength}
              onChange={(e) => onChange(e.target.value)}
              onBlur={onBlur}
              aria-describedby={describedBy}
              invalid={Boolean(error)}
            />
          ) : (
            <TextInput
              id={id}
              autoComplete="off"
              autoCapitalize={spec.rules?.pattern ? 'characters' : 'sentences'}
              spellCheck={false}
              value={typeof value === 'string' ? value : ''}
              maxLength={spec.rules?.maxLength}
              onChange={(e) => onChange(e.target.value)}
              onBlur={onBlur}
              aria-describedby={describedBy}
              invalid={Boolean(error)}
            />
          )}
        </FieldShell>
      );
  }
}
