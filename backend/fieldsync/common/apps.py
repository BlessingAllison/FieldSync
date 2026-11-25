from __future__ import annotations

from django.apps import AppConfig


class CommonConfig(AppConfig):
    name = "fieldsync.common"
    label = "fieldsync_common"
    verbose_name = "FieldSync common infrastructure"
