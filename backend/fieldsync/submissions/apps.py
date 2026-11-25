from __future__ import annotations

from django.apps import AppConfig


class SubmissionsConfig(AppConfig):
    name = "fieldsync.submissions"
    label = "submissions"
    default_auto_field = "django.db.models.BigAutoField"
