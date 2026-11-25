"""Settings shared by every environment. Environment modules layer on top of this.

Secrets and deployment-specific values come from the environment only
(see ``.env.example`` at the repository root).
"""

from __future__ import annotations

from datetime import timedelta
from pathlib import Path
from typing import Any

import django_stubs_ext

from fieldsync.common.env import (
    database_url_from_env,
    env_bool,
    env_int,
    env_list,
    env_str,
    parse_database_url,
)
from fieldsync.common.logging import build_logging_config, configure_structlog

# Runtime support for typed generics such as ModelAdmin[Model] (django-stubs).
django_stubs_ext.monkeypatch()

BASE_DIR = Path(__file__).resolve().parents[2]  # backend/

# ── Core ─────────────────────────────────────────────────────────────────────
SECRET_KEY = env_str("DJANGO_SECRET_KEY")
DEBUG = False
ALLOWED_HOSTS = env_list("DJANGO_ALLOWED_HOSTS", default=["localhost", "127.0.0.1"])
ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

LANGUAGE_CODE = "en"
TIME_ZONE = "UTC"
USE_I18N = False  # the API returns codes; the PWA localises
USE_TZ = True

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "django.contrib.postgres",
    "rest_framework",
    "rest_framework_simplejwt.token_blacklist",
    "drf_spectacular",
    "drf_spectacular_sidecar",
    "fieldsync.common",
    "fieldsync.facilities",
    "fieldsync.accounts",
    "fieldsync.formtemplates",
    "fieldsync.submissions",
    "fieldsync.sync",
    "fieldsync.demo",
]

AUTH_USER_MODEL = "accounts.User"

MIDDLEWARE = [
    "fieldsync.common.middleware.RequestIdMiddleware",
    "fieldsync.common.middleware.ObservabilityMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "fieldsync.common.middleware.ApiHeadersMiddleware",
    "fieldsync.common.middleware.GzipRequestMiddleware",
    "fieldsync.demo.middleware.DemoFaultMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    # Session + CSRF serve only the Django admin back-office; the API is JWT-only and
    # DRF views are CSRF-exempt by design.
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,  # admin + drf-spectacular's Swagger/Redoc templates
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ]
        },
    }
]

# ── Database ─────────────────────────────────────────────────────────────────
DATABASES = {
    "default": parse_database_url(database_url_from_env()).as_django(
        conn_max_age=env_int("DB_CONN_MAX_AGE", default=60, minimum=0)
    )
}

# ── Static (only the self-hosted API docs assets; the PWA is served by nginx) ─
STATIC_URL = "/api/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
STORAGES = {
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage"},
}

# ── Request limits ───────────────────────────────────────────────────────────
# Raw (possibly compressed) body cap enforced by Django; decompressed cap by our middleware.
DATA_UPLOAD_MAX_MEMORY_SIZE = 1024 * 1024
FIELDSYNC_MAX_DECOMPRESSED_BYTES = env_int(
    "FIELDSYNC_MAX_DECOMPRESSED_BYTES", default=512 * 1024, minimum=64 * 1024
)
APPEND_SLASH = False  # the API has no trailing slashes; redirects would break POST retries

# ── Auth ─────────────────────────────────────────────────────────────────────
PASSWORD_HASHERS = [
    "django.contrib.auth.hashers.Argon2PasswordHasher",
    "django.contrib.auth.hashers.PBKDF2PasswordHasher",
]
AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {
        "NAME": "django.contrib.auth.password_validation.MinimumLengthValidator",
        "OPTIONS": {"min_length": 10},
    },
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
]
# Progressive lockout (ADD §11.1): after N consecutive failures, lock for M minutes.
LOGIN_MAX_FAILURES = env_int("LOGIN_MAX_FAILURES", default=5, minimum=1)
LOGIN_LOCKOUT_MINUTES = env_int("LOGIN_LOCKOUT_MINUTES", default=15, minimum=1)

JWT_ACCESS_TTL = timedelta(seconds=env_int("JWT_ACCESS_TTL_SECONDS", default=600, minimum=60))
JWT_REFRESH_TTL = timedelta(days=env_int("JWT_REFRESH_TTL_DAYS", default=14, minimum=1))
JWT_REFRESH_ABSOLUTE = timedelta(days=env_int("JWT_REFRESH_ABSOLUTE_DAYS", default=30, minimum=1))
JWT_REFRESH_COOKIE = "fs_rt"
JWT_REFRESH_COOKIE_PATH = "/api/v1/auth/"
JWT_REFRESH_COOKIE_SECURE = env_bool("JWT_REFRESH_COOKIE_SECURE", default=True)

SIMPLE_JWT = {
    "ALGORITHM": "HS256",
    "SIGNING_KEY": env_str("JWT_SIGNING_KEY"),
    "ACCESS_TOKEN_LIFETIME": JWT_ACCESS_TTL,
    "REFRESH_TOKEN_LIFETIME": JWT_REFRESH_TTL,
    "ROTATE_REFRESH_TOKENS": True,
    "BLACKLIST_AFTER_ROTATION": True,
    "UPDATE_LAST_LOGIN": False,
    "USER_ID_FIELD": "id",
    "USER_ID_CLAIM": "sub",
    "TOKEN_TYPE_CLAIM": "typ",
    "JTI_CLAIM": "jti",
    "AUTH_HEADER_TYPES": ("Bearer",),
    "LEEWAY": 30,  # seconds of clock skew tolerated between API workers
}

