"""Host-run development (``make dev-api``): console logs, DEBUG on, demo features on."""

from __future__ import annotations

import os

os.environ.setdefault(
    "JWT_SIGNING_KEY", "dev-only-insecure-jwt-signing-key-not-for-any-deployment-0"
)
# Fixed dev-only escrow KEK (32 random bytes); real deployments generate their own.
os.environ.setdefault("ESCROW_KEKS", "1:xQZjHaLyXOq+bcAdJZzt9fvVsKx3TjRPZa4lQtYK6Ko=")
os.environ.setdefault(
    "DJANGO_SECRET_KEY", "dev-only-insecure-secret-key-not-for-any-deployment-000"
)
os.environ.setdefault("DJANGO_LOG_FORMAT", "console")

from config.settings.base import *
from fieldsync.common.env import env_bool

DEBUG = True
FIELDSYNC_DEMO_MODE = env_bool("FIELDSYNC_DEMO_MODE", default=True)
# Serve docs assets straight from app directories (no collectstatic outside containers).
WHITENOISE_USE_FINDERS = True
WHITENOISE_AUTOREFRESH = True
