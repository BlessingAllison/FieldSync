"""Identity: users (custom model), facility assignments and devices (ADD §8.2, §11)."""

from __future__ import annotations

from typing import Any, ClassVar

from django.contrib.auth.models import AbstractBaseUser, BaseUserManager, PermissionsMixin
from django.db import models
from django.db.models import Q
from django.db.models.functions import Lower
from django.utils import timezone

from fieldsync.common.ids import new_uuid7
from fieldsync.facilities.models import County, Facility


class Role(models.TextChoices):
    CHW = "chw", "Community health worker"
    SUPERVISOR = "supervisor", "County supervisor"
    ADMIN = "admin", "National administrator"


class UserManager(BaseUserManager["User"]):
    use_in_migrations = True

    def create_user(self, username: str, password: str | None = None, **extra: Any) -> User:
        if not username:
            raise ValueError("username is required")
        user = self.model(username=username.strip().lower(), **extra)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_superuser(self, username: str, password: str | None = None, **extra: Any) -> User:
        extra.setdefault("role", Role.ADMIN)
        extra.setdefault("display_name", username)
        extra["is_staff"] = True
        extra["is_superuser"] = True
        return self.create_user(username, password, **extra)


class User(AbstractBaseUser, PermissionsMixin):
    id = models.UUIDField(primary_key=True, default=new_uuid7, editable=False)
    # Stored lower-case (normalised in the manager and at login) → case-insensitive uniqueness.
    username = models.CharField(max_length=64, unique=True)
    display_name = models.CharField(max_length=120)
    role = models.CharField(max_length=16, choices=Role.choices)
    county = models.ForeignKey(
        County, on_delete=models.PROTECT, null=True, blank=True, related_name="users"
    )
    facilities: models.ManyToManyField[Facility, FacilityAssignment] = models.ManyToManyField(
        Facility,
        through="FacilityAssignment",
        through_fields=("user", "facility"),
        related_name="assigned_users",
        blank=True,
    )
    preferred_locale = models.CharField(max_length=8, default="en")
    is_active = models.BooleanField(default=True)
    is_staff = models.BooleanField(default=False)  # Django admin access (admins only)
    failed_logins = models.PositiveSmallIntegerField(default=0)
    locked_until = models.DateTimeField(null=True, blank=True)
    date_joined = models.DateTimeField(default=timezone.now)

    objects: ClassVar[UserManager] = UserManager()

    USERNAME_FIELD = "username"
    REQUIRED_FIELDS: ClassVar[list[str]] = ["display_name"]

    class Meta:
        db_table = "users"
        ordering = ("username",)
        constraints = [
            models.CheckConstraint(
                condition=~Q(role="supervisor") | Q(county__isnull=False),
                name="supervisor_has_county",
            ),
            models.CheckConstraint(
                condition=Q(username=Lower("username")),
                name="username_lowercase",
            ),
        ]

    def __str__(self) -> str:
        return self.username


class FacilityAssignment(models.Model):
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="assignments")
    facility = models.ForeignKey(Facility, on_delete=models.PROTECT, related_name="assignments")
    assigned_at = models.DateTimeField(auto_now_add=True)
    assigned_by = models.ForeignKey(
        User, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )

    class Meta:
        db_table = "facility_assignments"
        constraints = [
            models.UniqueConstraint(fields=["user", "facility"], name="facility_assignment_unique"),
        ]

    def __str__(self) -> str:
        return f"{self.user_id} → {self.facility_id}"


class Device(models.Model):
    """One (browser installation, user) pair. Its id is generated on the device."""

    id = models.UUIDField(primary_key=True, editable=False)
    user = models.ForeignKey(User, on_delete=models.PROTECT, related_name="devices")
    label = models.CharField(max_length=80)
    app_version = models.CharField(max_length=32)
    escrow_secret_enc = models.BinaryField()
    escrow_key_id = models.PositiveSmallIntegerField()
    registered_at = models.DateTimeField(auto_now_add=True)
    last_seen_at = models.DateTimeField(default=timezone.now)
    revoked_at = models.DateTimeField(null=True, blank=True)
    revoked_by = models.ForeignKey(
        User, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    revoke_reason = models.CharField(max_length=200, blank=True)

    class Meta:
        db_table = "devices"
        indexes = [
            models.Index(
                fields=["last_seen_at"],
                condition=Q(revoked_at__isnull=True),
                name="devices_active_seen",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.label} ({self.user_id})"

    @property
    def is_revoked(self) -> bool:
        return self.revoked_at is not None
