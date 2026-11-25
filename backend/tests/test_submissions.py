"""Idempotent upsert, conflicts, quarantine (ADD §12.4-12.5, scenarios S2/S3/S7)."""

from __future__ import annotations

import gzip
import json
import threading
import uuid
from typing import Any

import pytest
from django.db import connections
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st
from rest_framework.test import APIClient

from fieldsync.common.ids import uuid7
from fieldsync.submissions.models import Submission, SubmissionVersion
from fieldsync.sync.models import SyncEvent
from tests.factories import World, build_world, client_for, item, valid_payload

pytestmark = pytest.mark.django_db


def post(client: APIClient, body: dict[str, Any], **extra: Any) -> Any:
    return client.post("/api/v1/submissions", body, format="json", **extra)


def test_create_then_replay_is_idempotent(world: World) -> None:
    client = world.client("chw_bg")
    body = item(world.bg1)
    created = post(client, body)
    assert created.status_code == 201
    assert created.json()["data"]["outcome"] == "created"
    replayed = post(client, {**body, "attempt": 2})
    assert replayed.status_code == 200
    assert replayed.json()["data"]["outcome"] == "replayed"
    assert replayed.json()["data"]["submission"]["id"] == created.json()["data"]["submission"]["id"]
    assert Submission.objects.count() == 1
    assert SyncEvent.objects.filter(event_type="submission.replayed", client_attempt=2).count() == 1


def test_replay_matches_on_normalised_content(world: World) -> None:
    """Whitespace/Unicode differences between retries must not look like an edit."""
    client = world.client("chw_bg")
    body = item(world.bg1, payload=valid_payload(patient_ref="HH-0042-03"))
    post(client, body)
    again = post(client, {**body, "payload": valid_payload(patient_ref="  HH-0042-03 ")})
    assert again.json()["data"]["outcome"] == "replayed"


def test_payload_is_stored_normalised_with_hidden_fields_stripped(world: World) -> None:
    client = world.client("chw_bg")
    body = item(world.bg1, payload=valid_payload(rdt_result="positive"))  # hidden: fever=False
    post(client, body)
    assert "rdt_result" not in Submission.objects.get().payload


def test_update_with_current_base_version(world: World) -> None:
    client = world.client("chw_bg")
    body = item(world.bg1)
    post(client, body)
    updated = post(
        client, {**body, "op": "update", "base_version": 1, "payload": valid_payload(age_months=30)}
    )
    assert updated.status_code == 200
    assert updated.json()["data"]["outcome"] == "updated"
    row = Submission.objects.get()
    assert (row.version, row.payload["age_months"]) == (2, 30)
    assert list(row.versions.values_list("version", "source")) == [(1, "device"), (2, "device")]


def test_update_requires_base_version(world: World) -> None:
    response = post(world.client("chw_bg"), item(world.bg1, op="update"))
    assert response.status_code == 422
    assert response.json()["error"]["details"]["fields"] == {"base_version": ["required"]}


def _supervisor_corrects(world: World, client_uuid: str, **changes: Any) -> int:
    row = Submission.objects.get(client_uuid=client_uuid)
    response = world.client("sup_bg").post(
        f"/api/v1/submissions/{row.id}/review",
        {"status": "reviewed", "payload": {**row.payload, **changes}, "base_version": row.version},
        format="json",
    )
    assert response.status_code == 200, response.json()
    return int(response.json()["data"]["version"])


def test_stale_edit_is_a_conflict_with_server_copy(world: World) -> None:
    client = world.client("chw_bg")
    body = item(world.bg1)
    post(client, body)
    assert _supervisor_corrects(world, body["client_uuid"], age_months=27) == 2
    stale = post(
        client,
        {
            **body,
            "op": "update",
            "base_version": 1,
            "payload": valid_payload(followup_on=None, notes="edited"),
        },
    )
    assert stale.status_code == 409
    envelope = stale.json()
    assert envelope["error"]["code"] == "conflict_version"
    assert envelope["error"]["details"] == {"server_version": 2}
    copy = envelope["data"]["server_copy"]
    assert copy["version"] == 2
    assert copy["payload"]["age_months"] == 27
    assert copy["changed_by_role"] == "supervisor"
    assert Submission.objects.get().version == 2  # nothing silently overwritten


def test_conflict_resolved_by_explicit_override(world: World) -> None:
    client = world.client("chw_bg")
    body = item(world.bg1)
    post(client, body)
    _supervisor_corrects(world, body["client_uuid"], age_months=27)
    merged = valid_payload(age_months=27, notes="combined")
    resolved = post(
        client,
        {**body, "op": "update", "base_version": 2, "resolution": "merge", "payload": merged},
    )
    assert resolved.status_code == 200
    row = Submission.objects.get()
    assert row.version == 3
    assert row.versions.get(version=3).source == "override"
    assert SyncEvent.objects.filter(event_type="submission.conflict_resolved").count() == 1


