from __future__ import annotations

import json
from pathlib import Path
from typing import TYPE_CHECKING, Any

import pytest
from rest_framework.test import APIClient

REPO_ROOT = Path(__file__).resolve().parents[2]
CONTRACTS = REPO_ROOT / "contracts"


def load_contract(name: str) -> Any:
    return json.loads((CONTRACTS / name).read_text(encoding="utf-8"))


@pytest.fixture(autouse=True)
def _clear_throttle_cache() -> None:
    """Throttle counters live in the local-memory cache; never let them leak across tests."""
    from django.core.cache import cache

    from fieldsync.formtemplates.services import clear_resolution_cache
    from fieldsync.sync.metrics import reset_cache as reset_sync_metrics_cache

    cache.clear()
    reset_sync_metrics_cache()
    # Each test rolls its rows back; a cached template would point at a vanished row.
    clear_resolution_cache()


@pytest.fixture
def client() -> APIClient:
    return APIClient()


@pytest.fixture
def world(db: None) -> World:
    from tests.factories import build_world

    return build_world()


if TYPE_CHECKING:
    from tests.factories import World
