"""DRF exception handler and Django-level fallbacks producing the error envelope.

Validation details are reduced to *field paths → rule codes*. DRF's default
messages can echo submitted input (e.g. ``"'abc' is not a valid choice"``); we
never forward them, because submitted input may be patient data.
"""

from __future__ import annotations

import math
from typing import Any

import structlog
from django.core.exceptions import PermissionDenied as DjangoPermissionDenied
from django.http import Http404, HttpRequest, HttpResponse
from rest_framework import exceptions as drf
from rest_framework.response import Response

from fieldsync.common.envelope import EnvelopedErrorResponse, build_envelope, error_json_response
from fieldsync.common.errors import ApiError, ErrorCode

log = structlog.get_logger(__name__)


def _codes_only(codes: Any) -> Any:
    """Normalise ``ValidationError.get_codes()`` output to JSON-safe lists of strings."""
    if isinstance(codes, dict):
        return {str(key): _codes_only(value) for key, value in codes.items()}
    if isinstance(codes, list):
        return [_codes_only(item) for item in codes]
    return str(codes)


def validation_codes(errors: Any) -> Any:
    """Field path → rule codes for serializer ``errors`` (never messages, never values)."""
    return _codes_only(drf.ValidationError(errors).get_codes())


def to_api_error(exc: Exception) -> ApiError:  # noqa: PLR0911 — one branch per exception family
    if isinstance(exc, ApiError):
        return exc
    if isinstance(exc, drf.ValidationError):
        return ApiError(
            ErrorCode.VALIDATION_FAILED, details={"fields": _codes_only(exc.get_codes())}
        )
    if isinstance(exc, drf.ParseError):
        return ApiError(ErrorCode.MALFORMED_REQUEST)
    if isinstance(exc, drf.NotAuthenticated | drf.AuthenticationFailed):
        return ApiError(ErrorCode.TOKEN_INVALID)
    if isinstance(exc, drf.PermissionDenied | DjangoPermissionDenied):
        return ApiError(ErrorCode.PERMISSION_DENIED)
    if isinstance(exc, drf.NotFound | Http404):
        return ApiError(ErrorCode.NOT_FOUND)
    if isinstance(exc, drf.MethodNotAllowed):
        return ApiError(ErrorCode.METHOD_NOT_ALLOWED)
    if isinstance(exc, drf.NotAcceptable):
        return ApiError(ErrorCode.NOT_ACCEPTABLE)
    if isinstance(exc, drf.UnsupportedMediaType):
        return ApiError(ErrorCode.UNSUPPORTED_MEDIA_TYPE)
    if isinstance(exc, drf.Throttled):
        raw_wait = getattr(exc, "wait", None)
        wait = math.ceil(raw_wait) if raw_wait is not None else None
        return ApiError(ErrorCode.RATE_LIMITED, retry_after=wait)
    return ApiError(ErrorCode.SERVER_ERROR)


def fieldsync_exception_handler(exc: Exception, context: dict[str, Any]) -> Response:
    """``REST_FRAMEWORK['EXCEPTION_HANDLER']`` — always returns an enveloped response."""
    request = context.get("request")
    error = to_api_error(exc)
    if error.code is ErrorCode.SERVER_ERROR and not isinstance(exc, ApiError):
        # exc_info carries the traceback; the PHI filter scrubs any locals-derived keys.
        log.error("api.unhandled_exception", exc_type=type(exc).__name__, exc_info=exc)
    headers: dict[str, str] = {}
    if error.retry_after is not None:
        headers["Retry-After"] = str(error.retry_after)
    if error.status == 401:
        # RFC 7235: every 401 carries a challenge. (Allow for 405 comes from finalize_response.)
        headers["WWW-Authenticate"] = 'Bearer realm="fieldsync"'
    return EnvelopedErrorResponse(
        build_envelope(request=request, data=error.data, error=error),
        status=error.status,
        headers=headers,
    )


# ── Django-level handlers (unknown routes, crashes outside DRF views) ─────────


def handler404(request: HttpRequest, exception: Exception | None = None) -> HttpResponse:
    return error_json_response(request, ApiError(ErrorCode.NOT_FOUND))


def handler500(request: HttpRequest) -> HttpResponse:
    return error_json_response(request, ApiError(ErrorCode.SERVER_ERROR))


def handler400(request: HttpRequest, exception: Exception | None = None) -> HttpResponse:
    return error_json_response(request, ApiError(ErrorCode.MALFORMED_REQUEST))


def handler403(request: HttpRequest, exception: Exception | None = None) -> HttpResponse:
    return error_json_response(request, ApiError(ErrorCode.PERMISSION_DENIED))