# Device key-escrow KEKs (ADD §11.4.3): "<id>:<base64 32 bytes>,…"
ESCROW_KEKS = env_str("ESCROW_KEKS")
ESCROW_ACTIVE_KEY_ID = env_int("ESCROW_ACTIVE_KEY_ID", default=1, minimum=1)

# ── DRF ──────────────────────────────────────────────────────────────────────
REST_FRAMEWORK: dict[str, Any] = {
    "DEFAULT_RENDERER_CLASSES": ["fieldsync.common.envelope.EnvelopeJSONRenderer"],
    "DEFAULT_PARSER_CLASSES": ["rest_framework.parsers.JSONParser"],
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "fieldsync.accounts.authentication.DeviceBoundJWTAuthentication"
    ],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
    "EXCEPTION_HANDLER": "fieldsync.common.exceptions.fieldsync_exception_handler",
    "DEFAULT_SCHEMA_CLASS": "drf_spectacular.openapi.AutoSchema",
    "DEFAULT_THROTTLE_CLASSES": [
        "rest_framework.throttling.AnonRateThrottle",
        "rest_framework.throttling.UserRateThrottle",
        "rest_framework.throttling.ScopedRateThrottle",
    ],
    "DEFAULT_THROTTLE_RATES": {
        "anon": env_str("THROTTLE_ANON", "120/min"),
        # Sync bursts (500-item backlog = ~20-50 batch requests) must never be throttled.
        "user": env_str("THROTTLE_USER", "1200/min"),
        "login": env_str("THROTTLE_LOGIN", "10/min"),
        "refresh": env_str("THROTTLE_REFRESH", "60/min"),
    },
    "NUM_PROXIES": env_int("NUM_PROXIES", default=1, minimum=0),
}

SPECTACULAR_SETTINGS = {
    "TITLE": "FieldSync API",
    "DESCRIPTION": (
        "Offline-first health data collection API (demonstration project — no real patient "
        "data). Every response uses the envelope `{success, data, error, meta}`; error codes "
        "are listed in `contracts/error-codes.json`."
    ),
    "VERSION": "1.0.0",
    "OAS_VERSION": "3.1.0",
    "SERVE_INCLUDE_SCHEMA": False,
    "SWAGGER_UI_DIST": "SIDECAR",
    "SWAGGER_UI_FAVICON_HREF": "SIDECAR",
    "REDOC_DIST": "SIDECAR",
    "COMPONENT_SPLIT_REQUEST": True,
    "SCHEMA_PATH_PREFIX": r"/api/v1",
    "SERVERS": [{"url": "/", "description": "Same origin as the PWA"}],
    # bearerAuth comes from the DeviceBoundJWTScheme extension, per operation.
    "ENUM_NAME_OVERRIDES": {
        "HealthCheckStatusEnum": ["ok"],
        "SubmissionStatusEnum": "fieldsync.submissions.models.SubmissionStatus",
        "TemplateStatusEnum": "fieldsync.formtemplates.models.TemplateStatus",
        "RoleEnum": "fieldsync.accounts.models.Role",
    },
}

# ── Security (hardened further in prod) ──────────────────────────────────────
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "no-referrer"
SECURE_CROSS_ORIGIN_OPENER_POLICY = "same-origin"
X_FRAME_OPTIONS = "DENY"

# ── Observability ────────────────────────────────────────────────────────────
METRICS_TOKEN = env_str("METRICS_TOKEN", "")
LOG_LEVEL = env_str("DJANGO_LOG_LEVEL", "INFO").upper()
LOG_JSON = env_str("DJANGO_LOG_FORMAT", "json").lower() == "json"
configure_structlog()
LOGGING = build_logging_config(level=LOG_LEVEL, json_output=LOG_JSON)

# ── FieldSync ────────────────────────────────────────────────────────────────
FIELDSYNC_DEMO_MODE = env_bool("FIELDSYNC_DEMO_MODE", default=False)
# Shared contracts (meta-schema). Repo layout by default; the image sets it explicitly.
FIELDSYNC_CONTRACTS_DIR = Path(
    env_str("FIELDSYNC_CONTRACTS_DIR", str(BASE_DIR.parent / "contracts"))
)
# Template lifecycle: how long a superseded/retired version still accepts submissions
# captured offline before the change (ADD §13.3).
TEMPLATE_ACCEPT_GRACE_DAYS = env_int("TEMPLATE_ACCEPT_GRACE_DAYS", default=30, minimum=0)
# Per-submission payload cap (ADD §8.2).
SUBMISSION_MAX_PAYLOAD_BYTES = 64 * 1024
SUBMISSION_BATCH_MAX_ITEMS = 25
# Sync health thresholds (ADD §14.2).
SYNC_HEALTH_DEGRADED_AFTER_HOURS = env_int("SYNC_HEALTH_DEGRADED_AFTER_HOURS", default=24)
SYNC_HEALTH_STALE_AFTER_HOURS = env_int("SYNC_HEALTH_STALE_AFTER_HOURS", default=72)
SYNC_HEALTH_MIN_FIRST_ATTEMPT_SUCCESS = 0.8
# Retention of the append-only sync observation log (prune_sync_events).
SYNC_EVENT_RETENTION_DAYS = env_int("SYNC_EVENT_RETENTION_DAYS", default=180, minimum=1)
# Scrape-time sync-health gauges are memoised per process this long (national aggregation
# measured at ~0.3 s; see fieldsync/sync/metrics.py). 0 disables the memo.
SYNC_METRICS_CACHE_SECONDS = env_int("SYNC_METRICS_CACHE_SECONDS", default=60, minimum=0)
# Device clock skew above this is flagged on the dashboard.
CLOCK_SKEW_FLAG_MS = 10 * 60 * 1000
