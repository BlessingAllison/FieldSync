"""Submission endpoints (ADD §10.3-10.4)."""

from __future__ import annotations

import base64
import binascii
from collections import Counter
from datetime import datetime
from typing import Any

from django.db.models import Q, QuerySet
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, extend_schema
from rest_framework.request import Request
from rest_framework.views import APIView

from fieldsync.accounts.authentication import AuthContext, auth_context
from fieldsync.accounts.models import User
from fieldsync.accounts.permissions import IsFieldWriter, IsSupervisorOrAdmin
from fieldsync.common import metrics
from fieldsync.common.envelope import ApiResponse, get_request_id
from fieldsync.common.errors import ApiError, ErrorCode
from fieldsync.common.exceptions import validation_codes
from fieldsync.common.openapi import ErrorEnvelopeSerializer, enveloped
from fieldsync.submissions import services
from fieldsync.submissions.models import Submission
from fieldsync.submissions.serializers import (
    BatchRequestSerializer,
    BatchResponseSerializer,
    RetryRequestSerializer,
    ReviewRequestSerializer,
    SubmissionDetailSerializer,
    SubmissionItemSerializer,
    SubmissionSerializer,
    SubmissionVersionSerializer,
    UpsertSuccessSerializer,
)
from fieldsync.sync import events
from fieldsync.sync.models import SyncEventType
from fieldsync.sync.services import apply_device_state

MAX_PAGE = 200


def _clock_skew_ms(request: Request) -> int | None:
    raw = request.META.get("HTTP_X_CLIENT_TIME")
    client_time = parse_datetime(raw) if raw else None
    if client_time is None or client_time.tzinfo is None:
        return None
    return int((timezone.now() - client_time).total_seconds() * 1000)


def _user(request: Request) -> User:
    user = request.user
    if not isinstance(user, User):
        raise ApiError(ErrorCode.TOKEN_INVALID)
    return user


def _context(request: Request, ctx: AuthContext) -> services.UpsertContext:
    return services.UpsertContext(
        user=_user(request),
        device=ctx.device,
        scope=ctx.scope,
        request_id=get_request_id(request),
        clock_skew_ms=_clock_skew_ms(request),
    )


def _item(data: dict[str, Any]) -> services.UpsertItem:
    return services.UpsertItem(
        client_uuid=data["client_uuid"],
        op=data["op"],
        template_code=data["template"]["code"],
        template_version=data["template"]["version"],
        facility_id=data["facility_id"],
        captured_at=data["captured_at"],
        base_version=data.get("base_version"),
        resolution=data["resolution"],
        attempt=data["attempt"],
        payload=data["payload"],
    )


def _result_body(client_uuid: Any, result: services.UpsertResult) -> dict[str, Any]:
    body: dict[str, Any] = {
        "client_uuid": str(client_uuid),
        "outcome": result.outcome,
        "http_status": result.http_status,
    }
    if result.submission is not None:
        body["submission"] = SubmissionSerializer(result.submission).data
    if result.error is not None:
        body["error"] = {"code": str(result.error.code), "message": result.error.message}
        if result.error.details:
            body["error"]["details"] = result.error.details
    if result.server_copy is not None:
        body["server_copy"] = result.server_copy
    return body


def _scoped(request: Request) -> QuerySet[Submission]:
    ctx = auth_context(request)
    return Submission.objects.filter(**ctx.scope.submissions_filter()).select_related("template")


def _get_scoped(request: Request, submission_id: str) -> Submission:
    submission = _scoped(request).filter(id=submission_id).first()
    if submission is None:
        raise ApiError(ErrorCode.NOT_FOUND)
    return submission


