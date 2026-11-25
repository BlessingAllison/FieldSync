"""Idempotent submission upsert, review and server-side re-validation (ADD §12.4-12.5).

Concurrency model: every item runs in its own transaction and locks its row with
``SELECT … FOR UPDATE`` keyed by ``client_uuid``. Two concurrent first-time inserts race on
the unique index; the loser catches the IntegrityError (inside a savepoint), re-reads the
winner's row under lock and continues as a replay/edit. Exactly one row per client_uuid.

Decision order for an existing row (why it matters):
  1. ownership                → client_uuid_foreign
  2. same content hash        → replay (a retry whose ack was lost; never a false conflict)
  3. stale base_version, unless every newer version was written by *this device*
                              → conflict (409 + server copy)
  4. otherwise                → apply as a new version
Rule 3's "own writes" clause covers a device that edits a record again after an earlier
edit's acknowledgement was lost: its local state already contains that edit.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

from django.conf import settings
from django.db import IntegrityError, transaction
from django.utils import timezone

from fieldsync.accounts.models import Device, Role, User
from fieldsync.accounts.scope import Scope
from fieldsync.common import metrics
from fieldsync.common.errors import ApiError, ErrorCode
from fieldsync.formtemplates.models import FormTemplate
from fieldsync.formtemplates.services import canonical_json, resolve_for_submission, sha256_hex
from fieldsync.formtemplates.validation import validate
from fieldsync.submissions.models import (
    Submission,
    SubmissionStatus,
    SubmissionVersion,
    VersionSource,
)
from fieldsync.sync import events
from fieldsync.sync.models import SyncEventType

Outcome = Literal["created", "updated", "replayed", "conflict", "rejected", "forbidden", "invalid"]
Resolution = Literal["none", "override", "merge"]


@dataclass(frozen=True, slots=True)
class UpsertItem:
    client_uuid: uuid.UUID
    op: Literal["create", "update"]
    template_code: str
    template_version: int
    facility_id: uuid.UUID
    captured_at: datetime
    base_version: int | None
    resolution: Resolution
    attempt: int
    payload: dict[str, Any]


@dataclass(frozen=True, slots=True)
class UpsertContext:
    user: User
    device: Device
    scope: Scope
    request_id: str | None
    clock_skew_ms: int | None


@dataclass(frozen=True, slots=True)
class UpsertResult:
    outcome: Outcome
    http_status: int
    submission: Submission | None = None
    error: ApiError | None = None
    server_copy: dict[str, Any] | None = None


def _payload_size_ok(payload: dict[str, Any]) -> bool:
    return len(canonical_json(payload).encode("utf-8")) <= settings.SUBMISSION_MAX_PAYLOAD_BYTES


def _evaluate(template: FormTemplate, payload: dict[str, Any]) -> tuple[dict[str, Any], str, Any]:
    """(stored payload, status, validation errors). Invalid payloads are stored as received."""
    result = validate(template.definition, payload, timezone.now())
    if result.valid:
        return result.normalized, SubmissionStatus.ACCEPTED, None
    return payload, SubmissionStatus.REJECTED, result.errors


def _rejected_error(submission: Submission) -> ApiError:
    return ApiError(
        ErrorCode.VALIDATION_FAILED,
        details={"fields": submission.validation_errors or {}},
    )


def _event(
    event_type: SyncEventType,
    ctx: UpsertContext,
    item: UpsertItem,
    submission: Submission | None,
    **detail: Any,
) -> None:
    events.record(
        event_type,
        request_id=ctx.request_id,
        user_id=ctx.user.id,
        device_id=ctx.device.id,
        facility_id=submission.facility_id if submission else item.facility_id,
        submission_id=submission.id if submission else None,
        client_uuid=item.client_uuid,
        client_attempt=item.attempt,
        detail=detail,
    )


def server_copy(submission: Submission) -> dict[str, Any]:
    latest = submission.versions.order_by("-version").select_related("changed_by").first()
    return {
        "version": submission.version,
        "payload": submission.payload,
        "status": submission.status,
        "changed_at": submission.updated_at,
        "changed_by_role": latest.changed_by.role if latest else None,
    }


def _can_write_existing(row: Submission, ctx: UpsertContext) -> bool:
    if ctx.scope.is_chw:
        return row.submitted_by_id == ctx.user.id and ctx.scope.can_access_facility(row.facility_id)
    return ctx.scope.can_access_facility(row.facility_id)


def _only_own_writes_since(row: Submission, base_version: int, device: Device) -> bool:
    return not row.versions.filter(version__gt=base_version).exclude(device_id=device.id).exists()


ACK_OUTCOMES = frozenset({"created", "updated", "replayed"})


def upsert(item: UpsertItem, ctx: UpsertContext) -> UpsertResult:
    """Idempotent upsert + metrics (counts, attempts at ack, duplicates, conflicts)."""
    result = _upsert(item, ctx)
    metrics.SUBMISSION_UPSERTS.labels(result.outcome, item.op).inc()
    if result.outcome in ACK_OUTCOMES:
        metrics.CLIENT_ATTEMPTS.labels(result.outcome).observe(item.attempt)
    if result.outcome == "replayed":
        metrics.DUPLICATES_PREVENTED.inc()
    if result.outcome == "conflict":
        metrics.CONFLICTS.labels("detected").inc()
    elif result.outcome == "updated" and item.resolution != "none":
        metrics.CONFLICTS.labels(item.resolution).inc()
    return result


def _upsert(item: UpsertItem, ctx: UpsertContext) -> UpsertResult:  # noqa: PLR0911, PLR0912
    if not _payload_size_ok(item.payload):
        return UpsertResult("invalid", 413, error=ApiError(ErrorCode.PAYLOAD_TOO_LARGE))
    try:
        template = resolve_for_submission(item.template_code, item.template_version)
    except ApiError as error:
        return UpsertResult("invalid", error.status, error=error)

    with transaction.atomic():
        row = Submission.objects.select_for_update().filter(client_uuid=item.client_uuid).first()

        if row is None:
            if not ctx.scope.can_access_facility(item.facility_id):
                return UpsertResult("forbidden", 403, error=ApiError(ErrorCode.FACILITY_FORBIDDEN))
            stored, status, errors = _evaluate(template, item.payload)
            try:
                with transaction.atomic():  # savepoint: a concurrent insert may win the race
                    row = Submission.objects.create(
                        client_uuid=item.client_uuid,
                        template=template,
                        facility_id=item.facility_id,
                        submitted_by=ctx.user,
                        device=ctx.device,
                        payload=stored,
                        payload_hash=sha256_hex(stored),
                        status=status,
                        validation_errors=errors,
                        version=1,
                        captured_at=item.captured_at,
                        client_clock_skew_ms=ctx.clock_skew_ms,
                    )
            except IntegrityError:
                row = Submission.objects.select_for_update().get(client_uuid=item.client_uuid)
            else:
                SubmissionVersion.objects.create(
                    submission=row,
                    version=1,
                    payload=stored,
                    payload_hash=row.payload_hash,
                    status=status,
                    source=VersionSource.DEVICE,
                    changed_by=ctx.user,
                    device=ctx.device,
                )
                if status == SubmissionStatus.REJECTED:
                    _event(SyncEventType.SUBMISSION_REJECTED, ctx, item, row, fields=sorted(errors))
                    return UpsertResult("rejected", 422, submission=row, error=_rejected_error(row))
                _event(SyncEventType.SUBMISSION_CREATED, ctx, item, row, version=1)
                return UpsertResult("created", 201, submission=row)

        # ── The row exists ────────────────────────────────────────────────────
        if not _can_write_existing(row, ctx):
            _event(SyncEventType.SUBMISSION_FOREIGN, ctx, item, None)
            return UpsertResult("forbidden", 409, error=ApiError(ErrorCode.CLIENT_UUID_FOREIGN))
        if template.code != row.template.code or item.facility_id != row.facility_id:
            return UpsertResult(
                "invalid",
                400,
                error=ApiError(
                    ErrorCode.MALFORMED_REQUEST, "template code and facility are fixed."
                ),
            )

        stored, status, errors = _evaluate(template, item.payload)
        incoming_hash = sha256_hex(stored)
        if incoming_hash == row.payload_hash:
            _event(SyncEventType.SUBMISSION_REPLAYED, ctx, item, row, version=row.version)
            if row.status == SubmissionStatus.REJECTED:
                return UpsertResult("rejected", 422, submission=row, error=_rejected_error(row))
            return UpsertResult("replayed", 200, submission=row)

        base = item.base_version or 0
        if base != row.version and not _only_own_writes_since(row, base, ctx.device):
            _event(
                SyncEventType.SUBMISSION_CONFLICT,
                ctx,
                item,
                row,
                base_version=base,
                server_version=row.version,
            )
            return UpsertResult(
                "conflict",
                409,
                submission=row,
                error=ApiError(ErrorCode.CONFLICT_VERSION, details={"server_version": row.version}),
                server_copy=server_copy(row),
            )

        row.version += 1
        row.payload = stored
        row.payload_hash = incoming_hash
        row.status = status
        row.validation_errors = errors
        row.template = template
        row.save()
        source = VersionSource.OVERRIDE if item.resolution != "none" else VersionSource.DEVICE
        SubmissionVersion.objects.create(
            submission=row,
            version=row.version,
            payload=stored,
            payload_hash=incoming_hash,
            status=status,
            source=source,
            changed_by=ctx.user,
            device=ctx.device,
        )
        if status == SubmissionStatus.REJECTED:
            _event(SyncEventType.SUBMISSION_REJECTED, ctx, item, row, fields=sorted(errors))
            return UpsertResult("rejected", 422, submission=row, error=_rejected_error(row))
        event_type = (
            SyncEventType.SUBMISSION_CONFLICT_RESOLVED
            if item.resolution != "none"
            else SyncEventType.SUBMISSION_UPDATED
        )
        _event(event_type, ctx, item, row, version=row.version, resolution=item.resolution)
        return UpsertResult("updated", 200, submission=row)


@transaction.atomic
def review(
    submission: Submission,
    *,
    reviewer: User,
    status: str,
    note: str,
    payload: dict[str, Any] | None,
    base_version: int | None,
    request_id: str | None,
) -> Submission:
    """Supervisor review. Status-only reviews do not bump the payload version (ADD §8.3)."""
    row = Submission.objects.select_for_update().get(pk=submission.pk)
    if payload is not None:
        if base_version != row.version:
            raise ApiError(
                ErrorCode.CONFLICT_VERSION,
                details={"server_version": row.version},
                data={"server_copy": server_copy(row)},
            )
        stored, eval_status, errors = _evaluate(row.template, payload)
        if eval_status == SubmissionStatus.REJECTED:
            raise ApiError(ErrorCode.VALIDATION_FAILED, details={"fields": errors})
        row.version += 1
        row.payload = stored
        row.payload_hash = sha256_hex(stored)
        row.validation_errors = None
        SubmissionVersion.objects.create(
            submission=row,
            version=row.version,
            payload=stored,
            payload_hash=row.payload_hash,
            status=status,
            source=VersionSource.REVIEW,
            changed_by=reviewer,
        )
    row.status = status
    row.review_note = note
    row.reviewed_by = reviewer
    row.reviewed_at = timezone.now()
    row.save()
    events.record(
        SyncEventType.SUBMISSION_REVIEWED,
        request_id=request_id,
        user_id=reviewer.id,
        facility_id=row.facility_id,
        submission_id=row.id,
        client_uuid=row.client_uuid,
        detail={"status": status, "corrected": payload is not None, "version": row.version},
    )
    return row


@transaction.atomic
def revalidate(
    submission: Submission, *, actor: User, template_version: int | None, request_id: str | None
) -> Submission:
    """Server retry: re-run validation for a quarantined submission (ADD §10.3 note)."""
    row = Submission.objects.select_for_update().select_related("template").get(pk=submission.pk)
    if row.status != SubmissionStatus.REJECTED:
        raise ApiError(
            ErrorCode.MALFORMED_REQUEST, "Only rejected submissions can be re-validated."
        )
    template = row.template
    if template_version is not None and template_version != template.version:
        template = resolve_for_submission(template.code, template_version)
    stored, status, errors = _evaluate(template, row.payload)
    # Any change is a new version: a device holding the quarantined copy must see a conflict
    # rather than silently overwrite the server's re-validated (normalised) payload.
    if status != row.status or template.pk != row.template_id:
        row.version += 1
        row.payload = stored
        row.payload_hash = sha256_hex(stored)
        row.status = status
        row.validation_errors = errors
        row.template = template
        row.save()
        SubmissionVersion.objects.create(
            submission=row,
            version=row.version,
            payload=stored,
            payload_hash=row.payload_hash,
            status=status,
            source=VersionSource.REVALIDATE,
            changed_by=actor,
        )
    events.record(
        SyncEventType.SUBMISSION_REVALIDATED,
        request_id=request_id,
        user_id=actor.id,
        facility_id=row.facility_id,
        submission_id=row.id,
        client_uuid=row.client_uuid,
        detail={"status": row.status, "template_version": template.version},
    )
    return row


def is_reviewer(user: User) -> bool:
    return user.role in {Role.SUPERVISOR, Role.ADMIN}
