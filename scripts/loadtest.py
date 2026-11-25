#!/usr/bin/env python3
"""API load test for the ADD §4 budget: single-submission upsert p95 <= 150 ms at 50 req/s.

Standard library only (no install step). Open-loop: requests are *scheduled* at a constant
arrival rate and latency is measured from the scheduled time, so a slow server cannot hide
its queueing by slowing the generator down (no coordinated omission).

Traffic model: N CHW devices (the per-user throttle is 1200/min, so 50 req/s is several
phones, not one), 90 % new forms and 10 % resends of an already-acknowledged form (the
idempotent replay path a phone takes after a lost acknowledgement). Synthetic data only.

    LOADTEST_PASSWORD=... python3 scripts/loadtest.py --rate 50 --duration 60
    LOADTEST_PASSWORD=... python3 scripts/loadtest.py --mode batch --rate 2 --duration 60

Latency is client-observed through nginx on the same host: an upper bound on server time.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import secrets
import statistics
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

DEFAULT_USERS = ("chw.bong.1", "chw.bong.2", "chw.nimba.1")


def uuid7() -> str:
    ms = int(time.time() * 1000)
    rand = secrets.randbits(74)
    value = (ms & ((1 << 48) - 1)) << 80 | 0x7 << 76 | (rand >> 62) << 64 | 0b10 << 62
    value |= rand & ((1 << 62) - 1)
    return str(uuid.UUID(int=value))


@dataclass
class Device:
    username: str
    access: str
    facility_ids: list[str]
    acked: list[dict[str, Any]] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock)


def call(
    base: str, method: str, path: str, body: Any, token: str | None = None
) -> tuple[int, dict[str, Any]]:
    headers = {"Content-Type": "application/json", "Origin": base}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(  # noqa: S310 — operator-supplied base URL
        f"{base}/api/v1{path}",
        data=json.dumps(body).encode() if body is not None else None,
        headers=headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        raw = error.read()
        return error.code, json.loads(raw) if raw.startswith(b"{") else {}


def sign_in(base: str, username: str, password: str) -> Device:
    status, body = call(
        base,
        "POST",
        "/auth/login",
        {
            "username": username,
            "password": password,
            "device": {"id": str(uuid.uuid4()), "label": "loadtest", "app_version": "loadtest"},
        },
    )
    if status != 200:
        code = (body.get("error") or {}).get("code")
        sys.exit(f"sign-in failed for {username}: HTTP {status} {code}")
    data = body["data"]
    return Device(username, data["access"], [str(f) for f in data["user"]["facility_ids"]])


def new_item(device: Device) -> dict[str, Any]:
    yesterday = (datetime.now(UTC) - timedelta(days=1)).date().isoformat()
    return {
        "client_uuid": uuid7(),
        "op": "create",
        "template": {"code": "iccm-child-u5", "version": 1},
        "facility_id": random.choice(device.facility_ids),  # noqa: S311 — not crypto
        "captured_at": datetime.now(UTC).isoformat(),
        "base_version": None,
        "resolution": "none",
        "attempt": 1,
        "payload": {
            "patient_ref": f"HH-{random.randint(1000, 9999)}-{random.randint(1, 9):02d}",  # noqa: S311
            "age_months": random.randint(2, 59),  # noqa: S311
            "sex": random.choice(["f", "m"]),  # noqa: S311
            "visit_date": yesterday,
            "fever": False,
        },
    }


def percentile(values: list[float], q: float) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(q * len(ordered)))]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--base", default=os.environ.get("LOADTEST_BASE", "http://localhost:8090"))
    parser.add_argument("--mode", choices=["single", "batch"], default="single")
    parser.add_argument("--rate", type=float, default=50.0, help="requests per second")
    parser.add_argument("--duration", type=float, default=60.0, help="seconds of load")
    parser.add_argument("--warmup", type=float, default=5.0, help="seconds excluded from stats")
    parser.add_argument("--batch-size", type=int, default=25)
    parser.add_argument("--users", default=",".join(DEFAULT_USERS))
    parser.add_argument("--json", help="write the summary here as JSON")
    args = parser.parse_args()
    password = os.environ.get("LOADTEST_PASSWORD")
    if not password:
        sys.exit("set LOADTEST_PASSWORD (the seeded demo password; never pass it on argv)")

    devices = [sign_in(args.base, u, password) for u in args.users.split(",")]
    samples: list[tuple[float, str, int, float]] = []  # (scheduled_at, kind, status, latency_s)
    samples_lock = threading.Lock()

    def fire(index: int, scheduled: float) -> None:
        device = devices[index % len(devices)]
        if args.mode == "batch":
            kind, path = "batch", "/submissions/batch"
            body: Any = {"items": [new_item(device) for _ in range(args.batch_size)]}
        else:
            with device.lock:
                replay = device.acked and random.random() < 0.10  # noqa: S311
                previous = random.choice(device.acked) if replay else None  # noqa: S311
            kind = "replay" if previous else "create"
            body = previous or new_item(device)
            path = "/submissions"
        status, _ = call(args.base, "POST", path, body, device.access)
        latency = time.perf_counter() - scheduled
        if kind == "create" and status == 201:
            with device.lock:
                device.acked.append(body)
        with samples_lock:
            samples.append((scheduled, kind, status, latency))

    total = int(args.rate * args.duration)
    interval = 1.0 / args.rate
    start = time.perf_counter()
    with ThreadPoolExecutor(max_workers=200) as pool:
        for index in range(total):
            scheduled = start + index * interval
            delay = scheduled - time.perf_counter()
            if delay > 0:
                time.sleep(delay)
            pool.submit(fire, index, scheduled)
    elapsed = time.perf_counter() - start

    measured = [s for s in samples if s[0] - start >= args.warmup]
    summary: dict[str, Any] = {
        "mode": args.mode,
        "target_rate": args.rate,
        "achieved_rate": round(len(samples) / elapsed, 1),
        "requests": len(samples),
        "measured_after_warmup": len(measured),
        "statuses": dict(Counter(str(s[2]) for s in measured)),
    }
    for kind in sorted({s[1] for s in measured}):
        latencies = [s[3] * 1000 for s in measured if s[1] == kind]
        summary[kind] = {
            "n": len(latencies),
            "p50_ms": round(statistics.median(latencies), 1),
            "p95_ms": round(percentile(latencies, 0.95), 1),
            "p99_ms": round(percentile(latencies, 0.99), 1),
            "max_ms": round(max(latencies), 1),
        }
    print(json.dumps(summary, indent=2))
    if args.json:
        with open(args.json, "w", encoding="utf-8") as handle:
            json.dump(summary, handle, indent=2)


if __name__ == "__main__":
    main()
