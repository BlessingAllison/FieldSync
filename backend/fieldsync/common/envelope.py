"""The standard response envelope: ``{success, data, error, meta}``.

Every JSON response from ``/api`` — including 404s for unknown routes, 500s,
throttling and middleware rejections — goes through :func:`build_envelope`, so
the PWA has exactly one parsing path.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Final

from django.http import HttpRequest, JsonResponse
from rest_framework.renderers import JSONRenderer
from rest_framework.response import Response

from fieldsync.common.errors import ApiError

API_VERSION: Final = "1"


def get_request_id(request: Any) -> str | None:
    """Request id assigned by :class:`RequestIdMiddleware` (works for Django and DRF requests)."""
    value = getattr(request, "request_id", None)
    return value if isinstance(value, str) else None


def build_meta(request: Any, extra: dict[str, Any] | None = None) -> dict[str, Any]:
    meta: dict[str, Any] = {"request_id": get_request_id(request), "api_version": API_VERSION}
    if extra:
        meta.update(extra)
    return meta


def build_envelope(
    *,
    request: Any,
    data: Any = None,
    error: ApiError | None = None,
    meta: dict[str, Any] | None = None,
) -> dict[str, Any]:
    error_body: dict[str, Any] | None = None
    if error is not None:
        error_body = {"code": str(error.code), "message": error.message}
        if error.details:
            error_body["details"] = error.details
    return {
        "success": error is None,
        "data": data,
        "error": error_body,
        "meta": build_meta(request, meta),
    }


def error_json_response(request: HttpRequest, error: ApiError) -> JsonResponse:
    """Envelope response for code paths outside DRF (middleware, Django handlers)."""
    response = JsonResponse(
        build_envelope(request=request, data=error.data, error=error), status=error.status
    )
    if error.retry_after is not None:
        response["Retry-After"] = str(error.retry_after)
    if error.status == 401:
        response["WWW-Authenticate"] = 'Bearer realm="fieldsync"'
    return response


class ApiResponse(Response):
    """DRF response that carries extra ``meta`` (e.g. pagination) for the envelope."""

    def __init__(
        self,
        data: Any = None,
        *,
        status: int | None = None,
        meta: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(data=data, status=status, headers=headers)
        self.envelope_meta = meta or {}


class EnvelopedErrorResponse(Response):
    """Marker type: ``data`` is already a complete error envelope."""


class EnvelopeJSONRenderer(JSONRenderer):
    """Wraps successful payloads in the envelope; passes pre-built envelopes through."""

    def render(
        self,
        data: Any,
        accepted_media_type: str | None = None,
        renderer_context: Mapping[str, Any] | None = None,
    ) -> bytes:
        context = renderer_context or {}
        response = context.get("response")
        request = context.get("request")
        if isinstance(response, EnvelopedErrorResponse):
            body = data
        elif response is not None and response.status_code in {204, 304}:
            return b""
        else:
            meta = response.envelope_meta if isinstance(response, ApiResponse) else None
            body = build_envelope(request=request, data=data, meta=meta)
        rendered: bytes = super().render(body, accepted_media_type, renderer_context)
        return rendered
