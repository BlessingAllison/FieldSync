"""Structured logging (structlog → JSON lines on stdout) with a PHI scrubber.

Every log record — from our code via structlog or from Django/gunicorn via the
stdlib bridge — passes through :func:`drop_phi` before rendering. The scrubber
is deliberately key-based and recursive: it is a backstop, not a licence to log
payloads. Code must still never pass submitted values to a logger.
"""

from __future__ import annotations

from collections.abc import Mapping, MutableMapping
from typing import Any, Final

import structlog
from structlog.types import EventDict, Processor, WrappedLogger

REDACTED: Final = "[redacted]"

# Exact keys (case-insensitive) whose values are never logged.
SENSITIVE_KEYS: Final = frozenset(
    {
        "payload",
        "server_copy",
        "password",
        "new_password",
        "old_password",
        "escrow_secret",
        "access",
        "refresh",
        "token",
        "authorization",
        "cookie",
        "set-cookie",
        "patient_label",
        "pin",
    }
)
# Any key with one of these prefixes is treated as patient data.
SENSITIVE_PREFIXES: Final = ("patient_",)


def _is_sensitive(key: object) -> bool:
    if not isinstance(key, str):
        return False
    lowered = key.lower()
    return lowered in SENSITIVE_KEYS or lowered.startswith(SENSITIVE_PREFIXES)


def scrub(value: Any, *, _depth: int = 0) -> Any:
    """Return a copy of ``value`` with sensitive keys redacted at any depth (bounded)."""
    if _depth > 12:
        return REDACTED
    if isinstance(value, Mapping):
        return {
            key: (REDACTED if _is_sensitive(key) else scrub(item, _depth=_depth + 1))
            for key, item in value.items()
        }
    if isinstance(value, list | tuple):
        return [scrub(item, _depth=_depth + 1) for item in value]
    return value


def drop_phi(_logger: WrappedLogger, _method: str, event_dict: EventDict) -> EventDict:
    for key in list(event_dict.keys()):
        if _is_sensitive(key):
            event_dict[key] = REDACTED
        elif key not in {"event", "timestamp", "level", "logger"}:
            event_dict[key] = scrub(event_dict[key])
    return event_dict


def _shared_processors() -> list[Processor]:
    return [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_log_level,
        structlog.stdlib.add_logger_name,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        drop_phi,
    ]


def configure_structlog() -> None:
    structlog.configure(
        processors=[
            *_shared_processors(),
            structlog.stdlib.ProcessorFormatter.wrap_for_formatter,
        ],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )


def build_logging_config(*, level: str, json_output: bool) -> dict[str, Any]:
    """``LOGGING`` dict for Django settings: one stdout handler, structlog formatting."""
    renderer: Processor = (
        structlog.processors.JSONRenderer()
        if json_output
        else structlog.dev.ConsoleRenderer(colors=False)
    )
    formatter: MutableMapping[str, Any] = {
        "()": structlog.stdlib.ProcessorFormatter,
        "processors": [
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            structlog.processors.format_exc_info,
            renderer,
        ],
        "foreign_pre_chain": _shared_processors(),
    }
    return {
        "version": 1,
        "disable_existing_loggers": False,
        "formatters": {"structured": formatter},
        "handlers": {
            "stdout": {"class": "logging.StreamHandler", "formatter": "structured"},
        },
        "root": {"handlers": ["stdout"], "level": level},
        "loggers": {
            # Django's request logger would duplicate our access log line and can include
            # raw paths; our ObservabilityMiddleware logs route templates instead.
            "django.request": {"handlers": ["stdout"], "level": "ERROR", "propagate": False},
            "django.server": {"handlers": [], "level": "ERROR", "propagate": False},
            "django.db.backends": {"level": "WARNING"},
            "gunicorn.access": {"handlers": [], "propagate": False},
            "gunicorn.error": {"handlers": ["stdout"], "level": level, "propagate": False},
        },
    }
