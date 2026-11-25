from __future__ import annotations

from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin

from fieldsync.accounts.models import Device, FacilityAssignment, User


class FacilityAssignmentInline(admin.TabularInline[FacilityAssignment, User]):
    model = FacilityAssignment
    fk_name = "user"
    extra = 0
    autocomplete_fields = ("facility",)


@admin.register(User)
# django-stubs types UserAdmin for AbstractUser subclasses; ours extends AbstractBaseUser.
class UserAdmin(BaseUserAdmin):  # type: ignore[type-arg]
    ordering = ("username",)
    list_display = ("username", "display_name", "role", "county", "is_active", "locked_until")
    list_filter = ("role", "county", "is_active")
    search_fields = ("username", "display_name")
    inlines = (FacilityAssignmentInline,)
    fieldsets = (
        (None, {"fields": ("username", "password")}),
        ("Profile", {"fields": ("display_name", "role", "county", "preferred_locale")}),
        (
            "Access",
            {"fields": ("is_active", "is_staff", "is_superuser", "failed_logins", "locked_until")},
        ),
    )
    add_fieldsets = (
        (
            None,
            {"fields": ("username", "display_name", "role", "county", "password1", "password2")},
        ),
    )


@admin.register(Device)
class DeviceAdmin(admin.ModelAdmin[Device]):
    list_display = ("id", "user", "label", "app_version", "last_seen_at", "revoked_at")
    list_filter = ("revoked_at",)
    search_fields = ("user__username", "label")
    readonly_fields = ("id", "user", "escrow_key_id", "registered_at", "last_seen_at")
    exclude = ("escrow_secret_enc",)
