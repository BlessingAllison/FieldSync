"""pytest settings: real PostgreSQL (never SQLite — locking/upsert semantics differ)."""

from __future__ import annotations

import os

os.environ.setdefault(
    "JWT_SIGNING_KEY", "test-only-insecure-jwt-signing-key-not-for-any-deployment"
)
os.environ.setdefault(
    "ESCROW_KEKS",
    "1:BSjm6Am7Ly4jVS+bJ87ftZ9FmTba+RgMYcxqhHNjKJ4=,2:l5HOC1w/Jb3DSxzdVuHqCguEurXyithpbrOmiTPi+WQ=",
)
os.environ.setdefault(
    "DJANGO_SECRET_KEY", "test-only-insecure-secret-key-not-for-any-deployment-00"
)
os.environ.setdefault("DJANGO_LOG_FORMAT", "console")
os.environ.setdefault("DJANGO_LOG_LEVEL", "WARNING")

from config.settings.base import *

DEBUG = False
FIELDSYNC_DEMO_MODE = False
METRICS_TOKEN = ""
STORAGES = {
    "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
}
# Serve docs assets straight from app directories (no collectstatic outside containers).
WHITENOISE_USE_FINDERS = True
WHITENOISE_AUTOREFRESH = True
# Fast hashing keeps the auth suite quick; Argon2 itself is exercised in test_settings_prod.
PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]
