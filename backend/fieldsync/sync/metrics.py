"""Scrape-time sync-health gauges, computed with the same logic as the dashboard (ADD §14).

One national ``sync_status`` aggregation (four grouped queries), folded into per-county
gauges. Labels are bounded: county (15) and health (4) only.

Memoised per process for ``SYNC_METRICS_CACHE_SECONDS`` (default 60): measured at national
scale (824 facilities, 213k submissions, 515k events) the aggregation takes ~0.3 s median,
0.8 s worst case, which is fine for a dashboard view but wasteful every 15 s scrape. The
gauges are 7-day ratios and last-reported queue depths; a minute of staleness is immaterial.
"""

from __future__ import annotations

import threading
import time
import uuid
from collections import defaultdict
from collections.abc import Iterator

import structlog
from django.conf import settings
from prometheus_client.core import GaugeMetricFamily
from prometheus_client.registry import Collector

from fieldsync.accounts.models import Role
from fieldsync.accounts.scope import Scope

log = structlog.get_logger(__name__)

NATIONAL = Scope(
    user_id=uuid.UUID(int=0), role=Role.ADMIN, county_id=None, facility_ids=frozenset()
)


_cache_lock = threading.Lock()
_cache: tuple[float, list[GaugeMetricFamily]] | None = None


def reset_cache() -> None:
    global _cache  # noqa: PLW0603 — a deliberate per-process memo
    with _cache_lock:
        _cache = None


class SyncHealthCollector(Collector):
    def collect(self) -> Iterator[GaugeMetricFamily]:
        global _cache  # noqa: PLW0603
        ttl = float(getattr(settings, "SYNC_METRICS_CACHE_SECONDS", 60))
        now = time.monotonic()
        with _cache_lock:
            cached = _cache
        if cached is not None and now - cached[0] < ttl:
            yield from cached[1]
            return
        families = self._compute()
        if families is None:
            return
        with _cache_lock:
            _cache = (now, families)
        yield from families

    def _compute(self) -> list[GaugeMetricFamily] | None:
        from fieldsync.sync.services import sync_status  # avoid import cycles at app load

        try:
            status = sync_status(NATIONAL)
        except Exception:  # a broken scrape must never take the API down
            log.exception("metrics.sync_health_collect_failed")
            return None
        depth = GaugeMetricFamily(
            "fieldsync_queue_depth_reported",
            "Forms waiting on phones (last device report, non-revoked devices).",
            labels=["county"],
        )
        stuck = GaugeMetricFamily(
            "fieldsync_stuck_items_reported",
            "Forms stuck on phones (≥ 8 tries or 48 h).",
            labels=["county"],
        )
        ratio = GaugeMetricFamily(
            "fieldsync_sync_success_ratio",
            "Share of acknowledged sends that succeeded on the first attempt (7 days).",
            labels=["county"],
        )
        health = GaugeMetricFamily(
            "fieldsync_facilities", "Facilities by sync health.", labels=["health"]
        )
        totals: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
        for row in status["facilities"]:
            county = totals[row["county"]]
            county["pending"] += row["pending_on_devices"]
            county["stuck"] += row["stuck"]
            county["acks"] += row["acks_7d"]
            county["first"] += row["first_attempt_7d"]
        for code, values in sorted(totals.items()):
            depth.add_metric([code], values["pending"])
            stuck.add_metric([code], values["stuck"])
            if values["acks"]:
                ratio.add_metric([code], values["first"] / values["acks"])
        summary = status["summary"]
        for state in ("healthy", "degraded", "stale", "unknown"):
            health.add_metric([state], summary[state])
        return [depth, stuck, ratio, health]
