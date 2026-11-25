"""Template lifecycle and definition checks (ADD §13)."""

from __future__ import annotations

import hashlib
import json
import re
import threading
import time
from datetime import timedelta
from functools import cache
from typing import Any

from django.conf import settings
from django.db import transaction
from django.utils import timezone
from jsonschema import Draft202012Validator

from fieldsync.accounts.models import User
from fieldsync.common.errors import ApiError, ErrorCode
from fieldsync.formtemplates.models import FormTemplate, TemplateStatus
from fieldsync.formtemplates.validation import iter_fields

RULES_BY_TYPE: dict[str, set[str]] = {
    "text": {"minLength", "maxLength", "pattern"},
    "phone": {"minLength", "maxLength", "pattern"},
    "integer": {"min", "max"},
    "decimal": {"min", "max"},
    "boolean": set(),
    "select": set(),
    "multiselect": {"minSelected", "maxSelected"},
    "date": {"pastOnly", "futureOnly"},
}


def canonical_json(value: Any) -> str:
    """Deterministic JSON used for hashing (sorted keys, no whitespace, UTF-8)."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_hex(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


@cache
def _meta_validator() -> Draft202012Validator:
    path = settings.FIELDSYNC_CONTRACTS_DIR / "form-template.schema.json"
    schema = json.loads(path.read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


def definition_problems(definition: Any) -> list[str]:  # noqa: PLR0912
    """Every reason a definition cannot be stored. Empty list = valid.

    Messages contain JSON paths and identifiers only (definitions are not PHI, but the
    convention keeps one error style across the API).
    """
    problems = [
        f"{'/'.join(str(p) for p in error.absolute_path) or '<root>'}: {error.validator}"
        for error in _meta_validator().iter_errors(definition)
    ]
    if problems:
        return problems

    step_ids = [step["id"] for step in definition["steps"]]
    if len(step_ids) != len(set(step_ids)):
        problems.append("steps: duplicate step id")
    seen: set[str] = set()
    for spec in iter_fields(definition):
        field_id = spec["id"]
        if field_id in seen:
            problems.append(f"{field_id}: duplicate field id")
        condition = spec.get("showIf")
        if condition and condition["field"] not in seen:
            problems.append(f"{field_id}: showIf must reference an earlier field")
        seen.add(field_id)
        rules = set(spec.get("rules", {}))
        invalid_rules = rules - RULES_BY_TYPE[spec["type"]]
        if invalid_rules:
            problems.append(
                f"{field_id}: rules {sorted(invalid_rules)} not valid for {spec['type']}"
            )
        rule_values = spec.get("rules", {})
        for low, high in (
            ("min", "max"),
            ("minLength", "maxLength"),
            ("minSelected", "maxSelected"),
        ):
            if low in rule_values and high in rule_values and rule_values[low] > rule_values[high]:
                problems.append(f"{field_id}: {low} > {high}")
        if "pattern" in rule_values:
            try:
                re.compile(rule_values["pattern"])
            except re.error:
                problems.append(f"{field_id}: pattern does not compile")
        options = [o["value"] for o in spec.get("options", [])]
        if len(options) != len(set(options)):
            problems.append(f"{field_id}: duplicate option value")
    for rule in definition.get("crossRules", []):
        if rule["when"]["field"] not in seen:
            problems.append(f"crossRules/{rule['id']}: unknown 'when' field")
        if rule["require"] not in seen:
            problems.append(f"crossRules/{rule['id']}: unknown 'require' field")
    return problems


def _assert_valid(definition: Any) -> None:
    problems = definition_problems(definition)
    if problems:
        raise ApiError(
            ErrorCode.VALIDATION_FAILED,
            "The template definition is not valid.",
            details={"definition": problems},
        )


def create_draft(*, definition: dict[str, Any], created_by: User) -> FormTemplate:
    _assert_valid(definition)
    code, version = definition["code"], definition["version"]
    if FormTemplate.objects.filter(code=code, version=version).exists():
        raise ApiError(ErrorCode.MALFORMED_REQUEST, "This template code and version already exist.")
    return FormTemplate.objects.create(
        code=code,
        version=version,
        subject=definition["subject"],
        title=definition["title"],
        description=definition.get("description", {}),
        definition=definition,
        definition_hash=sha256_hex(definition),
        status=TemplateStatus.DRAFT,
        created_by=created_by,
    )


def update_draft(template: FormTemplate, *, definition: dict[str, Any]) -> FormTemplate:
    if template.status != TemplateStatus.DRAFT:
        raise ApiError(ErrorCode.PERMISSION_DENIED, "Published templates are immutable.")
    _assert_valid(definition)
    if (definition["code"], definition["version"]) != (template.code, template.version):
        raise ApiError(ErrorCode.MALFORMED_REQUEST, "code and version cannot change.")
    template.subject = definition["subject"]
    template.title = definition["title"]
    template.description = definition.get("description", {})
    template.definition = definition
    template.definition_hash = sha256_hex(definition)
    template.save()
    return template


@transaction.atomic
def publish(template: FormTemplate) -> FormTemplate:
    """Publish a draft; the current published version becomes superseded with a grace window."""
    locked = FormTemplate.objects.select_for_update().get(pk=template.pk)
    if locked.status != TemplateStatus.DRAFT:
        raise ApiError(ErrorCode.MALFORMED_REQUEST, "Only drafts can be published.")
    now = timezone.now()
    grace = timedelta(days=settings.TEMPLATE_ACCEPT_GRACE_DAYS)
    FormTemplate.objects.select_for_update().filter(
        code=locked.code, status=TemplateStatus.PUBLISHED
    ).update(status=TemplateStatus.SUPERSEDED, superseded_at=now, accept_until=now + grace)
    locked.status = TemplateStatus.PUBLISHED
    locked.published_at = now
    locked.accept_until = None
    locked.save(update_fields=["status", "published_at", "accept_until"])
    _invalidate_resolution_cache()
    return locked


@transaction.atomic
def retire(template: FormTemplate) -> FormTemplate:
    locked = FormTemplate.objects.select_for_update().get(pk=template.pk)
    if locked.status not in {TemplateStatus.PUBLISHED, TemplateStatus.SUPERSEDED}:
        raise ApiError(
            ErrorCode.MALFORMED_REQUEST, "Only published or superseded templates retire."
        )
    now = timezone.now()
    grace = timedelta(days=settings.TEMPLATE_ACCEPT_GRACE_DAYS)
    locked.status = TemplateStatus.RETIRED
    locked.retired_at = now
    locked.accept_until = min(locked.accept_until or now + grace, now + grace)
    locked.save(update_fields=["status", "retired_at", "accept_until"])
    _invalidate_resolution_cache()
    return locked


def accepting_templates() -> Any:
    """Published versions plus superseded/retired ones still inside their grace window."""
    now = timezone.now()
    return FormTemplate.objects.filter(
        status=TemplateStatus.PUBLISHED
    ) | FormTemplate.objects.filter(
        status__in=[TemplateStatus.SUPERSEDED, TemplateStatus.RETIRED], accept_until__gt=now
    )


# Per-process cache for resolve_for_submission (Phase 5: one query per upsert, measured).
# Template content is immutable once published; only status/accept_until change, and every
# such change goes through publish()/retire(), which clear this process's cache at once and
# again on commit. Other worker processes converge within the TTL, so a just-retired
# template may be accepted for up to RESOLUTION_CACHE_TTL_S longer there (grace windows are
# measured in days, so this is immaterial). Drafts and misses are never cached.
RESOLUTION_CACHE_TTL_S = 30.0
_resolution_cache: dict[tuple[str, int], tuple[float, FormTemplate]] = {}
_resolution_lock = threading.Lock()


def clear_resolution_cache() -> None:
    with _resolution_lock:
        _resolution_cache.clear()


def _invalidate_resolution_cache() -> None:
    clear_resolution_cache()
    transaction.on_commit(clear_resolution_cache)


def _lookup_template(code: str, version: int) -> FormTemplate | None:
    key = (code, version)
    now = time.monotonic()
    with _resolution_lock:
        hit = _resolution_cache.get(key)
    if hit is not None and now - hit[0] < RESOLUTION_CACHE_TTL_S:
        return hit[1]
    template = FormTemplate.objects.filter(code=code, version=version).first()
    if template is not None and template.status != TemplateStatus.DRAFT:
        with _resolution_lock:
            _resolution_cache[key] = (now, template)
    return template


def resolve_for_submission(code: str, version: int) -> FormTemplate:
    """The template a submission targets; read-only (shared across threads when cached)."""
    template = _lookup_template(code, version)
    if template is None or template.status == TemplateStatus.DRAFT:
        raise ApiError(ErrorCode.TEMPLATE_UNKNOWN)
    if template.status != TemplateStatus.PUBLISHED and (
        template.accept_until is None or template.accept_until <= timezone.now()
    ):
        raise ApiError(ErrorCode.TEMPLATE_RETIRED, details={"code": code, "version": version})
    return template
