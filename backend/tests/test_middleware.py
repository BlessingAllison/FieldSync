from __future__ import annotations

import gzip
import json
import uuid
from typing import Any

import pytest
from django.test import override_settings
from rest_framework.test import APIClient

pytestmark = pytest.mark.urls("tests.urls")


def test_valid_client_request_id_is_echoed(client: APIClient) -> None:
    request_id = str(uuid.uuid4())
    response = client.get("/api/v1/health/live", HTTP_X_REQUEST_ID=request_id)
    assert response["X-Request-ID"] == request_id
    assert response.json()["meta"]["request_id"] == request_id


@pytest.mark.parametrize("bad", ["not-a-uuid", "x" * 200, "<script>"])
def test_invalid_request_id_is_replaced(client: APIClient, bad: str) -> None:
    response = client.get("/api/v1/health/live", HTTP_X_REQUEST_ID=bad)
    assert response["X-Request-ID"] != bad
    assert uuid.UUID(response["X-Request-ID"])


def test_api_responses_are_no_store_with_strict_csp(client: APIClient) -> None:
    response = client.get("/api/v1/health/live")
    assert response["Cache-Control"] == "no-store"
    assert response["Content-Security-Policy"].startswith("default-src 'none'")
    assert response["X-Content-Type-Options"] == "nosniff"
    assert response["Referrer-Policy"] == "no-referrer"


def test_docs_get_relaxed_same_origin_csp(client: APIClient) -> None:
    response = client.get("/api/v1/docs")
    assert response.status_code == 200
    csp = response["Content-Security-Policy"]
    assert "script-src 'self'" in csp
    assert "cdn" not in csp


def _post_gzip(client: APIClient, raw: bytes, encoding: str = "gzip") -> Any:
    return client.generic(
        "POST",
        "/api/v1/_test/echo",
        data=raw,  # type: ignore[arg-type]  # stubs say str; bytes are supported
        content_type="application/json",
        HTTP_CONTENT_ENCODING=encoding,
    )


def test_gzip_body_is_decompressed(client: APIClient) -> None:
    payload = {"items": [{"n": i} for i in range(200)]}
    response = _post_gzip(client, gzip.compress(json.dumps(payload).encode()))
    assert response.status_code == 200
    assert response.json()["data"]["received"] == payload


@override_settings(FIELDSYNC_MAX_DECOMPRESSED_BYTES=64 * 1024)
def test_gzip_bomb_is_rejected_413() -> None:
    client = APIClient()  # middleware reads the limit at construction
    bomb = gzip.compress(b'{"a":"' + b"0" * (5 * 1024 * 1024) + b'"}')
    assert len(bomb) < 10 * 1024
    response = _post_gzip(client, bomb)
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "payload_too_large"


def test_truncated_gzip_is_400(client: APIClient) -> None:
    data = gzip.compress(b'{"a": 1}')[:-6]
    response = _post_gzip(client, data)
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "malformed_request"


def test_unsupported_encoding_is_415(client: APIClient) -> None:
    response = _post_gzip(client, b"xx", encoding="br")
    assert response.status_code == 415