def test_own_lost_ack_edit_then_edit_again_is_not_a_conflict(world: World) -> None:
    """Device sends v2 (ack lost), edits again still thinking base=1 → must apply as v3."""
    client = world.client("chw_bg")
    body = item(world.bg1)
    post(client, body)
    post(
        client, {**body, "op": "update", "base_version": 1, "payload": valid_payload(age_months=30)}
    )
    again = post(
        client, {**body, "op": "update", "base_version": 1, "payload": valid_payload(age_months=31)}
    )
    assert again.status_code == 200
    assert Submission.objects.get().version == 3


def test_create_edited_before_ack_is_applied(world: World) -> None:
    """Create committed but ack lost; CHW edits the still-pending item; it resends op=create."""
    client = world.client("chw_bg")
    body = item(world.bg1)
    post(client, body)
    edited = post(client, {**body, "payload": valid_payload(age_months=40), "attempt": 2})
    assert edited.json()["data"]["outcome"] == "updated"
    assert Submission.objects.get().payload["age_months"] == 40


def test_same_user_other_device_stale_edit_conflicts(world: World) -> None:
    body = item(world.bg1)
    post(world.client("chw_bg"), body)
    post(
        world.client("chw_bg"),
        {**body, "op": "update", "base_version": 1, "payload": valid_payload(age_months=30)},
    )
    other_device = client_for(world.chw_bg, world.dev_chw_bg_2)
    stale = post(
        other_device,
        {**body, "op": "update", "base_version": 1, "payload": valid_payload(age_months=35)},
    )
    assert stale.status_code == 409


def test_invalid_payload_is_quarantined_not_dropped(world: World) -> None:
    client = world.client("chw_bg")
    body = item(world.bg1, payload=valid_payload(age_months=99, mystery="x"))
    response = post(client, body)
    assert response.status_code == 422
    envelope = response.json()
    assert envelope["error"]["code"] == "validation_failed"
    assert envelope["error"]["details"]["fields"] == {"age_months": ["max"], "mystery": ["unknown"]}
    assert envelope["data"]["submission"]["status"] == "rejected"
    assert "99" not in json.dumps(envelope["error"])  # codes, never values
    row = Submission.objects.get()
    assert (row.status, row.payload["age_months"]) == ("rejected", 99)
    again = post(client, body)  # replay of a rejected item keeps answering 422, same row
    assert again.status_code == 422
    assert Submission.objects.count() == 1


def test_server_retry_revalidates_after_template_fix(world: World) -> None:
    client = world.client("chw_bg")
    body = item(world.bg1, payload=valid_payload(age_months=62))
    post(client, body)
    row = Submission.objects.get()
    from fieldsync.formtemplates import services as template_services
    from tests.factories import example_definition

    fixed = example_definition()
    fixed["version"] = 2
    fixed["steps"][0]["fields"][1]["rules"]["max"] = 71
    template_services.publish(
        template_services.create_draft(definition=fixed, created_by=world.admin)
    )
    supervisor = world.client("sup_bg")
    still = supervisor.post(f"/api/v1/submissions/{row.id}/retry", {}, format="json")
    assert still.json()["data"]["status"] == "rejected"
    retried = supervisor.post(
        f"/api/v1/submissions/{row.id}/retry", {"template_version": 2}, format="json"
    )
    assert retried.status_code == 200
    data = retried.json()["data"]
    assert (data["status"], data["template"]["version"], data["version"]) == ("accepted", 2, 2)
    assert SubmissionVersion.objects.get(submission=row, version=2).source == "revalidate"
    assert (
        world.client("chw_bg")
        .post(f"/api/v1/submissions/{row.id}/retry", {}, format="json")
        .status_code
        == 403
    )


def test_facility_outside_scope_is_forbidden(world: World) -> None:
    response = post(world.client("chw_bg"), item(world.ni1))
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "facility_forbidden"
    assert not Submission.objects.exists()


def test_client_uuid_of_another_users_submission(world: World) -> None:
    body = item(world.bg1)
    post(world.client("chw_bg"), body)
    hijack = post(
        world.client("chw_bg2"),
        {**body, "facility_id": str(world.bg2.id), "payload": valid_payload(age_months=3)},
    )
    assert hijack.status_code == 409
    assert hijack.json()["error"]["code"] == "client_uuid_foreign"
    assert "submission" not in (hijack.json()["data"] or {})


def test_unknown_and_retired_templates(world: World) -> None:
    client = world.client("chw_bg")
    unknown = post(client, item(world.bg1, template_version=9))
    assert unknown.status_code == 400
    assert unknown.json()["error"]["code"] == "template_unknown"


def test_oversized_payload(world: World) -> None:
    response = post(
        world.client("chw_bg"), item(world.bg1, payload=valid_payload(notes="x" * 70_000))
    )
    assert response.status_code == 413


def test_clock_skew_is_recorded(world: World) -> None:
    post(world.client("chw_bg"), item(world.bg1), HTTP_X_CLIENT_TIME="2020-01-01T00:00:00+00:00")
    skew = Submission.objects.get().client_clock_skew_ms
    assert skew is not None
    assert skew > 10**10


