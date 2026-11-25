import { describe, expect, it } from 'vitest';

import type { TemplateDefinition } from '@/core/validation/types';

import {
  asCopy,
  asNewVersion,
  changeType,
  cleanRules,
  describeProblem,
  earlierFields,
  emptyDefinition,
  move,
  newField,
  nextVersion,
  optionValue,
  repairReferences,
  slugCode,
  slugId,
  toPayload,
  uniqueId,
} from './builder-model';

const ID = /^[a-z][a-z0-9_]{0,47}$/;
const CODE = /^[a-z][a-z0-9-]{1,62}[a-z0-9]$/;

function sample(): TemplateDefinition {
  return {
    code: 'malaria-case',
    version: 1,
    subject: 'patient',
    title: { en: 'Malaria case' },
    steps: [
      {
        id: 'step_1',
        title: { en: 'Visit' },
        fields: [
          { id: 'fever', type: 'boolean', label: { en: 'Fever?' } },
          {
            id: 'rdt',
            type: 'select',
            label: { en: 'RDT result' },
            options: [{ value: 'pos' }, { value: 'neg' }],
            showIf: { field: 'fever', equals: true },
          },
        ],
      },
    ],
    crossRules: [
      { id: 'need_rdt', when: { field: 'fever', equals: true }, require: 'rdt', message: { en: 'x' } },
    ],
  };
}

describe('form builder model', () => {
  it('generates valid, unique ids and codes from any label', () => {
    expect(slugId('Danger signs (any)')).toBe('danger_signs_any');
    expect(slugId('2nd visit')).toMatch(ID);
    expect(slugId('Température °C')).toBe('temperature_c');
    expect(slugId('!!!')).toMatch(ID);
    expect(slugId('x'.repeat(80))).toHaveLength(48);
    expect(slugCode('Malaria case report')).toBe('malaria-case-report');
    expect(slugCode('1 form')).toMatch(CODE);
    expect(slugCode('a')).toMatch(CODE);
    expect(uniqueId('age', ['age', 'age_2'])).toBe('age_3');
    expect(optionValue('Positive (+)', ['positive'])).toBe('positive_2');
  });

  it('new forms and fields are valid by construction', () => {
    const def = emptyDefinition('Malaria case report', 'patient');
    expect(def.code).toBe('malaria-case-report');
    expect(def.steps[0]?.fields).toHaveLength(1);
    const choice = newField('select', 'Result', ['result']);
    expect(choice.id).toBe('result_2');
    expect(choice.options).toHaveLength(2);
    expect(newField('boolean', 'Fever', []).options).toBeUndefined();
  });

  it('changing a type keeps what still applies and drops what does not', () => {
    const field = {
      ...newField('integer', 'Age', []),
      required: true,
      unit: { en: 'months' },
      rules: { min: 2, max: 59 },
      widget: 'stepper' as const,
    };
    const asText = changeType(field, 'text');
    expect(asText).toEqual({ id: 'age', type: 'text', label: { en: 'Age' }, required: true });
    const asDecimal = changeType(field, 'decimal');
    expect(asDecimal.rules).toEqual({ min: 2, max: 59 });
    expect(asDecimal.unit).toEqual({ en: 'months' });
    expect(asDecimal.widget).toBeUndefined(); // stepper is integer-only
    expect(changeType(field, 'multiselect').options).toHaveLength(2);
    expect(cleanRules('date', { pastOnly: true, min: 3 })).toEqual({ pastOnly: true });
    expect(cleanRules('boolean', { min: 1 })).toBeUndefined();
  });

  it('conditions can only point backwards; moving a field repairs broken references', () => {
    const def = sample();
    expect(earlierFields(def, 'rdt').map((f) => f.id)).toEqual(['fever']);
    expect(earlierFields(def, 'fever')).toEqual([]);
    const step = def.steps[0]!;
    const swapped = { ...def, steps: [{ ...step, fields: move(step.fields, 1, 0) }] };
    const repaired = repairReferences(swapped);
    expect(repaired.steps[0]?.fields[0]).not.toHaveProperty('showIf');
    expect(repaired.crossRules).toHaveLength(1); // order does not matter for cross rules
    const removed = repairReferences({
      ...def,
      steps: [{ ...step, fields: step.fields.filter((f) => f.id !== 'fever') }],
    });
    expect(removed.steps[0]?.fields[0]).not.toHaveProperty('showIf');
    expect(removed.crossRules).toBeUndefined(); // its 'when' field is gone
  });

  it('versions and copies', () => {
    const existing = [
      { code: 'malaria-case', version: 1 },
      { code: 'malaria-case', version: 2 },
      { code: 'other', version: 7 },
    ];
    expect(nextVersion(existing, 'malaria-case')).toBe(3);
    expect(nextVersion(existing, 'new-form')).toBe(1);
    const next = asNewVersion(sample(), existing);
    expect(next.version).toBe(3);
    expect(next.code).toBe('malaria-case');
    const copy = asCopy(sample(), 'Malaria case', ['malaria-case']);
    expect(copy).toMatchObject({ code: 'malaria-case-2', version: 1, title: { en: 'Malaria case' } });
    expect(toPayload({ ...sample(), crossRules: undefined })).not.toHaveProperty('crossRules');
  });

  it('server problems are located in words', () => {
    expect(describeProblem(sample(), "steps/0/fields/1/label: 'en' is required", 'Step')).toBe(
      "Step 1 › RDT result (label): 'en' is required",
    );
    expect(describeProblem(sample(), 'rdt: duplicate field id')).toBe('rdt: duplicate field id');
  });
});
