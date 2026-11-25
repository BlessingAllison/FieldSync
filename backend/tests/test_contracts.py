from __future__ import annotations

import copy
from typing import Any

import pytest
from jsonschema import Draft202012Validator

from fieldsync.common.errors import DEFAULT_MESSAGE, HTTP_STATUS, ErrorCode
from tests.conftest import CONTRACTS, load_contract


@pytest.fixture(scope="module")
def template_validator() -> Draft202012Validator:
    schema = load_contract("form-template.schema.json")
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


def test_error_codes_match_contract() -> None:
    contract = load_contract("error-codes.json")
    expected = {entry["code"]: entry["http"] for entry in contract["codes"]}
    assert {code.value for code in ErrorCode} == set(expected)
    assert {code.value: status for code, status in HTTP_STATUS.items()} == expected
    assert set(DEFAULT_MESSAGE) == set(ErrorCode)
    classes = set(contract["classes"])
    assert all(entry["class"] in classes for entry in contract["codes"])


@pytest.mark.parametrize(
    "path", sorted((CONTRACTS / "examples").glob("*.json")), ids=lambda p: p.name
)
def test_example_templates_are_valid(template_validator: Draft202012Validator, path: Any) -> None:
    errors = list(template_validator.iter_errors(load_contract(f"examples/{path.name}")))
    assert errors == []


def test_fixture_templates_are_valid(template_validator: Draft202012Validator) -> None:
    fixtures = load_contract("validation-cases.json")
    for template in fixtures["templates"].values():
        assert list(template_validator.iter_errors(template)) == []
    ids = [case["id"] for case in fixtures["cases"]]
    assert len(ids) == len(set(ids))
    assert all(case["template"] in fixtures["templates"] for case in fixtures["cases"])


def _example() -> dict[str, Any]:
    return copy.deepcopy(load_contract("examples/iccm-child-u5.v1.json"))


@pytest.mark.parametrize(
    "pattern",
    [
        "(a+)+$",  # not anchored
        "^(a+)+$",  # quantified group (catastrophic backtracking)
        "^(?=a)a$",  # lookahead
        "^(a)\\1$",  # backreference
        "^" + "a" * 130 + "$",  # too long
    ],
)
def test_unsafe_patterns_are_rejected(
    template_validator: Draft202012Validator, pattern: str
) -> None:
    template = _example()
    template["steps"][0]["fields"][0]["rules"]["pattern"] = pattern
    assert not template_validator.is_valid(template)


def test_select_requires_options_and_others_forbid_them(
    template_validator: Draft202012Validator,
) -> None:
    template = _example()
    del template["steps"][0]["fields"][2]["options"]  # "sex" select
    assert not template_validator.is_valid(template)
    template = _example()
    template["steps"][0]["fields"][1]["options"] = [{"value": "a"}, {"value": "b"}]  # integer
    assert not template_validator.is_valid(template)


def test_unknown_locale_key_is_rejected(template_validator: Draft202012Validator) -> None:
    template = _example()
    template["title"]["fr"] = "Visite"
    assert not template_validator.is_valid(template)
