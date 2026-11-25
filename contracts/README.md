# Contracts

Files in this directory are the **single source of truth** shared by the Django API and the PWA.
CI checks both sides against them, so if one side drifts from these files the build fails.

| File | Consumed by | Drift check |
|---|---|---|
| `error-codes.json` | `backend/fieldsync/common/errors.py` (enum + HTTP map), `frontend/src/core/contracts/error-codes.gen.ts` (generated) | `backend/tests/test_contracts.py`; `npm run contracts:check` |
| `openapi.json` | Generated **from** the backend (`make openapi`); the frontend generates `src/core/api/schema.gen.d.ts` from it | `backend/tests/test_openapi.py`; `npm run contracts:check` |
| `form-template.schema.json` | Backend template service (create/publish validation) | `backend/tests/test_contracts.py` validates every example and fixture template |
| `validation-cases.json` | Both validation engines (Phase 3) | Conformance tests on both sides |
| `examples/*.json` | Seed data, docs, tests | Validated against the meta-schema |

## Error classes

Each error code has a `class` that tells the sync engine which state a queued item moves to
(ADD §10.2 and §12.2): `permanent` → FAILED, `transient` → RETRY_WAIT, `auth` → refresh or pause
(the attempt is not counted), `conflict` → CONFLICT, `revoked` → crypto-shred.

## Validation semantics (normative)

Both engines implement `validate(template, input, now) → { valid, errors, normalized }`.

1. **Unknown keys.** Any input key that is not a field id produces `["unknown"]` for that key.
2. **Normalisation**, applied before any rule:
   - Strings are converted to Unicode NFC and trimmed.
   - Phone values also have spaces, hyphens, dots and parentheses removed.
3. **Empty values.** `null`, a missing key, `""` after trimming, and `[]` are all *empty*.
   `false` and `0` are *not* empty. Empty values are left out of `normalized`.
4. **Visibility.** A field with `showIf` is visible only when its condition holds against the
   **normalized** value of the referenced field:
   - `equals` uses strict equality.
   - `in` means the value is a member of the list.
   - `notEmpty` means the value is present and not empty.

   Hidden fields are removed from `normalized` and their rules are not evaluated. A `showIf` may
   only reference a field declared earlier in the template; the template service enforces this.
5. **Required.** A visible, required, empty field gives `["required"]` and no other checks run.
   A field that is not required and is empty produces no errors.
6. **Type.** A wrong type gives `["type"]` and no other checks run. There is no coercion.
   - `text`: string.
   - `phone`: string. After normalisation it must match `^\+?[0-9]{7,15}$`, otherwise `["pattern"]`.
   - `integer`: JSON number with an integral value (`24.0` counts as 24).
   - `decimal`: finite JSON number.
   - `boolean`: `true` or `false`.
   - `select`: string. If it is not one of the options, the error is `["option"]` and no other
     checks run.
   - `multiselect`: array of unique strings. Duplicates give `["type"]`; a value not in the
     options gives `["option"]`.
   - `date`: `YYYY-MM-DD` that is a real calendar date, otherwise `["type"]`.
7. **Rules.** Every applicable rule is evaluated and failures are reported in this **canonical
   order**: `min`, `max`, `minLength`, `maxLength`, `pattern`, `minSelected`, `maxSelected`,
   `pastOnly`, `futureOnly`.
   - String length counts **Unicode code points**. In JS that means `[...s].length`, not `s.length`.
   - `pastOnly` means the date ≤ today and `futureOnly` means the date ≥ today, where "today" is
     the UTC date of `now`.
8. **Cross rules.** When `when` holds and the `require` field is empty, `"rule:<id>"` is appended
   to that field's errors, after any rule errors.
9. **Patterns.** Patterns are restricted by the meta-schema to a safe subset:
   - anchored with `^…$`;
   - no backreferences;
   - no `(?…)` groups;
   - no quantified groups;
   - at most 128 characters.

   This subset behaves the same in ECMAScript and Python `re`.

## Template text and units

All human-readable template text (`title`, `description`, `label`, `help`, option labels,
cross-rule messages) is an i18n map. `unit` is either an i18n map (unit *words*: "months",
"doses") or a bare string, which means a language-neutral *symbol* ("mm", "°C") that is
rendered untranslated.

