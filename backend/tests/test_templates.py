from __future__ import annotations

import copy
from datetime import timedelta
from typing import Any

import pytest
from django.db import IntegrityError, connection, transaction
from django.utils import timezone
from freezegun import freeze_time

from fieldsync.common.errors import ApiError
from fieldsync.formtemplates import services
from fieldsync.formtemplates.models import FormTemplate, TemplateStatus
from tests.factories import World, example_definition

pytestmark = pytest.mark.django_db


def _v(version: int, **changes: Any) -> dict[str, Any]:
    definition = copy.deepcopy(example_definition())
    definition["version"] = version
    definition.update(changes)
    return definition


@pytest.mark.parametrize(
    ("mutate", "problem"),
    [
        (
            lambda d: d["steps"][0]["fields"].append(copy.deepcopy(d["steps"][0]["fields"][0])),
            "duplicate field id",
        ),
        (
            lambda d: d["steps"][0]["fields"][1].setdefault("rules", {}).update(pattern="^a$"),
            "not valid for integer",
        ),
        (
            lambda d: d["steps"][1]["fields"][2].update(
                showIf={"field": "referred", "equals": True}
            ),
            "earlier field",
        ),
        (lambda d: d["steps"][0]["fields"][1]["rules"].update(min=60), "min > max"),
        (lambda d: d["crossRules"][0].update(require="nope"), "unknown 'require'"),
    ],
)
def test_semantic_problems_are_reported(mutate: Any, problem: str) -> None:
    definition = example_definition()
    mutate(definition)
    assert any(problem in p for p in services.definition_problems(definition))


def test_examples_have_no_problems() -> None:
    assert services.definition_problems(example_definition()) == []
    assert services.definition_problems(example_definition("facility-stock-report.v1.json")) == []


def test_publish_supersedes_with_grace_window(world: World) -> None:
    v2 = services.publish(services.create_draft(definition=_v(2), created_by=world.admin))
    v1 = FormTemplate.objects.get(code="iccm-child-u5", version=1)
    assert v2.status == TemplateStatus.PUBLISHED
    assert v1.status == TemplateStatus.SUPERSEDED
    assert v1.accept_until is not None
    assert v1.accept_until - timezone.now() > timedelta(days=29)
    assert services.resolve_for_submission("iccm-child-u5", 1) == v1
    with freeze_time(timezone.now() + timedelta(days=31)), pytest.raises(ApiError) as exc:
        services.resolve_for_submission("iccm-child-u5", 1)
    assert exc.value.code == "template_retired"


def test_resolution_is_cached_per_process_and_invalidated_by_lifecycle_changes(
    world: World, django_assert_num_queries: Any
) -> None:
    services.resolve_for_submission("iccm-child-u5", 1)  # warm
    with django_assert_num_queries(0):
        assert services.resolve_for_submission("iccm-child-u5", 1) == world.template
    services.retire(world.template)
    # Re-read at once in this process (within its grace window it still resolves, retired).
    with django_assert_num_queries(1):
        resolved = services.resolve_for_submission("iccm-child-u5", 1)
    assert resolved.status == TemplateStatus.RETIRED
    assert resolved.accept_until is not None


def test_drafts_are_never_cached(world: World) -> None:
    draft = services.create_draft(definition=_v(2), created_by=world.admin)
    with pytest.raises(ApiError):
        services.resolve_for_submission("iccm-child-u5", 2)
    services.publish(draft)
    assert services.resolve_for_submission("iccm-child-u5", 2).status == TemplateStatus.PUBLISHED


def test_published_definition_is_immutable_at_the_database(world: World) -> None:
    with pytest.raises(IntegrityError), transaction.atomic(), connection.cursor() as cursor:
        cursor.execute(
            "UPDATE form_templates SET definition = '{}'::jsonb WHERE id = %s", [world.template.id]
        )
    with pytest.raises(ApiError):
        services.update_draft(world.template, definition=example_definition())


def test_api_lists_accepting_versions_with_etag(world: World) -> None:
    client = world.client("chw_bg")
    first = client.get("/api/v1/form-templates")
    assert first.status_code == 200
    assert [t["code"] for t in first.json()["data"]] == ["iccm-child-u5"]
    etag = first["ETag"]
    again = client.get("/api/v1/form-templates", HTTP_IF_NONE_MATCH=etag)
    assert again.status_code == 304
    assert again.content == b""


def test_only_admins_manage_templates(world: World) -> None:
    body = {"definition": _v(5)}
    assert (
        world.client("sup_bg").post("/api/v1/form-templates", body, format="json").status_code
        == 403
    )
    created = world.client("admin").post("/api/v1/form-templates", body, format="json")
    assert created.status_code == 201
    template_id = created.json()["data"]["id"]
    published = world.client("admin").post(f"/api/v1/form-templates/{template_id}/publish")
    assert published.json()["data"]["status"] == "published"


def test_invalid_definition_returns_paths_not_crash(world: World) -> None:
    body = {"definition": {"code": "x"}}
    response = world.client("admin").post("/api/v1/form-templates", body, format="json")
    assert response.status_code == 422
    assert response.json()["error"]["details"]["definition"]


def test_form_builder_endpoints_are_admin_only(world: World) -> None:
    body = {"definition": _v(2)}
    for who in ("chw_bg", "sup_bg"):
        client = world.client(who)
        assert client.get("/api/v1/form-templates/manage").status_code == 403
        assert (
            client.post("/api/v1/form-templates/validate", body, format="json").status_code == 403
        )
        assert client.get(f"/api/v1/form-templates/{world.template.id}").status_code == 403


def test_form_builder_lists_every_version_with_usage_and_validates_without_saving(
    world: World,
) -> None:
    admin = world.client("admin")
    bad = _v(2)
    bad["steps"][0]["fields"][0]["label"] = {}
    dry = admin.post("/api/v1/form-templates/validate", {"definition": bad}, format="json")
    assert dry.status_code == 200
    result = dry.json()["data"]
    assert result["valid"] is False
    assert any("'en' is required" in p for p in result["problems"])
    ok = admin.post("/api/v1/form-templates/validate", {"definition": _v(2)}, format="json")
    assert ok.json()["data"] == {"valid": True, "problems": []}
    assert not FormTemplate.objects.filter(version=2).exists()  # a dry run stores nothing

    draft = admin.post("/api/v1/form-templates", {"definition": _v(2)}, format="json").json()[
        "data"
    ]
    rows = admin.get("/api/v1/form-templates/manage").json()["data"]
    versions = [
        (r["code"], r["version"], r["status"]) for r in rows if r["code"] == "iccm-child-u5"
    ]
    assert versions == [("iccm-child-u5", 2, "draft"), ("iccm-child-u5", 1, "published")]
    assert all("submission_count" in r and "created_at" in r for r in rows)
    detail = admin.get(f"/api/v1/form-templates/{draft['id']}").json()["data"]
    assert detail["status"] == "draft"
    assert detail["definition"]["version"] == 2


def test_only_drafts_can_be_deleted(world: World) -> None:
    admin = world.client("admin")
    draft = admin.post("/api/v1/form-templates", {"definition": _v(2)}, format="json").json()[
        "data"
    ]
    refused = admin.delete(f"/api/v1/form-templates/{world.template.id}")
    assert refused.status_code == 403
    deleted = admin.delete(f"/api/v1/form-templates/{draft['id']}")
    assert deleted.status_code == 200
    assert deleted.json()["data"] == {"id": draft["id"], "deleted": True}
    assert not FormTemplate.objects.filter(id=draft["id"]).exists()
    assert admin.get(f"/api/v1/form-templates/{draft['id']}").status_code == 404
