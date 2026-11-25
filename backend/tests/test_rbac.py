"""Endpoint x role x scope matrix (ADD §11.3). Out-of-scope objects are 404, not 403."""

from __future__ import annotations

from typing import Any

import pytest

from fieldsync.submissions.models import Submission
from tests.factories import World, item

pytestmark = pytest.mark.django_db

ROLES = ["chw_bg", "chw_bg2", "sup_bg", "chw_ni", "admin"]


@pytest.fixture
def seeded(world: World) -> dict[str, Any]:
    """One submission per CHW so ownership and county boundaries are observable."""
    ids = {}
    for who, facility in (("chw_bg", world.bg1), ("chw_bg2", world.bg2), ("chw_ni", world.ni1)):
        response = world.client(who).post("/api/v1/submissions", item(facility), format="json")
        ids[who] = response.json()["data"]["submission"]["id"]
    return ids


EXPECTED_FACILITIES = {
    "chw_bg": {"BG-1"},
    "chw_bg2": {"BG-2"},
    "sup_bg": {"BG-1", "BG-2"},
    "chw_ni": {"NI-1"},
    "admin": {"BG-1", "BG-2", "NI-1"},
}
EXPECTED_SUBMISSIONS = {  # whose submissions each role can read
    "chw_bg": {"chw_bg"},
    "chw_bg2": {"chw_bg2"},
    "sup_bg": {"chw_bg", "chw_bg2"},
    "chw_ni": {"chw_ni"},
    "admin": {"chw_bg", "chw_bg2", "chw_ni"},
}


@pytest.mark.parametrize("who", ROLES)
def test_facility_list_is_scoped(world: World, who: str) -> None:
    data = world.client(who).get("/api/v1/facilities").json()["data"]
    assert {f["code"] for f in data} == EXPECTED_FACILITIES[who]


@pytest.mark.parametrize("who", ROLES)
def test_submission_list_and_detail_are_scoped(
    world: World, seeded: dict[str, str], who: str
) -> None:
    client = world.client(who)
    listed = {s["id"] for s in client.get("/api/v1/submissions").json()["data"]}
    visible = {seeded[owner] for owner in EXPECTED_SUBMISSIONS[who]}
    assert listed == visible
    for owner, submission_id in seeded.items():
        status = client.get(f"/api/v1/submissions/{submission_id}").status_code
        assert status == (200 if owner in EXPECTED_SUBMISSIONS[who] else 404), (who, owner)


@pytest.mark.parametrize(
    ("who", "status"), [("chw_bg", 403), ("sup_bg", 200), ("chw_ni", 403), ("admin", 200)]
)
def test_review_requires_supervisor_or_admin(
    world: World, seeded: dict[str, str], who: str, status: int
) -> None:
    response = world.client(who).post(
        f"/api/v1/submissions/{seeded['chw_bg']}/review", {"status": "flagged"}, format="json"
    )
    assert response.status_code == status


def test_supervisor_cannot_review_other_county(world: World, seeded: dict[str, str]) -> None:
    response = world.client("sup_bg").post(
        f"/api/v1/submissions/{seeded['chw_ni']}/review", {"status": "flagged"}, format="json"
    )
    assert response.status_code == 404


def test_status_only_review_does_not_bump_version(world: World, seeded: dict[str, str]) -> None:
    world.client("sup_bg").post(
        f"/api/v1/submissions/{seeded['chw_bg']}/review",
        {"status": "flagged", "note": "check"},
        format="json",
    )
    row = Submission.objects.get(id=seeded["chw_bg"])
    assert (row.status, row.version) == ("flagged", 1)


def test_supervisor_can_submit_for_county_facility(world: World) -> None:
    assert (
        world.client("sup_bg")
        .post("/api/v1/submissions", item(world.bg2), format="json")
        .status_code
        == 201
    )
    assert (
        world.client("sup_bg")
        .post("/api/v1/submissions", item(world.ni1), format="json")
        .status_code
        == 403
    )


def test_keyset_pagination(world: World) -> None:
    client = world.client("chw_bg")
    for _ in range(5):
        client.post("/api/v1/submissions", item(world.bg1), format="json")
    first = client.get("/api/v1/submissions?limit=2").json()
    cursor = first["meta"]["pagination"]["next_cursor"]
    second = client.get(f"/api/v1/submissions?limit=2&cursor={cursor}").json()
    third = client.get(
        f"/api/v1/submissions?limit=2&cursor={second['meta']['pagination']['next_cursor']}"
    ).json()
    ids = [s["id"] for page in (first, second, third) for s in page["data"]]
    assert len(ids) == len(set(ids)) == 5
    assert third["meta"]["pagination"]["next_cursor"] is None
    assert client.get("/api/v1/submissions?cursor=%%%").status_code == 400


def test_versions_endpoint_is_reviewer_only(world: World, seeded: dict[str, str]) -> None:
    assert (
        world.client("chw_bg").get(f"/api/v1/submissions/{seeded['chw_bg']}/versions").status_code
        == 403
    )
    versions = (
        world.client("sup_bg")
        .get(f"/api/v1/submissions/{seeded['chw_bg']}/versions")
        .json()["data"]
    )
    assert [v["version"] for v in versions] == [1]


@pytest.mark.parametrize(("who", "expected"), [("chw_bg", 2), ("sup_bg", 4), ("admin", 6)])
def test_device_list_is_scoped(world: World, who: str, expected: int) -> None:
    # chw_bg owns 2 devices; Bong scope = chw_bg (2) + chw_bg2 (1) + sup_bg (1).
    assert len(world.client(who).get("/api/v1/devices").json()["data"]) == expected


def test_device_revocation_scope(world: World) -> None:
    other_county = world.client("sup_bg").post(
        f"/api/v1/devices/{world.dev_chw_ni.id}/revoke", {"reason": "lost"}, format="json"
    )
    assert other_county.status_code == 404
    ok = world.client("sup_bg").post(
        f"/api/v1/devices/{world.dev_chw_bg2.id}/revoke", {"reason": "lost"}, format="json"
    )
    assert ok.status_code == 200
    assert ok.json()["data"]["revoked_at"] is not None
    assert (
        world.client("chw_bg2").get("/api/v1/facilities").json()["error"]["code"]
        == "device_revoked"
    )
    chw = world.client("chw_bg").post(
        f"/api/v1/devices/{world.dev_chw_bg.id}/revoke", {"reason": "x"}, format="json"
    )
    assert chw.status_code == 403


def test_anonymous_is_refused_everywhere_except_public(world: World) -> None:
    from rest_framework.test import APIClient

    anon = APIClient()
    for path in (
        "/api/v1/facilities",
        "/api/v1/submissions",
        "/api/v1/form-templates",
        "/api/v1/auth/me",
    ):
        response = anon.get(path)
        assert response.status_code == 401, path
        assert response.json()["error"]["code"] == "token_invalid"
    assert anon.get("/api/v1/health/live").status_code == 200
