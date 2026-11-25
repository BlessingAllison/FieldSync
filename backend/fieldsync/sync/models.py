"""Sync observation log and per-device queue state (ADD §8.2, §14)."""

from __future__ import annotations

from django.contrib.postgres.indexes import BrinIndex
from django.db import models
from django.utils import timezone

from fieldsync.accounts.models import Device
from fieldsync.facilities.models import Facility


class SyncEventType(models.TextChoices):
    BATCH_RECEIVED = "batch.received"
    SUBMISSION_CREATED = "submission.created"
    SUBMISSION_UPDATED = "submission.updated"
    SUBMISSION_REPLAYED = "submission.replayed"
    SUBMISSION_CONFLICT = "submission.conflict"
    SUBMISSION_CONFLICT_RESOLVED = "submission.conflict_resolved"
    SUBMISSION_REJECTED = "submission.rejected"
    SUBMISSION_REVALIDATED = "submission.revalidated"
    SUBMISSION_REVIEWED = "submission.reviewed"
    SUBMISSION_FOREIGN = "submission.foreign_uuid"
    DEVICE_REGISTERED = "device.registered"
    DEVICE_HEARTBEAT = "device.heartbeat"
    DEVICE_REVOKED = "device.revoked"
    AUTH_REFRESH_DENIED = "auth.refresh_denied"


# Events that mean "the device received an acknowledgement for this write".
ACK_EVENT_TYPES = (
    SyncEventType.SUBMISSION_CREATED,
    SyncEventType.SUBMISSION_UPDATED,
    SyncEventType.SUBMISSION_REPLAYED,
    SyncEventType.SUBMISSION_CONFLICT_RESOLVED,
)


class SyncEvent(models.Model):
    """Append-only. Plain UUID columns (not FKs) so the log never blocks deletes/archival."""

    id = models.BigAutoField(primary_key=True)
    occurred_at = models.DateTimeField(default=timezone.now)
    event_type = models.CharField(max_length=32, choices=SyncEventType.choices)
    request_id = models.UUIDField(null=True)
    user_id = models.UUIDField(null=True)
    device_id = models.UUIDField(null=True)
    facility_id = models.UUIDField(null=True)
    submission_id = models.UUIDField(null=True)
    client_uuid = models.UUIDField(null=True)
    client_attempt = models.PositiveSmallIntegerField(null=True)
    latency_ms = models.PositiveIntegerField(null=True)
    detail = models.JSONField(default=dict)  # non-PII only: codes, counts, versions

    class Meta:
        db_table = "sync_events"
        indexes = [
            BrinIndex(fields=["occurred_at"], name="sync_events_occurred_brin"),
            models.Index(fields=["facility_id", "-occurred_at"], name="sync_events_facility_time"),
            models.Index(fields=["event_type", "-occurred_at"], name="sync_events_type_time"),
        ]

    def __str__(self) -> str:
        return f"{self.event_type} @ {self.occurred_at:%Y-%m-%d %H:%M:%S}"


class DeviceFacilityState(models.Model):
    """Last self-reported queue state per device per facility (overwritten each report)."""

    device = models.ForeignKey(Device, on_delete=models.CASCADE, related_name="facility_states")
    facility = models.ForeignKey(Facility, on_delete=models.PROTECT, related_name="device_states")
    pending = models.PositiveIntegerField(default=0)
    failed = models.PositiveIntegerField(default=0)
    conflicts = models.PositiveIntegerField(default=0)
    stuck = models.PositiveIntegerField(default=0)
    oldest_pending_at = models.DateTimeField(null=True, blank=True)
    last_attempt_at = models.DateTimeField(null=True, blank=True)
    last_success_at = models.DateTimeField(null=True, blank=True)
    reported_at = models.DateTimeField()

    class Meta:
        db_table = "device_facility_state"
        constraints = [
            models.UniqueConstraint(
                fields=["device", "facility"], name="device_facility_state_unique"
            ),
        ]
        indexes = [models.Index(fields=["facility"], name="device_facility_state_facility")]

    def __str__(self) -> str:
        return f"{self.device_id} @ {self.facility_id}: {self.pending} pending"
