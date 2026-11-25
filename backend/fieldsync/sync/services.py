"""Device queue-state reporting and per-facility sync-health aggregation (ADD §14)."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from django.conf import settings
from django.db.models import Avg, Count, Max, Min, Q, Sum
from django.utils import timezone

from fieldsync.accounts.models import Device
from fieldsync.accounts.scope import Scope
from fieldsync.facilities.models import Facility
from fieldsync.submissions.models import Submission, SubmissionStatus
from fieldsync.sync import events
from fieldsync.sync.models import ACK_EVENT_TYPES, DeviceFacilityState, SyncEvent, SyncEventType


def apply_device_state(
    *, device: Device, scope: Scope, facilities: list[dict[str, Any]], request_id: str | None
) -> int:
    """Upsert the device's self-reported queue state. Out-of-scope facilities are ignored."""
    now = timezone.now()
    applied = 0
    for entry in facilities:
        facility_id: uuid.UUID = entry["facility_id"]
        if not scope.can_access_facility(facility_id):
            continue
        DeviceFacilityState.objects.update_or_create(
            device=device,
            facility_id=facility_id,
            defaults={
                "pending": entry.get("pending", 0),
                "failed": entry.get("failed", 0),
                "conflicts": entry.get("conflicts", 0),
                "stuck": entry.get("stuck", 0),
                "oldest_pending_at": entry.get("oldest_pending_at"),
                "last_attempt_at": entry.get("last_attempt_at"),
                "last_success_at": entry.get("last_success_at"),
                "reported_at": now,
            },
        )
        applied += 1
    events.record(
        SyncEventType.DEVICE_HEARTBEAT,
        request_id=request_id,
        user_id=scope.user_id,
        device_id=device.id,
        detail={
            "facilities": applied,
            "pending": sum(int(e.get("pending", 0)) for e in facilities),
        },
    )
    return applied


@dataclass(frozen=True, slots=True)
class Thresholds:
    degraded_after: timedelta
    stale_after: timedelta
    min_first_attempt_success: float

    @classmethod
    def from_settings(cls) -> Thresholds:
        return cls(
            degraded_after=timedelta(hours=settings.SYNC_HEALTH_DEGRADED_AFTER_HOURS),
            stale_after=timedelta(hours=settings.SYNC_HEALTH_STALE_AFTER_HOURS),
            min_first_attempt_success=settings.SYNC_HEALTH_MIN_FIRST_ATTEMPT_SUCCESS,
        )


def _latest(*values: datetime | None) -> datetime | None:
    present = [v for v in values if v is not None]
    return max(present) if present else None


def classify(row: dict[str, Any], now: datetime, t: Thresholds) -> tuple[str, list[str]]:
    """Health status + machine-readable reasons (first matching status wins)."""
    reasons: list[str] = []
    last_success = row["last_success_at"]
    oldest_pending = row["oldest_pending_at"]
    if last_success is None and row["pending_on_devices"] == 0:
        # Nothing ever received and nothing waiting: no evidence either way. A device heartbeat
        # alone (e.g. a supervisor's phone) must not turn "no data" into "not syncing".
        return "unknown", ["never_synced"]
    stale = False
    if last_success is not None and now - last_success > t.stale_after:
        reasons.append("no_sync_72h")
        stale = True
    if oldest_pending is not None and now - oldest_pending > t.stale_after:
        reasons.append("oldest_pending_72h")
        stale = True
    if stale:
        return "stale", reasons
    if last_success is None:
        reasons.append("never_synced")  # forms are waiting but none has arrived yet
    elif now - last_success > t.degraded_after:
        reasons.append("no_sync_24h")
    if row["failed"]:
        reasons.append("failed_items")
    if row["conflicts"]:
        reasons.append("conflicts")
    if row["stuck"]:
        reasons.append("stuck_items")
    if row["rejected_open"]:
        reasons.append("rejected_open")
    rate = row["first_attempt_success_7d"]
    if rate is not None and rate < t.min_first_attempt_success:
        reasons.append("low_first_attempt_success")
    return ("degraded" if reasons else "healthy"), reasons