class SubmissionCollectionView(APIView):
    permission_classes = (IsFieldWriter,)

    @extend_schema(
        operation_id="submissions_upsert",
        tags=["submissions"],
        request=SubmissionItemSerializer,
        description=(
            "Idempotent upsert keyed by `client_uuid`. Retrying the same content returns "
            "`replayed`; a stale `base_version` returns 409 with the server copy in `data`."
        ),
        responses={
            200: enveloped(UpsertSuccessSerializer, "UpsertSuccess"),
            201: enveloped(UpsertSuccessSerializer, "UpsertCreated"),
            409: OpenApiResponse(ErrorEnvelopeSerializer, description="conflict_version"),
            422: OpenApiResponse(ErrorEnvelopeSerializer, description="validation_failed (stored)"),
        },
    )
    def post(self, request: Request) -> ApiResponse:
        ctx = auth_context(request)
        body = SubmissionItemSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        result = services.upsert(_item(body.validated_data), _context(request, ctx))
        if result.error is not None:
            payload = _result_body(body.validated_data["client_uuid"], result)
            payload.pop("error", None)
            raise ApiError(
                result.error.code,
                result.error.message,
                details=result.error.details,
                data=payload,
                status=result.http_status,
            )
        assert result.submission is not None  # noqa: S101 — success always carries the row
        return ApiResponse(
            {"outcome": result.outcome, "submission": SubmissionSerializer(result.submission).data},
            status=result.http_status,
        )

    @extend_schema(
        operation_id="submissions_list",
        tags=["submissions"],
        parameters=[
            OpenApiParameter("facility", str),
            OpenApiParameter("status", str),
            OpenApiParameter("template", str, description="template code"),
            OpenApiParameter("cursor", str),
            OpenApiParameter("limit", int),
        ],
        responses={200: enveloped(SubmissionSerializer, "SubmissionList", many=True)},
    )
    def get(self, request: Request) -> ApiResponse:
        qs = _scoped(request)
        params = request.query_params
        if facility := params.get("facility"):
            qs = qs.filter(facility_id=facility)
        if status := params.get("status"):
            qs = qs.filter(status=status)
        if template := params.get("template"):
            qs = qs.filter(template__code=template)
        try:
            limit = max(1, min(int(params.get("limit", 50)), MAX_PAGE))
        except ValueError as exc:
            raise ApiError(ErrorCode.MALFORMED_REQUEST) from exc
        if cursor := params.get("cursor"):
            received_at, last_id = _decode_cursor(cursor)
            qs = qs.filter(
                Q(received_at__lt=received_at) | Q(received_at=received_at, id__lt=last_id)
            )
        rows = list(qs.order_by("-received_at", "-id")[: limit + 1])
        next_cursor = _encode_cursor(rows[limit - 1]) if len(rows) > limit else None
        return ApiResponse(
            SubmissionSerializer(rows[:limit], many=True).data,
            meta={"pagination": {"next_cursor": next_cursor, "limit": limit}},
        )


def _encode_cursor(row: Submission) -> str:
    raw = f"{row.received_at.isoformat()}|{row.id}"
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def _decode_cursor(cursor: str) -> tuple[datetime, str]:
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode()
        stamp, _, last_id = raw.partition("|")
        parsed = datetime.fromisoformat(stamp)
    except (ValueError, binascii.Error, UnicodeDecodeError) as exc:
        raise ApiError(ErrorCode.MALFORMED_REQUEST, "Invalid cursor.") from exc
    return parsed, last_id


class SubmissionBatchView(APIView):
    permission_classes = (IsFieldWriter,)

    @extend_schema(
        operation_id="submissions_batch",
        tags=["submissions"],
        request=BatchRequestSerializer,
        description=(
            "Up to 25 independent upserts. Not atomic: each item is its own unit of work and "
            "has its own `outcome`/`http_status`. Optionally piggy-backs the device's queue state."
        ),
        responses={200: enveloped(BatchResponseSerializer, "BatchResponse")},
    )
    def post(self, request: Request) -> ApiResponse:
        ctx = auth_context(request)
        body = BatchRequestSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        upsert_ctx = _context(request, ctx)
        metrics.SYNC_BATCH_SIZE.observe(len(body.validated_data["items"]))
        results: list[dict[str, Any]] = []
        for raw in body.validated_data["items"]:
            item = SubmissionItemSerializer(data=raw)
            if not item.is_valid():
                client_uuid = raw.get("client_uuid") if isinstance(raw, dict) else None
                results.append(
                    {
                        "client_uuid": str(client_uuid) if client_uuid else None,
                        "outcome": "invalid",
                        "http_status": 400,
                        "error": {
                            "code": "malformed_request",
                            "message": "Item is not well-formed.",
                            "details": {"fields": validation_codes(item.errors)},
                        },
                    }
                )
                continue
            result = services.upsert(_item(item.validated_data), upsert_ctx)
            results.append(_result_body(item.validated_data["client_uuid"], result))
        if state := body.validated_data.get("device_state"):
            apply_device_state(
                device=ctx.device,
                scope=ctx.scope,
                facilities=state["facilities"],
                request_id=get_request_id(request),
            )
        events.record(
            SyncEventType.BATCH_RECEIVED,
            request_id=get_request_id(request),
            user_id=upsert_ctx.user.id,
            device_id=ctx.device.id,
            detail={
                "items": len(results),
                "outcomes": dict(Counter(r["outcome"] for r in results)),
            },
        )
        return ApiResponse({"results": results})