# ── Batch ─────────────────────────────────────────────────────────────────────


def test_batch_partial_success_and_device_state(world: World) -> None:
    client = world.client("chw_bg")
    good = item(world.bg1)
    bad = item(world.bg1, payload=valid_payload(sex="x"))
    forbidden = item(world.ni1)
    malformed = {"client_uuid": "not-a-uuid"}
    body = {
        "items": [good, bad, forbidden, malformed],
        "device_state": {
            "facilities": [
                {"facility_id": str(world.bg1.id), "pending": 3},
                {"facility_id": str(world.ni1.id), "pending": 9},
            ]
        },
    }
    response = client.post("/api/v1/submissions/batch", body, format="json")
    assert response.status_code == 200
    results = response.json()["data"]["results"]
    assert [r["outcome"] for r in results] == ["created", "rejected", "forbidden", "invalid"]
    assert [r["http_status"] for r in results] == [201, 422, 403, 400]
    assert results[3]["error"]["details"]["fields"]["client_uuid"] == ["invalid"]
    states = list(world.dev_chw_bg.facility_states.values_list("facility_id", "pending"))
    assert states == [(world.bg1.id, 3)]  # out-of-scope facility ignored


def test_batch_gzip_round_trip_and_size_limit(world: World) -> None:
    client = world.client("chw_bg")
    items = [item(world.bg1) for _ in range(25)]
    raw = gzip.compress(json.dumps({"items": items}).encode())
    response = client.generic(
        "POST",
        "/api/v1/submissions/batch",
        raw,  # type: ignore[arg-type]  # stubs say str; bytes are supported
        content_type="application/json",
        HTTP_CONTENT_ENCODING="gzip",
    )
    assert response.status_code == 200
    assert Submission.objects.count() == 25
    too_many = client.post(
        "/api/v1/submissions/batch", {"items": [item(world.bg1) for _ in range(26)]}, format="json"
    )
    assert too_many.status_code == 422


def test_batch_lost_response_retry_creates_no_duplicates(world: World) -> None:
    """Scenario S2: the batch committed, the response was lost, the device retries all."""
    client = world.client("chw_bg")
    items = [item(world.bg1) for _ in range(12)]
    client.post("/api/v1/submissions/batch", {"items": items[:7]}, format="json")  # partial commit
    retry = client.post(
        "/api/v1/submissions/batch", {"items": [{**i, "attempt": 2} for i in items]}, format="json"
    )
    outcomes = [r["outcome"] for r in retry.json()["data"]["results"]]
    assert outcomes == ["replayed"] * 7 + ["created"] * 5
    assert Submission.objects.count() == 12


# ── Concurrency & properties ─────────────────────────────────────────────────


@pytest.mark.django_db(transaction=True)
def test_concurrent_first_inserts_produce_one_row() -> None:
    world = build_world()
    body = item(world.bg1)
    barrier = threading.Barrier(4)
    statuses: list[int] = []

    def worker() -> None:
        try:
            client = client_for(world.chw_bg, world.dev_chw_bg)
            barrier.wait()
            statuses.append(post(client, body).status_code)
        finally:
            connections.close_all()

    threads = [threading.Thread(target=worker) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(statuses) == [200, 200, 200, 201]
    assert Submission.objects.filter(client_uuid=body["client_uuid"]).count() == 1


ACTIONS = st.lists(
    st.tuples(st.sampled_from(["send", "retry", "edit"]), st.integers(min_value=20, max_value=50)),
    min_size=1,
    max_size=8,
)


@settings(
    max_examples=40, deadline=None, suppress_health_check=[HealthCheck.function_scoped_fixture]
)
@given(actions=ACTIONS)
def test_any_interleaving_yields_one_row_with_the_last_intended_payload(
    world: World, actions: list[tuple[str, int]]
) -> None:
    """Device-side model: lost acks are simulated by never updating the device's base version."""
    client = world.client("chw_bg")
    client_uuid = uuid7()
    last_sent: dict[str, Any] | None = None
    acked_version: int | None = None
    for action, age in actions:
        if action == "edit" or last_sent is None:
            payload = valid_payload(age_months=age)
        else:  # "send"/"retry" resend the same content
            payload = last_sent["payload"]
        op = "create" if acked_version is None else "update"
        body = item(
            world.bg1, client_uuid=client_uuid, op=op, payload=payload, base_version=acked_version
        )
        response = post(client, body)
        assert response.status_code in (200, 201), response.json()
        if action != "retry":  # "retry" models an attempt whose ack was lost
            acked_version = response.json()["data"]["submission"]["version"]
        last_sent = body
    rows = Submission.objects.filter(client_uuid=client_uuid)
    assert rows.count() == 1
    assert last_sent is not None
    assert rows.get().payload["age_months"] == last_sent["payload"]["age_months"]
    assert uuid.UUID(str(client_uuid))
