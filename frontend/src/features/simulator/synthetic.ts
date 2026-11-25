/**
 * Obviously-fake valid payloads for the simulator burst generator. Mirrors
 * backend/fieldsync/demo/synthetic.py; output is validated before use.
 */
import { conditionHolds, iterFields, validate } from '@/core/validation/engine';
import type { FieldSpec, Payload, TemplateDefinition } from '@/core/validation/types';

const pick = <T>(items: T[]): T => items[Math.floor(Math.random() * items.length)] as T;
const int = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1));

function value(spec: FieldSpec, today: Date): Payload[string] {
  const rules = spec.rules ?? {};
  const day = (offset: number) =>
    new Date(today.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
  switch (spec.type) {
    case 'text':
      return rules.pattern?.startsWith('^HH-')
        ? `HH-${String(int(1, 9999)).padStart(4, '0')}-${String(int(1, 12)).padStart(2, '0')}`
        : pick(['Follow up next week', 'Caregiver counselled', 'Stable']);
    case 'phone':
      return `+2310000${String(int(10000, 99999))}`;
    case 'integer':
      return int(rules.min ?? 0, rules.max ?? 100);
    case 'decimal':
      return (
        Math.round(
          (rules.min ?? 0) * 10 + Math.random() * ((rules.max ?? 100) - (rules.min ?? 0)) * 10,
        ) / 10
      );
    case 'boolean':
      return Math.random() < 0.4;
    case 'select':
      return pick(spec.options ?? []).value;
    case 'multiselect':
      return Math.random() < 0.75 ? [] : [pick(spec.options ?? []).value];
    case 'date':
      return rules.futureOnly ? day(int(1, 14)) : day(-int(0, 20));
  }
}

export function syntheticPayload(definition: TemplateDefinition, now: Date): Payload {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const values: Payload = {};
    for (const spec of iterFields(definition)) {
      if (spec.showIf && !conditionHolds(spec.showIf, values as never)) continue;
      if (spec.required || Math.random() < 0.6) {
        const v = value(spec, now);
        if (v !== '' && !(Array.isArray(v) && v.length === 0)) values[spec.id] = v;
      }
    }
    for (const rule of definition.crossRules ?? []) {
      if (conditionHolds(rule.when, values as never) && !(rule.require in values))
        values[rule.require] = true;
    }
    const result = validate(definition, values, now);
    if (result.valid) return result.normalized;
  }
  throw new Error('Could not generate a valid synthetic payload');
}
