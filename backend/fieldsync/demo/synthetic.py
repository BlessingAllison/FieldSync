"""Synthetic, obviously-fake payloads that satisfy a template (seed data and load tests).

No names, no real identifiers: patient refs are ``HH-####-##`` household codes and phone
numbers use a fixed fake prefix.
"""

from __future__ import annotations

import random
from datetime import date, datetime, timedelta
from typing import Any

from fieldsync.formtemplates.validation import condition_holds, iter_fields, validate

FAKE_PHONE_PREFIX = "+2310000"


def _value(spec: dict[str, Any], rng: random.Random, today: date) -> Any:  # noqa: PLR0911
    rules = spec.get("rules", {})
    kind = spec["type"]
    if kind == "text":
        if rules.get("pattern", "").startswith("^HH-"):
            return f"HH-{rng.randint(1, 9999):04d}-{rng.randint(1, 12):02d}"
        return rng.choice(["Follow up next week", "Caregiver counselled", "Stable"])
    if kind == "phone":
        return FAKE_PHONE_PREFIX + "".join(str(rng.randint(0, 9)) for _ in range(5))
    if kind == "integer":
        low, high = int(rules.get("min", 0)), int(rules.get("max", 100))
        return rng.randint(low, high)
    if kind == "decimal":
        low_f, high_f = float(rules.get("min", 0)), float(rules.get("max", 100))
        return round(rng.uniform(low_f, high_f), 1)
    if kind == "boolean":
        return rng.random() < 0.4
    if kind == "select":
        return rng.choice(spec["options"])["value"]
    if kind == "multiselect":
        options = [o["value"] for o in spec["options"]]
        low = int(rules.get("minSelected", 0))
        high = min(int(rules.get("maxSelected", len(options))), len(options))
        count = max(low, 0 if rng.random() < 0.75 else rng.randint(1, max(1, high)))
        return rng.sample(options, min(count, high))
    if kind == "date":
        if rules.get("futureOnly"):
            return (today + timedelta(days=rng.randint(1, 14))).isoformat()
        return (today - timedelta(days=rng.randint(0, 20))).isoformat()
    raise ValueError(kind)


def payload_for(definition: dict[str, Any], rng: random.Random, now: datetime) -> dict[str, Any]:
    today = now.date()
    for _ in range(25):
        values: dict[str, Any] = {}
        for spec in iter_fields(definition):
            condition = spec.get("showIf")
            if condition and not condition_holds(condition, values):
                continue
            if spec.get("required") or rng.random() < 0.6:
                value = _value(spec, rng, today)
                if value not in (None, "", []):
                    values[spec["id"]] = value
        for rule in definition.get("crossRules", []):
            if condition_holds(rule["when"], values) and rule["require"] not in values:
                values[rule["require"]] = True
        result = validate(definition, values, now)
        if result.valid:
            return result.normalized
    raise RuntimeError(f"could not synthesise a valid payload for {definition.get('code')}")
