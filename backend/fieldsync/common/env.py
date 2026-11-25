"""Typed environment-variable access.

Settings modules read configuration exclusively through these helpers so that a
missing or malformed variable fails at import time with a message naming the
variable, instead of surfacing later as an obscure runtime error.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Final
from urllib.parse import unquote, urlparse

from django.core.exceptions import ImproperlyConfigured

_TRUE: Final = frozenset({"1", "true", "yes", "on"})
_FALSE: Final = frozenset({"0", "false", "no", "off", ""})
_MISSING: Final = object()


def env_str(name: str, default: str | object = _MISSING) -> str:
    value = os.environ.get(name)
    if value is None:
        if default is _MISSING:
            raise ImproperlyConfigured(f"Environment variable {name} is required")
        if not isinstance(default, str):
            raise TypeError("default must be a string")
        return default
    return value


def env_bool(name: str, *, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    lowered = raw.strip().lower()
    if lowered in _TRUE:
        return True
    if lowered in _FALSE:
        return False
    raise ImproperlyConfigured(f"Environment variable {name} must be a boolean, got {raw!r}")


def env_int(name: str, *, default: int, minimum: int | None = None) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ImproperlyConfigured(f"Environment variable {name} must be an integer") from exc
    if minimum is not None and value < minimum:
        raise ImproperlyConfigured(f"Environment variable {name} must be >= {minimum}")
    return value


def env_list(name: str, *, default: list[str]) -> list[str]:
    raw = os.environ.get(name)
    if raw is None:
        return list(default)
    return [item.strip() for item in raw.split(",") if item.strip()]


@dataclass(frozen=True, slots=True)
class DatabaseUrl:
    name: str
    user: str
    password: str
    host: str
    port: int

    def as_django(self, *, conn_max_age: int) -> dict[str, object]:
        return {
            "ENGINE": "django.db.backends.postgresql",
            "NAME": self.name,
            "USER": self.user,
            "PASSWORD": self.password,
            "HOST": self.host,
            "PORT": self.port,
            "CONN_MAX_AGE": conn_max_age,
            "CONN_HEALTH_CHECKS": True,
            "ATOMIC_REQUESTS": False,  # transaction boundaries live in the services layer
            "OPTIONS": {"application_name": "fieldsync-api", "connect_timeout": 5},
        }


def parse_database_url(url: str) -> DatabaseUrl:
    """Parse ``postgres://user:password@host:port/name`` (PostgreSQL only, by design)."""
    parsed = urlparse(url)
    if parsed.scheme not in {"postgres", "postgresql"}:
        raise ImproperlyConfigured("DATABASE_URL must use the postgres:// scheme")
    name = parsed.path.lstrip("/")
    if not (parsed.hostname and parsed.username and name):
        raise ImproperlyConfigured("DATABASE_URL must include user, host and database name")
    return DatabaseUrl(
        name=unquote(name),
        user=unquote(parsed.username),
        password=unquote(parsed.password or ""),
        host=parsed.hostname,
        port=parsed.port or 5432,
    )


def database_url_from_env() -> str:
    """``DATABASE_URL`` if set, else compose it from the ``POSTGRES_*`` variables.

    The fallback lets a host-run API (``make dev-api``) talk to the compose
    Postgres published on ``FIELDSYNC_DB_PORT`` using the same ``.env`` file.
    """
    explicit = os.environ.get("DATABASE_URL")
    if explicit:
        return explicit
    user = env_str("POSTGRES_USER", "fieldsync")
    password = env_str("POSTGRES_PASSWORD", "fieldsync")
    name = env_str("POSTGRES_DB", "fieldsync")
    port = env_int("FIELDSYNC_DB_PORT", default=5434)
    return f"postgres://{user}:{password}@127.0.0.1:{port}/{name}"
