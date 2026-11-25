"""Reference geography: counties and health facilities (ADD §8.2)."""

from __future__ import annotations

from django.db import models
from django.db.models import Q

from fieldsync.common.ids import new_uuid7


class County(models.Model):
    id = models.SmallAutoField(primary_key=True)
    code = models.CharField(max_length=8, unique=True)
    name = models.CharField(max_length=64, unique=True)

    class Meta:
        db_table = "counties"
        ordering = ("name",)
        verbose_name_plural = "counties"

    def __str__(self) -> str:
        return self.name


class FacilityType(models.TextChoices):
    HOSPITAL = "hospital", "Hospital"
    HEALTH_CENTER = "health_center", "Health centre"
    CLINIC = "clinic", "Clinic"
    COMMUNITY_POST = "community_post", "Community health post"


class Facility(models.Model):
    id = models.UUIDField(primary_key=True, default=new_uuid7, editable=False)
    code = models.CharField(max_length=32, unique=True)
    name = models.CharField(max_length=160)
    county = models.ForeignKey(County, on_delete=models.PROTECT, related_name="facilities")
    district = models.CharField(max_length=80)
    facility_type = models.CharField(max_length=24, choices=FacilityType.choices)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "facilities"
        ordering = ("code",)
        verbose_name_plural = "facilities"
        indexes = [
            models.Index(
                fields=["county"], condition=Q(is_active=True), name="facilities_county_active"
            ),
        ]

    def __str__(self) -> str:
        return f"{self.code} · {self.name}"
