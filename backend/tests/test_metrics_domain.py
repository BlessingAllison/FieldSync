"""Domain metrics (ADD §15.3) and sync-event retention."""

from __future__ import annotations

import re
from datetime import timedelta
from io import StringIO
from typing import Any

import pytest
from django.core.management import call_command
from django.utils import timezone

from fieldsync.sync.metrics import reset_cache as reset_sync_metrics_cache
from fieldsync.sync.models import DeviceFacilityState, SyncEvent, SyncEventType
from tests.factories import World, item, valid_payload

pytestmark = pytest.mark.django_db


def _metric(text: str, name: str, labels: str = "") -> float:
    pattern = rf"^{re.escape(name)}{re.escape(labels)} ([0-9.e+-]+)$"
    match = re.search(pattern, text, re.MULTILINE)
    return float(match.group(1)) if match else 0.0


def _scrape(world: World) -> str:
    content: bytes = world.client("admin").get("/api/v1/metrics").content
    return content.decode()


def test_upsert_outcomes_duplicates_and_attempts_are_counted(world: World) -> None:
    before = _scrape(world)
    client = world.client("chw_bg")
    body = item(world.bg1, attempt=1)
    client.post("/api/v1/submissions", body, format="json")
    client.post("/api/v1/submissions", {**body, "attempt": 3}, format="json")  # lost-ack resend
    after = _scrape(world)

    created = '{op="create",outcome="created"}'
    replayed = '{op="create",outcome="replayed"}'
    assert (
        _metric(after, "fieldsync_submission_upserts_total", created)
        - _metric(before, "fieldsync_submission_upserts_total", created)
        == 1
    )
    assert (
        _metric(after, "fieldsync_submission_upserts_total", replayed)
        - _metric(before, "fieldsync_submission_upserts_total", replayed)
        == 1
    )
    assert (
        _metric(after, "fieldsync_duplicates_prevented_total")
        - _metric(before, "fieldsync_duplicates_prevented_total")
        == 1
    )
    # attempt 3 lands in the le=3.0 bucket for replays
    bucket = '{le="3.0",outcome="replayed"}'
    assert (
        _metric(after, "fieldsync_client_attempts_bucket", bucket)
        - _metric(before, "fieldsync_client_attempts_bucket", bucket)
        == 1
    )


def test_conflicts_detected_and_resolved_are_counted(world: World) -> None:
    client = world.client("chw_bg")
    body = item(world.bg1)
    client.post("/api/v1/submissions", body, format="json")
    row_id = client.get("/api/v1/submissions").json()["data"][0]["id"]
    world.client("sup_bg").post(
        f"/api/v1/submissions/{row_id}/review",
        {"status": "reviewed", "payload": valid_payload(age_months=27), "base_version": 1},
        format="json",
    )
    before = _scrape(world)
    client.post(
        "/api/v1/submissions",
        {**body, "op": "update", "base_version": 1, "payload": valid_payload(notes="x")},
        format="json",
    )
    client.post(
        "/api/v1/submissions",
        {
            **body,
            "op": "update",
            "base_version": 2,
            "resolution": "merge",
            "payload": valid_payload(age_months=27, notes="x"),
        },
        format="json",
    )
    after = _scrape(world)
    for label in ('{resolution="detected"}', '{resolution="merge"}'):
        assert (
            _metric(after, "fieldsync_conflicts_total", label)
            - _metric(before, "fieldsync_conflicts_total", label)
            == 1
        )


def test_scrape_time_gauges_follow_the_dashboard_semantics(world: World) -> None:
    DeviceFacilityState.objects.create(
        device=world.dev_chw_bg, facility=world.bg1, pending=7, stuck=2, reported_at=timezone.now()
    )
    world.client("chw_bg").post("/api/v1/submissions", item(world.bg1, attempt=1), format="json")
    text = _scrape(world)
    assert _metric(text, "fieldsync_queue_depth_reported", '{county="BG"}') == 7
    assert _metric(text, "fieldsync_stuck_items_reported", '{county="BG"}') == 2
    assert _metric(text, "fieldsync_sync_success_ratio", '{county="BG"}') == 1.0
    assert _metric(text, "fieldsync_facilities", '{health="unknown"}') >= 1
    assert "facility" not in re.sub(r"fieldsync_facilities\{", "", text)  # no per-facility labels


def test_scrape_time_gauges_are_memoised_between_scrapes(
    world: World, django_assert_max_num_queries: Any
) -> None:
    state = DeviceFacilityState.objects.create(
        device=world.dev_chw_bg, facility=world.bg1, pending=3, reported_at=timezone.now()
    )
    assert _metric(_scrape(world), "fieldsync_queue_depth_reported", '{county="BG"}') == 3
    DeviceFacilityState.objects.filter(pk=state.pk).update(pending=9)
    with django_assert_max_num_queries(4):  # auth only; no aggregation queries
        cached = _scrape(world)
    assert _metric(cached, "fieldsync_queue_depth_reported", '{county="BG"}') == 3
    reset_sync_metrics_cache()  # i.e. the TTL elapsed
    assert _metric(_scrape(world), "fieldsync_queue_depth_reported", '{county="BG"}') == 9


def test_prune_sync_events_respects_the_window(world: World) -> None:
    old = SyncEvent.objects.create(event_type=SyncEventType.DEVICE_HEARTBEAT, request_id=None)
    SyncEvent.objects.filter(pk=old.pk).update(occurred_at=timezone.now() - timedelta(days=200))
    recent = SyncEvent.objects.create(event_type=SyncEventType.DEVICE_HEARTBEAT, request_id=None)
    dry = StringIO()
    call_command("prune_sync_events", "--dry-run", stdout=dry)
    assert "would delete 1" in dry.getvalue()
    assert SyncEvent.objects.filter(pk=old.pk).exists()
    call_command("prune_sync_events", "--chunk", "1", stdout=StringIO())
    assert not SyncEvent.objects.filter(pk=old.pk).exists()
    assert SyncEvent.objects.filter(pk=recent.pk).exists()
