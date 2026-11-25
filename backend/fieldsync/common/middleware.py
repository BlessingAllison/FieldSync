"""Request pipeline middleware.

Order (see ``settings.base.MIDDLEWARE``):

1. :class:`RequestIdMiddleware` — assign/propagate ``X-Request-ID``; bind it into log context.
2. :class:`ObservabilityMiddleware` — one access-log line + latency histogram per request,
   labelled by *route template* (``/api/v1/submissions/{id}``), never the raw path.
3. Django ``SecurityMiddleware`` / WhiteNoise.
4. :class:`ApiHeadersMiddleware` — ``Cache-Control: no-store`` and a locked-down CSP on ``/api``.
5. :class:`GzipRequestMiddleware` — bounded decompression of ``Content-Encoding: gzip`` bodies.
"""

from __future__ import annotations

import io
import time
import uuid
import zlib
from collections.abc import Callable
from typing import Final

import structlog
from django.conf import settings
from django.http import HttpRequest, HttpResponse

from fieldsync.common.envelope import error_json_response
from fieldsync.common.errors import ApiError, ErrorCode
from fieldsync.common.metrics import HTTP_REQUEST_DURATION, HTTP_REQUESTS_REJECTED

GetResponse = Callable[[HttpRequest], HttpResponse]

REQUEST_ID_HEADER: Final = "X-Request-ID"
_API_PREFIX: Final = "/api/"
_DOCS_PREFIXES: Final = ("/api/v1/docs", "/api/v1/redoc", "/api/static/", "/api/admin/")

# JSON API responses never need to load anything; the docs UIs need same-origin assets.
_API_CSP: Final = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
_DOCS_CSP: Final = (
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
    "script-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'"
)

log = structlog.get_logger("fieldsync.http")


def _parse_request_id(raw: str | None) -> str | None:
    if not raw or len(raw) > 64:
        return None
    try:
        return str(uuid.UUID(raw))
    except ValueError:
        return None


class RequestIdMiddleware:
    """Accept a client-supplied UUID request id (the PWA sends one per attempt) or mint one."""

    def __init__(self, get_response: GetResponse) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        request_id = _parse_request_id(request.headers.get(REQUEST_ID_HEADER)) or str(uuid.uuid4())
        request.request_id = request_id  # type: ignore[attr-defined]
        structlog.contextvars.clear_contextvars()
        structlog.contextvars.bind_contextvars(request_id=request_id)
        try:
            response = self.get_response(request)
        finally:
            structlog.contextvars.clear_contextvars()
        response[REQUEST_ID_HEADER] = request_id
        return response


def _route_template(request: HttpRequest) -> str:
    match = getattr(request, "resolver_match", None)
    route = getattr(match, "route", None)
    if isinstance(route, str) and route:
        return "/" + route.replace("<", "{").replace(">", "}").lstrip("/")
    return "unmatched"


class ObservabilityMiddleware:
    def __init__(self, get_response: GetResponse) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        started = time.perf_counter()
        response = self.get_response(request)
        elapsed = time.perf_counter() - started
        route = _route_template(request)
        status_class = f"{response.status_code // 100}xx"
        HTTP_REQUEST_DURATION.labels(request.method or "", route, status_class).observe(elapsed)
        if request.path.startswith(_API_PREFIX) and route != "/api/v1/health/live":
            log.info(
                "http.request",
                method=request.method,
                route=route,
                status=response.status_code,
                duration_ms=round(elapsed * 1000, 1),
                app_version=request.headers.get("X-App-Version"),
            )
        return response


class ApiHeadersMiddleware:
    def __init__(self, get_response: GetResponse) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        response = self.get_response(request)
        if request.path.startswith(_API_PREFIX):
            if request.path.startswith(_DOCS_PREFIXES):
                response.setdefault("Content-Security-Policy", _DOCS_CSP)
            else:
                response.setdefault("Content-Security-Policy", _API_CSP)
                # Health data must never land in a browser, proxy or SW cache.
                response["Cache-Control"] = "no-store"
                response["Pragma"] = "no-cache"
        return response


class GzipRequestMiddleware:
    """Transparently decompress ``Content-Encoding: gzip`` request bodies, with a hard cap.

    The PWA gzips sync batches with ``CompressionStream`` (form JSON compresses 4-6x,
    which matters on metered 3G). Decompression is streamed with ``max_length`` so a
    small "zip bomb" cannot allocate more than ``FIELDSYNC_MAX_DECOMPRESSED_BYTES``.
    """

    def __init__(self, get_response: GetResponse) -> None:
        self.get_response = get_response
        self.limit: int = settings.FIELDSYNC_MAX_DECOMPRESSED_BYTES

    def __call__(self, request: HttpRequest) -> HttpResponse:
        encoding = request.headers.get("Content-Encoding", "").strip().lower()
        if encoding in {"", "identity"}:
            return self.get_response(request)
        if encoding != "gzip":
            HTTP_REQUESTS_REJECTED.labels("content_encoding").inc()
            return error_json_response(request, ApiError(ErrorCode.UNSUPPORTED_MEDIA_TYPE))
        try:
            decompressed = self._decompress(request.body)
        except _TooLargeError:
            HTTP_REQUESTS_REJECTED.labels("decompressed_too_large").inc()
            return error_json_response(request, ApiError(ErrorCode.PAYLOAD_TOO_LARGE))
        except (zlib.error, _TruncatedError):
            HTTP_REQUESTS_REJECTED.labels("bad_gzip").inc()
            return error_json_response(request, ApiError(ErrorCode.MALFORMED_REQUEST))
        # Replace the body for everything downstream (DRF reads request.body / request.stream).
        request._body = decompressed
        request._stream = io.BytesIO(decompressed)
        request.META["CONTENT_LENGTH"] = str(len(decompressed))
        request.META.pop("HTTP_CONTENT_ENCODING", None)
        return self.get_response(request)

    def _decompress(self, compressed: bytes) -> bytes:
        decompressor = zlib.decompressobj(wbits=16 + zlib.MAX_WBITS)
        output = decompressor.decompress(compressed, self.limit + 1)
        if len(output) > self.limit or decompressor.unconsumed_tail:
            raise _TooLargeError
        output += decompressor.flush()
        if len(output) > self.limit:
            raise _TooLargeError
        if not decompressor.eof:
            raise _TruncatedError
        return output


class _TooLargeError(Exception):
    pass


class _TruncatedError(Exception):
    pass
