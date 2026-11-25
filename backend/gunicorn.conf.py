"""gunicorn configuration (container runtime)."""

from __future__ import annotations

import os
from typing import Any

bind = "0.0.0.0:8000"
workers = int(os.environ.get("GUNICORN_WORKERS", "2"))
threads = int(os.environ.get("GUNICORN_THREADS", "4"))
worker_class = "gthread"
# Long enough for a 25-item batch on a slow upstream, short enough to shed stuck workers.
timeout = 30
graceful_timeout = 20
keepalive = 5
max_requests = 2000
max_requests_jitter = 200
# Access logging is done by ObservabilityMiddleware with route templates (no raw paths/ids).
accesslog = None
errorlog = "-"
forwarded_allow_ips = "*"  # only nginx can reach the API container
worker_tmp_dir = "/dev/shm"  # noqa: S108 — tmpfs, avoids heartbeat stalls on slow disks


def child_exit(_server: Any, worker: Any) -> None:
    """Drop the dead worker's live-gauge files (prometheus multiprocess mode)."""
    if os.environ.get("PROMETHEUS_MULTIPROC_DIR"):
        from prometheus_client import multiprocess

        multiprocess.mark_process_dead(worker.pid)  # type: ignore[no-untyped-call]
