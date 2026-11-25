from __future__ import annotations

from django.contrib import admin

from fieldsync.formtemplates.models import FormTemplate


@admin.register(FormTemplate)
class FormTemplateAdmin(admin.ModelAdmin[FormTemplate]):
    """Read-only: lifecycle changes go through the API so the service rules always apply."""

    list_display = ("code", "version", "status", "published_at", "accept_until")
    list_filter = ("status", "subject")

    def has_add_permission(self, request: object) -> bool:
        return False

    def has_change_permission(self, request: object, obj: object = None) -> bool:
        return False

    def has_delete_permission(self, request: object, obj: object = None) -> bool:
        return False
