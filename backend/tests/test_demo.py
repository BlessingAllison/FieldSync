from __future__ import annotations

from io import StringIO

import pytest
from django.core.management import call_command

from fieldsync.accounts.models import User
from fieldsync.accounts.scope import scope_for
from fieldsync.submissions.models import Submission
from fieldsync.sync.services import sync_status
from tests.factories import World, item

pytestmark = pytest.mark.django_db


def test_fault_injection_is_inert_outside_demo_mode(world: World, settings: object) -> None:
    client = world.client("chw_bg")
    response = client.post(
        "/api/v1/submissions", item(world.bg1), format="json", HTTP_X_FS_SIMULATE="503"
    )
    assert response.status_code == 201


@pytest.mark.parametrize(("fault", "status", "retry_after"), [("503", 503, "3"), ("429", 429, "2")])
def test_fault_injection_in_demo_mode(
    world: World, settings: object, fault: str, status: int, retry_after: str
) -> None:
    settings.FIELDSYNC_DEMO_MODE = True  # type: ignore[attr-defined]
    response = world.client("chw_bg").post(
        "/api/v1/submissions/batch",
        {"items": [item(world.bg1)]},
        format="json",
        HTTP_X_FS_SIMULATE=fault,
    )
    assert response.status_code == status
    assert response["Retry-After"] == retry_after
    assert not Submission.objects.exists()


def test_supervisor_edit_creates_a_conflict_for_the_device(world: World, settings: object) -> None:
    settings.FIELDSYNC_DEMO_MODE = True  # type: ignore[attr-defined]
    client = world.client("chw_bg")
    body = item(world.bg1)
    client.post("/api/v1/submissions", body, format="json")
    edit = client.post(f"/api/v1/demo/supervisor-edit/{body['client_uuid']}")
    assert edit.status_code == 200
    assert edit.json()["data"]["version"] == 2
    stale = client.post(
        "/api/v1/submissions",
        {**body, "op": "update", "base_version": 1, "payload": {**body["payload"], "notes": "x"}},
        format="json",
    )
    assert stale.status_code == 409
    settings.FIELDSYNC_DEMO_MODE = False  # type: ignore[attr-defined]
    assert client.post(f"/api/v1/demo/supervisor-edit/{body['client_uuid']}").status_code == 404


def test_seed_is_idempotent_and_covers_every_health_state() -> None:
    out = StringIO()
    call_command("seed_demo", "--password", "demo-password-123", stdout=out)
    call_command("seed_demo", "--password", "demo-password-123", stdout=StringIO())
    assert "chw.bong.1" in out.getvalue()
    assert "demo-password-123" not in out.getvalue()
    assert User.objects.filter(username__startswith="chw.").count() == 3
    supervisor = User.objects.get(username="supervisor.bong")
    assert supervisor.check_password("demo-password-123")
    health = {f["code"]: f["health"] for f in sync_status(scope_for(supervisor))["facilities"]}
    assert health["BG-HC-001"] == "healthy"
    assert health["BG-CL-002"] == "degraded"
    assert health["BG-CP-003"] == "stale"
    assert "unknown" in health.values()


def test_reseeding_days_later_keeps_the_demo_scenario_and_can_drop_throwaway_reports(
    world: World,
) -> None:
    from datetime import timedelta

    from django.utils import timezone
    from freezegun import freeze_time

    from fieldsync.sync.models import DeviceFacilityState

    call_command("seed_demo", "--password", "demo-password-123", stdout=StringIO())
    supervisor = User.objects.get(username="supervisor.bong")
    # A throwaway E2E "phone" left a stale queue report behind.
    DeviceFacilityState.objects.create(
        device=world.dev_chw_bg, facility=world.bg1, pending=1, reported_at=timezone.now()
    )
    with freeze_time(timezone.now() + timedelta(days=4)):
        call_command(
            "seed_demo",
            "--password",
            "demo-password-123",
            "--reset-device-states",
            stdout=StringIO(),
        )
        health = {f["code"]: f["health"] for f in sync_status(scope_for(supervisor))["facilities"]}
        assert health["BG-CL-002"] == "degraded"  # was "stale" before the states were refreshed
        assert health["BG-CP-003"] == "stale"
    assert not DeviceFacilityState.objects.filter(device=world.dev_chw_bg).exists()


def test_seed_random_passwords_are_printed_once() -> None:
    out = StringIO()
    call_command("seed_demo", "--no-history", stdout=out)
    lines = [line for line in out.getvalue().splitlines() if line.startswith("| `")]
    assert len(lines) == 6
    assert all(line.count("`") >= 4 for line in lines)
