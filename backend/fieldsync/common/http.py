"""Conditional GET helpers: reference data is fetched with If-None-Match (≈200-byte 304s on 3G)."""

from __future__ import annotations

import hashlib
import json
from typing import Any

from django.core.serializers.json import DjangoJSONEncoder
from rest_framework.request import Request

from fieldsync.common.envelope import ApiResponse


def etag_for(data: Any) -> str:
    body = json.dumps(data, sort_keys=True, cls=DjangoJSONEncoder, separators=(",", ":"))
    return '"' + hashlib.sha256(body.encode()).hexdigest()[:32] + '"'


def conditional_response(request: Request, data: Any) -> ApiResponse:
    etag = etag_for(data)
    candidates = {tag.strip() for tag in request.META.get("HTTP_IF_NONE_MATCH", "").split(",")}
    if etag in candidates or f"W/{etag}" in candidates:
        response = ApiResponse(None, status=304)
    else:
        response = ApiResponse(data)
    response["ETag"] = etag
    # Private, revalidate every time: never served stale, never stored by shared caches.
    response["Cache-Control"] = "private, no-cache"
    return response
