from __future__ import annotations

from django.apps import AppConfig


class AccountsConfig(AppConfig):
    name = "fieldsync.accounts"
    label = "accounts"
    default_auto_field = "django.db.models.BigAutoField"
