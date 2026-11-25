from __future__ import annotations

import pytest
from django.db import OperationalError, connection
from rest_framework.test import APIClient


@pytest.mark.django_db
def test_ready_when_database_and_migrations_ok(client: APIClient) -> None:
    response = client.get("/api/v1/health/ready")
    assert response.status_code == 200
    assert response.json()["data"] == {
        "status": "ok",
        "checks": {"database": "ok", "migrations": "ok"},
    }


@pytest.mark.django_db
def test_not_ready_when_database_unavailable(
    client: APIClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    class _BrokenCursor:
        def __enter__(self) -> None:
            raise OperationalError("connection refused")

        def __exit__(self, *args: object) -> None:
            return None

    monkeypatch.setattr(connection, "cursor", lambda: _BrokenCursor())
    response = client.get("/api/v1/health/ready")
    assert response.status_code == 503
    assert response["Retry-After"] == "5"
    body = response.json()
    assert body["error"]["code"] == "unavailable"
    assert body["error"]["details"] == {"checks": {"database": "unavailable"}}


def test_live_supports_head_for_breaker_probe(client: APIClient) -> None:
    response = client.head("/api/v1/health/live")
    assert response.status_code == 200
    assert response.content == b""
