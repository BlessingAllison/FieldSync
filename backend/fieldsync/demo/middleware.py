"""Server-side fault injection for the offline sync simulator (demo mode only).

``X-FS-Simulate: 503 | 429 | slow`` on sync endpoints makes the server behave like an
overloaded upstream so the simulator can show Retry-After handling and backoff for real.
Inert unless ``FIELDSYNC_DEMO_MODE`` is on; production settings refuse to start with it on.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Final

from django.conf import settings
from django.http import HttpRequest, HttpResponse

from fieldsync.common.envelope import error_json_response
from fieldsync.common.errors import ApiError, ErrorCode

HEADER: Final = "HTTP_X_FS_SIMULATE"
_TARGETS: Final = ("/api/v1/submissions", "/api/v1/sync/")
SLOW_SECONDS: Final = 2.0


class DemoFaultMiddleware:
    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        fault = request.META.get(HEADER)
        if not fault or not settings.FIELDSYNC_DEMO_MODE or not request.path.startswith(_TARGETS):
            return self.get_response(request)
        if fault == "503":
            return error_json_response(request, ApiError(ErrorCode.UNAVAILABLE, retry_after=3))
        if fault == "429":
            return error_json_response(request, ApiError(ErrorCode.RATE_LIMITED, retry_after=2))
        if fault == "slow":
            time.sleep(SLOW_SECONDS)
        return self.get_response(request)
