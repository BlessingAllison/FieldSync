from __future__ import annotations

from django.apps import AppConfig


class SyncConfig(AppConfig):
    name = "fieldsync.sync"
    label = "sync"
    default_auto_field = "django.db.models.BigAutoField"

    def ready(self) -> None:
        from fieldsync.common.metrics import SCRAPE_COLLECTORS
        from fieldsync.sync.metrics import SyncHealthCollector

        if not any(isinstance(c, SyncHealthCollector) for c in SCRAPE_COLLECTORS):
            SCRAPE_COLLECTORS.append(SyncHealthCollector())
