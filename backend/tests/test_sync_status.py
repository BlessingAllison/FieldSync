from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest
from django.utils import timezone

from fieldsync.sync.models import DeviceFacilityState
from fieldsync.sync.services import Thresholds, classify
from tests.factories import World, item

pytestmark = pytest.mark.django_db

NOW = timezone.now()
T = Thresholds(timedelta(hours=24), timedelta(hours=72), 0.8)


def _row(**overrides: Any) -> dict[str, Any]:
    row = {
        "last_success_at": NOW - timedelta(hours=1),
        "oldest_pending_at": None,
        "pending_on_devices": 0,
        "devices_active": 1,
        "failed": 0,
        "conflicts": 0,
        "stuck": 0,
        "rejected_open": 0,
        "first_attempt_success_7d": 0.95,
    }
    row.update(overrides)
    return row


@pytest.mark.parametrize(
    ("overrides", "health", "reasons"),
    [
        ({}, "healthy", []),
        ({"last_success_at": None, "devices_active": 0}, "unknown", ["never_synced"]),
        ({"last_success_at": NOW - timedelta(hours=80)}, "stale", ["no_sync_72h"]),
        (
            {"oldest_pending_at": NOW - timedelta(hours=73), "pending_on_devices": 4},
            "stale",
            ["oldest_pending_72h"],
        ),
        ({"last_success_at": NOW - timedelta(hours=30)}, "degraded", ["no_sync_24h"]),
        ({"conflicts": 1, "stuck": 2}, "degraded", ["conflicts", "stuck_items"]),
        ({"rejected_open": 1}, "degraded", ["rejected_open"]),
        ({"first_attempt_success_7d": 0.5}, "degraded", ["low_first_attempt_success"]),
        ({"last_success_at": None, "devices_active": 1}, "unknown", ["never_synced"]),
        ({"last_success_at": None, "pending_on_devices": 3}, "degraded", ["never_synced"]),
        (
            {
                "last_success_at": None,
                "pending_on_devices": 3,
                "oldest_pending_at": NOW - timedelta(hours=80),
            },
            "stale",
            ["oldest_pending_72h"],
        ),
    ],
)
def test_classification_rules(overrides: dict[str, Any], health: str, reasons: list[str]) -> None:
    assert classify(_row(**overrides), NOW, T) == (health, reasons)


def test_heartbeat_and_aggregation(world: World) -> None:
    chw = world.client("chw_bg")
    for attempt in (1, 1, 3):
        chw.post("/api/v1/submissions", item(world.bg1, attempt=attempt), format="json")
    old = (timezone.now() - timedelta(hours=5)).isoformat()
    beat = chw.post(
        "/api/v1/sync/heartbeat",
        {
            "facilities": [
                {
                    "facility_id": str(world.bg1.id),
                    "pending": 4,
                    "conflicts": 1,
                    "oldest_pending_at": old,
                }
            ]
        },
        format="json",
    )
    assert beat.json()["data"] == {"facilities_applied": 1}

    status = world.client("sup_bg").get("/api/v1/submissions/sync-status").json()["data"]
    by_code = {f["code"]: f for f in status["facilities"]}
    assert set(by_code) == {"BG-1", "BG-2"}
    bg1 = by_code["BG-1"]
    assert bg1["health"] == "degraded"
    assert bg1["reasons"] == ["conflicts", "low_first_attempt_success"]
    assert bg1["pending_on_devices"] == 4
    assert bg1["submissions_24h"] == 3
    assert bg1["first_attempt_success_7d"] == pytest.approx(0.667, abs=0.001)
    assert bg1["mean_attempts_7d"] == pytest.approx(1.67, abs=0.01)
    assert by_code["BG-2"]["health"] == "unknown"
    summary = status["summary"]
    assert (summary["facilities"], summary["degraded"], summary["unknown"]) == (2, 1, 1)
    assert summary["pending_on_devices"] == 4


def test_revoked_devices_drop_out_of_queue_totals(world: World) -> None:
    DeviceFacilityState.objects.create(
        device=world.dev_chw_bg, facility=world.bg1, pending=10, reported_at=timezone.now()
    )
    world.dev_chw_bg.revoked_at = timezone.now()
    world.dev_chw_bg.save()
    status = world.client("sup_bg").get("/api/v1/submissions/sync-status").json()["data"]
    assert status["summary"]["pending_on_devices"] == 0


def test_chw_sees_own_device_queues_only(world: World) -> None:
    DeviceFacilityState.objects.create(
        device=world.dev_sup_bg, facility=world.bg1, pending=7, reported_at=timezone.now()
    )
    DeviceFacilityState.objects.create(
        device=world.dev_chw_bg, facility=world.bg1, pending=2, reported_at=timezone.now()
    )
    chw_view = world.client("chw_bg").get("/api/v1/submissions/sync-status").json()["data"]
    assert chw_view["summary"]["pending_on_devices"] == 2
    sup_view = world.client("sup_bg").get("/api/v1/submissions/sync-status").json()["data"]
    assert sup_view["summary"]["pending_on_devices"] == 9


def test_admin_county_filter(world: World) -> None:
    status = world.client("admin").get("/api/v1/submissions/sync-status?county=NI").json()["data"]
    assert [f["code"] for f in status["facilities"]] == ["NI-1"]
