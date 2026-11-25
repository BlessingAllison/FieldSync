"""Append-only sync observation log writer. ``detail`` must stay PII-free."""

from __future__ import annotations

import uuid
from typing import Any

from fieldsync.sync.models import SyncEvent, SyncEventType


def _uuid_or_none(value: str | uuid.UUID | None) -> uuid.UUID | None:
    if value is None or isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(value)
    except ValueError:
        return None


def record(
    event_type: SyncEventType,
    *,
    request_id: str | None,
    user_id: uuid.UUID | None = None,
    device_id: uuid.UUID | None = None,
    facility_id: uuid.UUID | None = None,
    submission_id: uuid.UUID | None = None,
    client_uuid: uuid.UUID | None = None,
    client_attempt: int | None = None,
    latency_ms: int | None = None,
    detail: dict[str, Any] | None = None,
) -> SyncEvent:
    return SyncEvent.objects.create(
        event_type=event_type,
        request_id=_uuid_or_none(request_id),
        user_id=user_id,
        device_id=device_id,
        facility_id=facility_id,
        submission_id=submission_id,
        client_uuid=client_uuid,
        client_attempt=min(client_attempt, 32767) if client_attempt is not None else None,
        latency_ms=latency_ms,
        detail=detail or {},
    )
