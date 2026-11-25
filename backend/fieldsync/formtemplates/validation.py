"""Form validation engine — Python twin of ``frontend/src/core/validation``.

Implements the normative semantics in ``contracts/README.md`` and must produce exactly
the results recorded in ``contracts/validation-cases.json`` (tests/test_validation_conformance.py).
Error lists contain rule *codes* only — never values.
"""

from __future__ import annotations

import math
import re
import unicodedata
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Final

RULE_ORDER: Final = (
    "min",
    "max",
    "minLength",
    "maxLength",
    "pattern",
    "minSelected",
    "maxSelected",
    "pastOnly",
    "futureOnly",
)
PHONE_RE: Final = re.compile(r"^\+?[0-9]{7,15}$")
PHONE_STRIP_RE: Final = re.compile(r"[\s\-.()]")
DATE_RE: Final = re.compile(r"^\d{4}-\d{2}-\d{2}$")


@dataclass(frozen=True, slots=True)
class ValidationResult:
    valid: bool
    errors: dict[str, list[str]] = field(default_factory=dict)
    normalized: dict[str, Any] = field(default_factory=dict)


def iter_fields(definition: dict[str, Any]) -> list[dict[str, Any]]:
    return [f for step in definition.get("steps", []) for f in step.get("fields", [])]


def _is_number(value: Any) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool)


def strict_equal(a: Any, b: Any) -> bool:
    """JavaScript ``===`` semantics for JSON scalars (True != 1, 24 == 24.0)."""
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if _is_number(a) and _is_number(b):
        return bool(a == b)
    return type(a) is type(b) and a == b


def _normalize(field_type: str, value: Any) -> Any:
    if isinstance(value, str):
        value = unicodedata.normalize("NFC", value).strip()
        if field_type == "phone":
            value = PHONE_STRIP_RE.sub("", value)
    return value


def _is_empty(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return value == ""
    if isinstance(value, list):
        return len(value) == 0
    return False


def _parse_date(value: str) -> date | None:
    if not DATE_RE.match(value):
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def _type_error(spec: dict[str, Any], value: Any) -> str | None:  # noqa: PLR0911
    field_type = spec["type"]
    options = {o["value"] for o in spec.get("options", [])}
    if field_type in {"text", "phone"}:
        return None if isinstance(value, str) else "type"
    if field_type == "integer":
        ok = _is_number(value) and math.isfinite(value) and float(value).is_integer()
        return None if ok else "type"
    if field_type == "decimal":
        return None if _is_number(value) and math.isfinite(value) else "type"
    if field_type == "boolean":
        return None if isinstance(value, bool) else "type"
    if field_type == "select":
        if not isinstance(value, str):
            return "type"
        return None if value in options else "option"
    if field_type == "multiselect":
        if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
            return "type"
        if len(set(value)) != len(value):
            return "type"
        return None if all(v in options for v in value) else "option"
    if field_type == "date":
        return None if isinstance(value, str) and _parse_date(value) else "type"
    return "type"


def _rule_errors(spec: dict[str, Any], value: Any, today: date) -> list[str]:  # noqa: PLR0912
    rules: dict[str, Any] = spec.get("rules", {})
    field_type = spec["type"]
    failed: set[str] = set()
    if field_type in {"integer", "decimal"}:
        if "min" in rules and value < rules["min"]:
            failed.add("min")
        if "max" in rules and value > rules["max"]:
            failed.add("max")
    if field_type in {"text", "phone"}:
        length = len(value)  # Python str length = Unicode code points (contract §7)
        if "minLength" in rules and length < rules["minLength"]:
            failed.add("minLength")
        if "maxLength" in rules and length > rules["maxLength"]:
            failed.add("maxLength")
        if "pattern" in rules and not re.search(rules["pattern"], value):
            failed.add("pattern")
        if field_type == "phone" and not PHONE_RE.match(value):
            failed.add("pattern")
    if field_type == "multiselect":
        if "minSelected" in rules and len(value) < rules["minSelected"]:
            failed.add("minSelected")
        if "maxSelected" in rules and len(value) > rules["maxSelected"]:
            failed.add("maxSelected")
    if field_type == "date":
        parsed = _parse_date(value)
        if parsed is not None:
            if rules.get("pastOnly") and parsed > today:
                failed.add("pastOnly")
            if rules.get("futureOnly") and parsed < today:
                failed.add("futureOnly")
    return [code for code in RULE_ORDER if code in failed]


def condition_holds(condition: dict[str, Any], values: dict[str, Any]) -> bool:
    ref = condition["field"]
    if ref not in values:
        return False
    value = values[ref]
    if "equals" in condition:
        return strict_equal(value, condition["equals"])
    if "in" in condition:
        return any(strict_equal(value, candidate) for candidate in condition["in"])
    if condition.get("notEmpty"):
        return not _is_empty(value)
    return False


def validate(
    definition: dict[str, Any], payload: dict[str, Any], now: datetime
) -> ValidationResult:
    fields = iter_fields(definition)
    known = {spec["id"] for spec in fields}
    today = now.date()
    errors: dict[str, list[str]] = {}
    for key in payload:
        if key not in known:
            errors[key] = ["unknown"]

    values: dict[str, Any] = {}
    for spec in fields:
        field_id = spec["id"]
        condition = spec.get("showIf")
        if condition is not None and not condition_holds(condition, values):
            continue  # hidden: stripped, rules not evaluated
        value = _normalize(spec["type"], payload.get(field_id))
        if _is_empty(value):
            if spec.get("required"):
                errors[field_id] = ["required"]
            continue
        type_error = _type_error(spec, value)
        if type_error:
            errors[field_id] = [type_error]
            continue
        if spec["type"] == "integer" and isinstance(value, float):
            value = int(value)
        values[field_id] = value
        rule_errors = _rule_errors(spec, value, today)
        if rule_errors:
            errors[field_id] = rule_errors

    for rule in definition.get("crossRules", []):
        if condition_holds(rule["when"], values) and rule["require"] not in values:
            errors.setdefault(rule["require"], []).append(f"rule:{rule['id']}")

    return ValidationResult(valid=not errors, errors=errors, normalized=values)
