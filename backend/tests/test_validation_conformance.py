"""The Python engine must reproduce contracts/validation-cases.json exactly."""

from __future__ import annotations

from datetime import datetime
from typing import Any

import pytest

from fieldsync.formtemplates.validation import strict_equal, validate
from tests.conftest import load_contract

FIXTURES = load_contract("validation-cases.json")
NOW = datetime.fromisoformat(FIXTURES["now"].replace("Z", "+00:00"))


@pytest.mark.parametrize("case", FIXTURES["cases"], ids=lambda c: c["id"])
def test_conformance(case: dict[str, Any]) -> None:
    template = FIXTURES["templates"][case["template"]]
    result = validate(template, case["input"], NOW)
    expected = case["expect"]
    assert result.errors == expected["errors"]
    assert result.valid is expected["valid"]
    if "normalized" in expected:
        assert result.normalized == expected["normalized"]


@pytest.mark.parametrize(
    ("a", "b", "equal"),
    [(True, 1, False), (24, 24.0, True), ("1", 1, False), (False, False, True), ("f", "f", True)],
)
def test_strict_equal_matches_javascript(a: Any, b: Any, equal: bool) -> None:
    assert strict_equal(a, b) is equal