def sync_status(scope: Scope, *, county_code: str | None = None) -> dict[str, Any]:
    now = timezone.now()
    thresholds = Thresholds.from_settings()
    facilities = scope.facilities().select_related("county").order_by("county__name", "code")
    if county_code:
        facilities = facilities.filter(county__code=county_code)
    facility_list = list(facilities)
    ids = [f.id for f in facility_list]

    states = DeviceFacilityState.objects.filter(
        facility_id__in=ids,
        device__revoked_at__isnull=True,
        reported_at__gte=now - timedelta(days=30),
    )
    if scope.is_chw:  # CHWs see their own devices' queues only
        states = states.filter(device__user_id=scope.user_id)
    device_rows = {
        r["facility_id"]: r
        for r in states.values("facility_id").annotate(
            pending=Sum("pending"),
            failed=Sum("failed"),
            conflicts=Sum("conflicts"),
            stuck=Sum("stuck"),
            oldest_pending_at=Min("oldest_pending_at"),
            last_success_at=Max("last_success_at"),
            devices_active=Count("device_id", distinct=True),
            devices_silent=Count(
                "device_id", filter=Q(reported_at__lt=now - thresholds.stale_after), distinct=True
            ),
        )
    }
    server_rows = {
        r["facility_id"]: r
        for r in Submission.objects.filter(facility_id__in=ids)
        .values("facility_id")
        .annotate(
            submissions_24h=Count("id", filter=Q(received_at__gte=now - timedelta(hours=24))),
            rejected_open=Count("id", filter=Q(status=SubmissionStatus.REJECTED)),
            last_received_at=Max("received_at"),
        )
    }
    ack_rows = {
        r["facility_id"]: r
        for r in SyncEvent.objects.filter(
            facility_id__in=ids,
            event_type__in=ACK_EVENT_TYPES,
            occurred_at__gte=now - timedelta(days=7),
            client_attempt__isnull=False,
        )
        .values("facility_id")
        .annotate(
            acks=Count("id"),
            first_attempt=Count("id", filter=Q(client_attempt=1)),
            mean_attempts=Avg("client_attempt"),
        )
    }

    results: list[dict[str, Any]] = []
    totals = {"healthy": 0, "degraded": 0, "stale": 0, "unknown": 0}
    sums = {"pending_on_devices": 0, "stuck": 0, "conflicts_open": 0, "rejected_open": 0}
    all_acks = all_first = 0
    attempts_weighted = 0.0
    for facility in facility_list:
        d = device_rows.get(facility.id, {})
        srv = server_rows.get(facility.id, {})
        ack = ack_rows.get(facility.id, {})
        acks = int(ack.get("acks") or 0)
        first_rate = (int(ack.get("first_attempt") or 0) / acks) if acks else None
        row: dict[str, Any] = {
            "facility_id": facility.id,
            "code": facility.code,
            "name": facility.name,
            "county": facility.county.code,
            "last_success_at": _latest(d.get("last_success_at"), srv.get("last_received_at")),
            "pending_on_devices": int(d.get("pending") or 0),
            "oldest_pending_at": d.get("oldest_pending_at"),
            "failed": int(d.get("failed") or 0),
            "conflicts": int(d.get("conflicts") or 0),
            "stuck": int(d.get("stuck") or 0),
            "rejected_open": int(srv.get("rejected_open") or 0),
            "devices_active": int(d.get("devices_active") or 0),
            "devices_silent_72h": int(d.get("devices_silent") or 0),
            "submissions_24h": int(srv.get("submissions_24h") or 0),
            "first_attempt_success_7d": round(first_rate, 3) if first_rate is not None else None,
            "acks_7d": acks,
            "first_attempt_7d": int(ack.get("first_attempt") or 0),
            "mean_attempts_7d": round(float(ack["mean_attempts"]), 2) if acks else None,
        }
        row["health"], row["reasons"] = classify(row, now, thresholds)
        totals[row["health"]] += 1
        sums["pending_on_devices"] += row["pending_on_devices"]
        sums["stuck"] += row["stuck"]
        sums["conflicts_open"] += row["conflicts"]
        sums["rejected_open"] += row["rejected_open"]
        all_acks += acks
        all_first += int(ack.get("first_attempt") or 0)
        if acks:
            attempts_weighted += float(ack["mean_attempts"]) * acks
        results.append(row)

    return {
        "generated_at": now,
        "scope": {
            "county": county_code
            or (facility_list[0].county.code if scope.county_id and facility_list else None)
        },
        "thresholds": {
            "degraded_after_h": settings.SYNC_HEALTH_DEGRADED_AFTER_HOURS,
            "stale_after_h": settings.SYNC_HEALTH_STALE_AFTER_HOURS,
            "min_first_attempt_success": thresholds.min_first_attempt_success,
        },
        "summary": {
            "facilities": len(results),
            **totals,
            **sums,
            "first_attempt_success_7d": round(all_first / all_acks, 3) if all_acks else None,
            "mean_attempts_7d": round(attempts_weighted / all_acks, 2) if all_acks else None,
        },
        "facilities": results,
    }


def facility_in_scope(scope: Scope, facility_id: uuid.UUID) -> Facility | None:
    return scope.facilities().filter(id=facility_id).first()
