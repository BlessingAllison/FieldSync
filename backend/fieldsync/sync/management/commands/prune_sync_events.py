"""Delete sync_events older than the retention window (ADD §8.3; default 180 days).

    python manage.py prune_sync_events              # settings.SYNC_EVENT_RETENTION_DAYS
    python manage.py prune_sync_events --days 90 --dry-run

Deletes in id-ordered chunks so a large backlog never holds one long lock on a busy,
append-only table. Schedule daily (cron/Kubernetes CronJob); safe to re-run.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from django.conf import settings
from django.core.management.base import BaseCommand, CommandParser
from django.utils import timezone

from fieldsync.sync.models import SyncEvent


class Command(BaseCommand):
    help = "Delete sync_events older than the retention window."

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("--days", type=int, default=settings.SYNC_EVENT_RETENTION_DAYS)
        parser.add_argument("--chunk", type=int, default=5_000)
        parser.add_argument("--dry-run", action="store_true")

    def handle(self, *args: Any, **options: Any) -> None:
        days: int = options["days"]
        if days < 1:
            raise ValueError("--days must be at least 1")
        cutoff = timezone.now() - timedelta(days=days)
        old = SyncEvent.objects.filter(occurred_at__lt=cutoff)
        if options["dry_run"]:
            self.stdout.write(
                f"would delete {old.count()} sync_events older than {cutoff:%Y-%m-%d}"
            )
            return
        deleted = 0
        while True:
            ids = list(old.order_by("id").values_list("id", flat=True)[: options["chunk"]])
            if not ids:
                break
            deleted += SyncEvent.objects.filter(id__in=ids).delete()[0]
        self.stdout.write(f"deleted {deleted} sync_events older than {cutoff:%Y-%m-%d}")
