"""Versioned form templates (ADD §13). Published definitions are immutable."""

from __future__ import annotations

from django.conf import settings
from django.db import models
from django.db.models import Q

from fieldsync.common.ids import new_uuid7


class TemplateStatus(models.TextChoices):
    DRAFT = "draft", "Draft"
    PUBLISHED = "published", "Published"
    SUPERSEDED = "superseded", "Superseded"
    RETIRED = "retired", "Retired"


class TemplateSubject(models.TextChoices):
    PATIENT = "patient", "Patient"
    FACILITY = "facility", "Facility"


class FormTemplate(models.Model):
    id = models.UUIDField(primary_key=True, default=new_uuid7, editable=False)
    code = models.CharField(max_length=64)
    version = models.PositiveIntegerField()
    subject = models.CharField(max_length=16, choices=TemplateSubject.choices)
    title = models.JSONField()
    description = models.JSONField(default=dict, blank=True)
    definition = models.JSONField()
    definition_hash = models.CharField(max_length=64)
    status = models.CharField(
        max_length=12, choices=TemplateStatus.choices, default=TemplateStatus.DRAFT
    )
    accept_until = models.DateTimeField(null=True, blank=True)
    published_at = models.DateTimeField(null=True, blank=True)
    superseded_at = models.DateTimeField(null=True, blank=True)
    retired_at = models.DateTimeField(null=True, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+"
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "form_templates"
        ordering = ("code", "-version")
        constraints = [
            models.UniqueConstraint(fields=["code", "version"], name="form_templates_code_version"),
            models.UniqueConstraint(
                fields=["code"],
                condition=Q(status="published"),
                name="form_templates_one_published",
            ),
            models.CheckConstraint(
                condition=Q(version__gt=0), name="form_templates_version_positive"
            ),
        ]

    def __str__(self) -> str:
        return f"{self.code} v{self.version} ({self.status})"
