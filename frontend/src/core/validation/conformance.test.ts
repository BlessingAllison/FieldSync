import { describe, expect, it } from 'vitest';

import fixtures from '../../../../contracts/validation-cases.json';
import { validate } from './engine';
import type { Payload, TemplateDefinition } from './types';

const NOW = new Date(fixtures.now);

describe('validation conformance (contracts/validation-cases.json)', () => {
  for (const testCase of fixtures.cases) {
    it(testCase.id, () => {
      const template = fixtures.templates[
        testCase.template as keyof typeof fixtures.templates
      ] as unknown as TemplateDefinition;
      const result = validate(template, testCase.input as Payload, NOW);
      const expected = testCase.expect as {
        valid: boolean;
        errors: Record<string, string[]>;
        normalized?: unknown;
      };
      expect(result.errors).toEqual(expected.errors);
      expect(result.valid).toBe(expected.valid);
      if (expected.normalized !== undefined) expect(result.normalized).toEqual(expected.normalized);
    });
  }
});
