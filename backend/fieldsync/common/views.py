"""Operational endpoints: liveness, readiness, Prometheus metrics."""

from __future__ import annotations

import hmac
from typing import Any

from django.conf import settings
from django.db import DatabaseError, connection
from django.db.migrations.executor import MigrationExecutor
from django.http import HttpRequest, HttpResponse
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework import serializers
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.views import APIView

from fieldsync.common.envelope import ApiResponse, error_json_response
from fieldsync.common.errors import ApiError, ErrorCode
from fieldsync.common.metrics import render_latest
from fieldsync.common.openapi import ErrorEnvelopeSerializer, enveloped


class LiveSerializer(serializers.Serializer[Any]):
    status = serializers.ChoiceField(choices=["ok"])


class ReadySerializer(serializers.Serializer[Any]):
    status = serializers.ChoiceField(choices=["ok"])
    checks = serializers.DictField(child=serializers.ChoiceField(choices=["ok"]))


class LiveView(APIView):
    """Process is up. Cheap enough for the PWA's circuit-breaker probe (``HEAD``)."""

    permission_classes = (AllowAny,)
    authentication_classes = ()
    throttle_classes = ()

    @extend_schema(
        operation_id="health_live",
        tags=["health"],
        responses={200: enveloped(LiveSerializer, "HealthLive")},
    )
    def get(self, request: Request) -> ApiResponse:
        return ApiResponse({"status": "ok"})


def readiness_checks() -> dict[str, str]:
    checks: dict[str, str] = {}
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
        checks["database"] = "ok"
    except DatabaseError:
        checks["database"] = "unavailable"
        return checks
    executor = MigrationExecutor(connection)
    plan = executor.migration_plan(executor.loader.graph.leaf_nodes())
    checks["migrations"] = "ok" if not plan else "pending"
    return checks


class ReadyView(APIView):
    """Database reachable and every migration applied. Used by orchestration, not by the PWA."""

    permission_classes = (AllowAny,)
    authentication_classes = ()
    throttle_classes = ()

    @extend_schema(
        operation_id="health_ready",
        tags=["health"],
        responses={
            200: enveloped(ReadySerializer, "HealthReady"),
            503: OpenApiResponse(ErrorEnvelopeSerializer, description="Not ready"),
        },
    )
    def get(self, request: Request) -> ApiResponse:
        checks = readiness_checks()
        if any(state != "ok" for state in checks.values()):
            raise ApiError(ErrorCode.UNAVAILABLE, details={"checks": checks}, retry_after=5)
        return ApiResponse({"status": "ok", "checks": checks})


def metrics_view(request: HttpRequest) -> HttpResponse:
    """Prometheus exposition. Requires ``Authorization: Bearer $METRICS_TOKEN`` when configured.

    Plain Django view: the exposition format is text, not an API resource, so it is
    neither enveloped nor part of the OpenAPI schema.
    """
    expected: str = settings.METRICS_TOKEN
    if expected:
        supplied = request.headers.get("Authorization", "")
        if not hmac.compare_digest(supplied.encode(), f"Bearer {expected}".encode()):
            return error_json_response(request, ApiError(ErrorCode.TOKEN_INVALID))
    payload, content_type = render_latest()
    response = HttpResponse(payload, content_type=content_type)
    response["Cache-Control"] = "no-store"
    return response