class SubmissionDetailView(APIView):
    @extend_schema(
        operation_id="submissions_detail",
        tags=["submissions"],
        responses={
            200: enveloped(SubmissionDetailSerializer, "SubmissionDetail"),
            404: OpenApiResponse(ErrorEnvelopeSerializer),
        },
    )
    def get(self, request: Request, submission_id: str) -> ApiResponse:
        return ApiResponse(SubmissionDetailSerializer(_get_scoped(request, submission_id)).data)


class SubmissionByClientView(APIView):
    @extend_schema(
        operation_id="submissions_by_client_uuid",
        tags=["submissions"],
        responses={
            200: enveloped(SubmissionDetailSerializer, "SubmissionDetail"),
            404: OpenApiResponse(ErrorEnvelopeSerializer),
        },
    )
    def get(self, request: Request, client_uuid: str) -> ApiResponse:
        submission = _scoped(request).filter(client_uuid=client_uuid).first()
        if submission is None:
            raise ApiError(ErrorCode.NOT_FOUND)
        return ApiResponse(SubmissionDetailSerializer(submission).data)


class SubmissionVersionsView(APIView):
    permission_classes = (IsSupervisorOrAdmin,)

    @extend_schema(
        operation_id="submissions_versions",
        tags=["submissions"],
        responses={200: enveloped(SubmissionVersionSerializer, "SubmissionVersions", many=True)},
    )
    def get(self, request: Request, submission_id: str) -> ApiResponse:
        submission = _get_scoped(request, submission_id)
        versions = submission.versions.select_related("changed_by").order_by("version")
        return ApiResponse(SubmissionVersionSerializer(versions, many=True).data)


class SubmissionReviewView(APIView):
    permission_classes = (IsSupervisorOrAdmin,)

    @extend_schema(
        operation_id="submissions_review",
        tags=["submissions"],
        request=ReviewRequestSerializer,
        responses={
            200: enveloped(SubmissionDetailSerializer, "SubmissionDetail"),
            409: OpenApiResponse(ErrorEnvelopeSerializer),
        },
    )
    def post(self, request: Request, submission_id: str) -> ApiResponse:
        submission = _get_scoped(request, submission_id)
        body = ReviewRequestSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        data = body.validated_data
        updated = services.review(
            submission,
            reviewer=_user(request),
            status=data["status"],
            note=data["note"],
            payload=data.get("payload"),
            base_version=data.get("base_version"),
            request_id=get_request_id(request),
        )
        return ApiResponse(SubmissionDetailSerializer(updated).data)


class SubmissionRetryView(APIView):
    permission_classes = (IsSupervisorOrAdmin,)

    @extend_schema(
        operation_id="submissions_retry",
        tags=["submissions"],
        request=RetryRequestSerializer,
        description="Server-side re-validation of a quarantined (`rejected`) submission.",
        responses={200: enveloped(SubmissionDetailSerializer, "SubmissionDetail")},
    )
    def post(self, request: Request, submission_id: str) -> ApiResponse:
        submission = _get_scoped(request, submission_id)
        body = RetryRequestSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        updated = services.revalidate(
            submission,
            actor=_user(request),
            template_version=body.validated_data.get("template_version"),
            request_id=get_request_id(request),
        )
        return ApiResponse(SubmissionDetailSerializer(updated).data)
