"""Prometheus metrics.

Gunicorn runs several worker processes, each with its own in-memory registry.
When ``PROMETHEUS_MULTIPROC_DIR`` is set (it is, in the container), metrics are
written to per-process files and aggregated at scrape time by
``MultiProcessCollector``; otherwise (tests, runserver) the default registry is used.

Labels are bounded by design: no user, facility, device or patient labels —
per-facility detail belongs to the sync-status API, not to Prometheus.
"""

from __future__ import annotations

import os
from collections.abc import Iterable
from typing import Protocol

from prometheus_client import (
    CONTENT_TYPE_LATEST,
    REGISTRY,
    CollectorRegistry,
    Counter,
    Histogram,
    generate_latest,
)
from prometheus_client import multiprocess as prometheus_multiprocess

HTTP_REQUEST_DURATION = Histogram(
    "fieldsync_http_request_duration_seconds",
    "API request duration by route template.",
    labelnames=("method", "route", "status_class"),
    buckets=(0.01, 0.025, 0.05, 0.1, 0.15, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0),
)

HTTP_REQUESTS_REJECTED = Counter(
    "fieldsync_http_requests_rejected_total",
    "Requests rejected by middleware before reaching a view.",
    labelnames=("reason",),
)

# ── Sync domain (ADD §15.3) ───────────────────────────────────────────────────
SUBMISSION_UPSERTS = Counter(
    "fieldsync_submission_upserts_total",
    "Submission upserts by outcome (created/updated/replayed/conflict/rejected/forbidden/invalid).",
    labelnames=("outcome", "op"),
)
CLIENT_ATTEMPTS = Histogram(
    "fieldsync_client_attempts",
    "Device-reported attempt number at which a submission was acknowledged.",
    labelnames=("outcome",),
    buckets=(1, 2, 3, 4, 6, 8, 12, 20),
)
DUPLICATES_PREVENTED = Counter(
    "fieldsync_duplicates_prevented_total",
    "Resends recognised by content and answered as replays (no new row, no new version).",
)
CONFLICTS = Counter(
    "fieldsync_conflicts_total",
    "Version conflicts detected, and explicit resolutions (override/merge) accepted.",
    labelnames=("resolution",),
)
SYNC_BATCH_SIZE = Histogram(
    "fieldsync_sync_batch_size",
    "Items per /submissions/batch request.",
    buckets=(1, 2, 5, 10, 15, 20, 25),
)
AUTH_EVENTS = Counter(
    "fieldsync_auth_events_total",
    "Authentication events.",
    labelnames=("event",),
)


class ScrapeCollector(Protocol):
    def collect(self) -> Iterable[object]: ...


# Collectors computed at scrape time from the database (registered by domain apps in
# AppConfig.ready(); the common layer never imports domain code).
SCRAPE_COLLECTORS: list[ScrapeCollector] = []


def render_latest() -> tuple[bytes, str]:
    """Exposition payload and content type, multiprocess-aware, plus scrape-time gauges."""
    if os.environ.get("PROMETHEUS_MULTIPROC_DIR"):
        registry = CollectorRegistry()
        prometheus_multiprocess.MultiProcessCollector(registry)  # type: ignore[no-untyped-call]
        payload = generate_latest(registry)
    else:
        payload = generate_latest(REGISTRY)
    if SCRAPE_COLLECTORS:
        scrape = CollectorRegistry(auto_describe=False)
        for collector in SCRAPE_COLLECTORS:
            scrape.register(collector)  # type: ignore[arg-type]
        payload += generate_latest(scrape)
    return payload, CONTENT_TYPE_LATEST
