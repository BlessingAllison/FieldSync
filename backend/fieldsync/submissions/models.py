"""Submissions and their version history (ADD §8.2, §12.4-12.5)."""

from __future__ import annotations

from django.conf import settings
from django.db import models
from django.db.models import Q

from fieldsync.accounts.models import Device
from fieldsync.common.ids import new_uuid7
from fieldsync.facilities.models import Facility
from fieldsync.formtemplates.models import FormTemplate


class SubmissionStatus(models.TextChoices):
    ACCEPTED = "accepted", "Accepted"
    REJECTED = "rejected", "Rejected (quarantined)"
    REVIEWED = "reviewed", "Reviewed"
    FLAGGED = "flagged", "Flagged"


class VersionSource(models.TextChoices):
    DEVICE = "device", "Device"
    REVIEW = "review", "Supervisor review"
    OVERRIDE = "override", "Conflict override/merge"
    REVALIDATE = "revalidate", "Server re-validation"


class Submission(models.Model):
    id = models.UUIDField(primary_key=True, default=new_uuid7, editable=False)
    client_uuid = models.UUIDField(unique=True)  # idempotency key, generated on device
    template = models.ForeignKey(FormTemplate, on_delete=models.PROTECT, related_name="submissions")
    facility = models.ForeignKey(Facility, on_delete=models.PROTECT, related_name="submissions")
    submitted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="submissions"
    )
    device = models.ForeignKey(Device, on_delete=models.PROTECT, related_name="submissions")
    payload = models.JSONField()
    payload_hash = models.CharField(max_length=64)
    status = models.CharField(max_length=12, choices=SubmissionStatus.choices)
    validation_errors = models.JSONField(null=True, blank=True)
    version = models.PositiveIntegerField(default=1)  # PAYLOAD version (ADD §8.3)
    captured_at = models.DateTimeField()
    client_clock_skew_ms = models.BigIntegerField(null=True, blank=True)
    received_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    reviewed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    reviewed_at = models.DateTimeField(null=True, blank=True)
    review_note = models.CharField(max_length=500, blank=True)

    class Meta:
        db_table = "submissions"
        indexes = [
            models.Index(
                fields=["facility", "-received_at", "-id"], name="submissions_facility_received"
            ),
            models.Index(
                fields=["submitted_by", "-received_at", "-id"],
                name="submissions_submitter_received",
            ),
            models.Index(
                fields=["facility"], condition=Q(status="rejected"), name="submissions_rejected"
            ),
        ]
        constraints = [
            models.CheckConstraint(condition=Q(version__gt=0), name="submissions_version_positive"),
        ]

    def __str__(self) -> str:
        return f"{self.client_uuid} v{self.version}"


class SubmissionVersion(models.Model):
    submission = models.ForeignKey(Submission, on_delete=models.PROTECT, related_name="versions")
    version = models.PositiveIntegerField()
    payload = models.JSONField()
    payload_hash = models.CharField(max_length=64)
    status = models.CharField(max_length=12, choices=SubmissionStatus.choices)
    source = models.CharField(max_length=16, choices=VersionSource.choices)
    changed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+"
    )
    device = models.ForeignKey(
        Device, on_delete=models.PROTECT, null=True, blank=True, related_name="+"
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "submission_versions"
        ordering = ("submission", "version")
        constraints = [
            models.UniqueConstraint(
                fields=["submission", "version"], name="submission_versions_unique"
            ),
        ]

    def __str__(self) -> str:
        return f"{self.submission_id} v{self.version} ({self.source})"
