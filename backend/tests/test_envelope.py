from __future__ import annotations

import uuid

import pytest
from rest_framework.test import APIClient

pytestmark = pytest.mark.urls("tests.urls")


def test_success_is_enveloped_with_meta(client: APIClient) -> None:
    response = client.get("/api/v1/health/live")
    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    assert body["data"] == {"status": "ok"}
    assert body["error"] is None
    assert body["meta"]["api_version"] == "1"
    assert uuid.UUID(body["meta"]["request_id"])


def test_extra_meta_is_merged(client: APIClient) -> None:
    body = client.post("/api/v1/_test/echo", {"a": 1}, format="json").json()
    assert body["data"] == {"received": {"a": 1}}
    assert body["meta"]["pagination"] == {"next_cursor": None}


def test_api_error_is_enveloped(client: APIClient) -> None:
    response = client.get("/api/v1/_test/raise/api-error")
    assert response.status_code == 409
    body = response.json()
    assert body["success"] is False
    assert body["data"] is None
    assert body["error"] == {
        "code": "conflict_version",
        "message": "This submission was changed on the server.",
        "details": {"server_version": 4},
    }
    assert body["meta"]["request_id"] == response["X-Request-ID"]


def test_validation_errors_carry_codes_never_values(client: APIClient) -> None:
    response = client.post(
        "/api/v1/_test/validate", {"age": "SECRET-VALUE", "sex": "SECRET-SEX"}, format="json"
    )
    assert response.status_code == 422
    body = response.json()
    assert body["error"]["code"] == "validation_failed"
    assert body["error"]["details"] == {"fields": {"age": ["invalid"], "sex": ["invalid_choice"]}}
    assert "SECRET" not in response.content.decode()


def test_throttle_sets_retry_after(client: APIClient) -> None:
    response = client.get("/api/v1/_test/raise/throttled")
    assert response.status_code == 429
    assert response["Retry-After"] == "13"
    assert response.json()["error"]["code"] == "rate_limited"


@pytest.mark.parametrize(
    ("kind", "status", "code"),
    [("permission", 403, "permission_denied"), ("not-authenticated", 401, "token_invalid")],
)
def test_drf_exceptions_map_to_contract_codes(
    client: APIClient, kind: str, status: int, code: str
) -> None:
    response = client.get(f"/api/v1/_test/raise/{kind}")
    assert response.status_code == status
    assert response.json()["error"]["code"] == code


def test_unhandled_exception_is_generic_500(client: APIClient) -> None:
    client.raise_request_exception = False
    response = client.get("/api/v1/_test/raise/crash")
    assert response.status_code == 500
    body = response.json()
    assert body["error"] == {
        "code": "server_error",
        "message": "Something went wrong on the server.",
    }
    assert "Secret" not in response.content.decode()


def test_unknown_route_is_enveloped_404(client: APIClient) -> None:
    response = client.get("/api/v1/does-not-exist")
    assert response.status_code == 404
    body = response.json()
    assert body["error"]["code"] == "not_found"
    assert uuid.UUID(body["meta"]["request_id"])


def test_wrong_method_is_enveloped_405(client: APIClient) -> None:
    response = client.post("/api/v1/health/live", {}, format="json")
    assert response.status_code == 405
    assert response.json()["error"]["code"] == "method_not_allowed"
    assert "GET" in response["Allow"]


def test_malformed_json_is_400(client: APIClient) -> None:
    response = client.post("/api/v1/_test/echo", data=b"{not json", content_type="application/json")
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "malformed_request"


def test_unsupported_content_type_is_415(client: APIClient) -> None:
    response = client.post("/api/v1/_test/echo", data=b"a=1", content_type="text/plain")
    assert response.status_code == 415
    assert response.json()["error"]["code"] == "unsupported_media_type"


def test_no_content_has_empty_body(client: APIClient) -> None:
    response = client.get("/api/v1/_test/raise/none")
    assert response.status_code == 204
    assert response.content == b""
