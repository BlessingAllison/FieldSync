"""The committed contracts/openapi.json must match what the code generates (run `make openapi`)."""

from __future__ import annotations

import json

from drf_spectacular.generators import SchemaGenerator

from tests.conftest import CONTRACTS


def test_openapi_contract_is_current() -> None:
    generated = SchemaGenerator().get_schema(request=None, public=True)
    committed = json.loads((CONTRACTS / "openapi.json").read_text(encoding="utf-8"))
    assert (
        json.loads(json.dumps(generated)) == committed
    ), "contracts/openapi.json is stale: run `make openapi`"


def test_envelope_components_are_published() -> None:
    schema = SchemaGenerator().get_schema(request=None, public=True)
    components = schema["components"]["schemas"]
    assert {"HealthLiveEnvelope", "HealthReadyEnvelope", "ErrorEnvelope"} <= set(components)
