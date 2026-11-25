"""Production settings must refuse unsafe configuration (checked in a clean interpreter)."""

from __future__ import annotations

import base64
import os
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
GOOD_SECRET = "k" * 64
GOOD_JWT_KEY = "j" * 64
GOOD_KEKS = "1:" + base64.b64encode(b"\x01" * 32).decode()


def _import_prod(**overrides: str) -> subprocess.CompletedProcess[str]:
    env = {
        "PATH": os.environ.get("PATH", ""),
        "DJANGO_SECRET_KEY": GOOD_SECRET,
        "JWT_SIGNING_KEY": GOOD_JWT_KEY,
        "ESCROW_KEKS": GOOD_KEKS,
        "DATABASE_URL": "postgres://u:p@localhost:5432/x",
        "METRICS_TOKEN": "m" * 32,
        "DJANGO_ALLOWED_HOSTS": "fieldsync.example.org",
        "FIELDSYNC_DEMO_MODE": "0",
        **overrides,
    }
    return subprocess.run(  # noqa: S603 — fixed interpreter and arguments
        [sys.executable, "-c", "import config.settings.prod"],
        cwd=BACKEND,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


def test_safe_configuration_imports() -> None:
    result = _import_prod()
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize(
    ("override", "message"),
    [
        ({"FIELDSYNC_DEMO_MODE": "1"}, "FIELDSYNC_DEMO_MODE"),
        ({"DJANGO_SECRET_KEY": "short"}, "DJANGO_SECRET_KEY"),
        ({"DJANGO_SECRET_KEY": "dev-only-" + "x" * 60}, "DJANGO_SECRET_KEY"),
        ({"METRICS_TOKEN": ""}, "METRICS_TOKEN"),
        ({"DJANGO_ALLOWED_HOSTS": "*"}, "DJANGO_ALLOWED_HOSTS"),
        ({"JWT_SIGNING_KEY": "short"}, "JWT_SIGNING_KEY"),
        ({"JWT_SIGNING_KEY": GOOD_SECRET}, "must differ"),
        ({"ESCROW_KEKS": "1:dG9vLXNob3J0"}, "ESCROW_KEKS"),
    ],
)
def test_unsafe_configuration_is_refused(override: dict[str, str], message: str) -> None:
    result = _import_prod(**override)
    assert result.returncode != 0
    assert "ImproperlyConfigured" in result.stderr
    assert message in result.stderr
