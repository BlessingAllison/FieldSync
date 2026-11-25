from __future__ import annotations

from django.test import override_settings
from rest_framework.test import APIClient


def test_metrics_exposes_request_histogram(client: APIClient) -> None:
    client.get("/api/v1/health/live")
    response = client.get("/api/v1/metrics")
    assert response.status_code == 200
    text = response.content.decode()
    assert "fieldsync_http_request_duration_seconds_bucket" in text
    assert 'route="/api/v1/health/live"' in text
    assert "/api/v1/health/live?" not in text


@override_settings(METRICS_TOKEN="s3cret-token")
def test_metrics_requires_token_when_configured(client: APIClient) -> None:
    assert client.get("/api/v1/metrics").status_code == 401
    wrong = client.get("/api/v1/metrics", HTTP_AUTHORIZATION="Bearer nope")
    assert wrong.status_code == 401
    ok = client.get("/api/v1/metrics", HTTP_AUTHORIZATION="Bearer s3cret-token")
    assert ok.status_code == 200


def test_unmatched_routes_share_one_label(client: APIClient) -> None:
    client.get("/api/v1/random-1")
    client.get("/api/v1/random-2")
    text = client.get("/api/v1/metrics").content.decode()
    assert "random-1" not in text
    assert 'route="unmatched"' in text
