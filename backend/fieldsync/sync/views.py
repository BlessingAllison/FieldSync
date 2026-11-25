from __future__ import annotations

from typing import Any

from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import serializers
from rest_framework.request import Request
from rest_framework.views import APIView

from fieldsync.accounts.authentication import auth_context
from fieldsync.common.envelope import ApiResponse, get_request_id
from fieldsync.common.openapi import enveloped
from fieldsync.submissions.serializers import DeviceStateSerializer
from fieldsync.sync.services import apply_device_state, sync_status


class HeartbeatResultSerializer(serializers.Serializer[Any]):
    facilities_applied = serializers.IntegerField()


class FacilityHealthSerializer(serializers.Serializer[Any]):
    facility_id = serializers.UUIDField()
    code = serializers.CharField()
    name = serializers.CharField()
    county = serializers.CharField()
    health = serializers.ChoiceField(choices=["healthy", "degraded", "stale", "unknown"])
    reasons = serializers.ListField(child=serializers.CharField())
    last_success_at = serializers.DateTimeField(allow_null=True)
    pending_on_devices = serializers.IntegerField()
    oldest_pending_at = serializers.DateTimeField(allow_null=True)
    failed = serializers.IntegerField()
    conflicts = serializers.IntegerField()
    stuck = serializers.IntegerField()
    rejected_open = serializers.IntegerField()
    devices_active = serializers.IntegerField()
    devices_silent_72h = serializers.IntegerField()
    submissions_24h = serializers.IntegerField()
    first_attempt_success_7d = serializers.FloatField(allow_null=True)
    acks_7d = serializers.IntegerField()
    first_attempt_7d = serializers.IntegerField()
    mean_attempts_7d = serializers.FloatField(allow_null=True)


class SyncStatusSerializer(serializers.Serializer[Any]):
    generated_at = serializers.DateTimeField()
    scope = serializers.DictField()
    thresholds = serializers.DictField()
    summary = serializers.DictField()
    facilities = FacilityHealthSerializer(many=True)


class HeartbeatView(APIView):
    @extend_schema(
        operation_id="sync_heartbeat",
        tags=["sync"],
        request=DeviceStateSerializer,
        description="Device queue state when there is nothing to upload (ADD §12.7).",
        responses={200: enveloped(HeartbeatResultSerializer, "Heartbeat")},
    )
    def post(self, request: Request) -> ApiResponse:
        ctx = auth_context(request)
        body = DeviceStateSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        applied = apply_device_state(
            device=ctx.device,
            scope=ctx.scope,
            facilities=body.validated_data["facilities"],
            request_id=get_request_id(request),
        )
        return ApiResponse({"facilities_applied": applied})


class SyncStatusView(APIView):
    @extend_schema(
        operation_id="submissions_sync_status",
        tags=["sync"],
        parameters=[OpenApiParameter("county", str, description="County code filter")],
        responses={200: enveloped(SyncStatusSerializer, "SyncStatus")},
    )
    def get(self, request: Request) -> ApiResponse:
        scope = auth_context(request).scope
        return ApiResponse(sync_status(scope, county_code=request.query_params.get("county")))
