"""Production settings. Refuses to start with unsafe configuration."""

from __future__ import annotations

from django.core.exceptions import ImproperlyConfigured

from config.settings.base import *
from fieldsync.accounts.escrow import parse_keks
from fieldsync.common.env import env_bool

DEBUG = False
FIELDSYNC_DEMO_MODE = env_bool("FIELDSYNC_DEMO_MODE", default=False)

# TLS terminates at the reverse proxy, which sets X-Forwarded-Proto.
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_SSL_REDIRECT = True
SECURE_HSTS_SECONDS = 31_536_000
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
SECURE_HSTS_PRELOAD = False  # opt in deliberately once the domain is final
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
# Health checks are plain HTTP from inside the cluster.
SECURE_REDIRECT_EXEMPT = [r"^api/v1/health/"]

_MIN_SECRET_LENGTH = 50
_INSECURE_MARKERS = ("insecure", "dev-only", "test-only", "build-only", "change-me", "__GENERATE")


def assert_production_safe() -> None:
    problems: list[str] = []
    if FIELDSYNC_DEMO_MODE:
        problems.append("FIELDSYNC_DEMO_MODE must be off (it enables fault injection routes)")
    if len(SECRET_KEY) < _MIN_SECRET_LENGTH or any(m in SECRET_KEY for m in _INSECURE_MARKERS):
        problems.append("DJANGO_SECRET_KEY is missing, short or a known placeholder")
    jwt_key = str(SIMPLE_JWT["SIGNING_KEY"])
    if len(jwt_key) < _MIN_SECRET_LENGTH or any(m in jwt_key for m in _INSECURE_MARKERS):
        problems.append("JWT_SIGNING_KEY is missing, short or a known placeholder")
    if jwt_key == SECRET_KEY:
        problems.append("JWT_SIGNING_KEY must differ from DJANGO_SECRET_KEY")
    try:
        parse_keks(ESCROW_KEKS, ESCROW_ACTIVE_KEY_ID)
    except ImproperlyConfigured as exc:
        problems.append(f"ESCROW_KEKS invalid: {exc}")
    if not METRICS_TOKEN:
        problems.append("METRICS_TOKEN must be set so /metrics is not public")
    if not ALLOWED_HOSTS or "*" in ALLOWED_HOSTS:
        problems.append("DJANGO_ALLOWED_HOSTS must list explicit host names")
    if problems:
        raise ImproperlyConfigured("Unsafe production configuration: " + "; ".join(problems))


assert_production_safe()
