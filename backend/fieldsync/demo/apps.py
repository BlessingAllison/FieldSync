from __future__ import annotations

from django.apps import AppConfig


class DemoConfig(AppConfig):
    name = "fieldsync.demo"
    label = "demo"
    default_auto_field = "django.db.models.BigAutoField"
