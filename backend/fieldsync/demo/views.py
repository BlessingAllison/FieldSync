"""Demo-only endpoints used by the offline sync simulator (404 unless demo mode is on)."""

from __future__ import annotations

from typing import Any

from django.conf import settings
from drf_spectacular.utils import extend_schema
from rest_framework import serializers
from rest_framework.request import Request
from rest_framework.views import APIView

from fieldsync.accounts.authentication import auth_context
from fieldsync.accounts.models import Role, User
from fieldsync.common.envelope import ApiResponse, get_request_id
from fieldsync.common.errors import ApiError, ErrorCode
from fieldsync.common.openapi import enveloped
from fieldsync.formtemplates.validation import iter_fields
from fieldsync.submissions import services
from fieldsync.submissions.models import Submission


class SupervisorEditSerializer(serializers.Serializer[Any]):
    client_uuid = serializers.UUIDField()
    version = serializers.IntegerField()
    field = serializers.CharField()


def _correction(submission: Submission) -> tuple[str, dict[str, Any]]:
    payload = dict(submission.payload)
    for spec in iter_fields(submission.template.definition):
        field_id = spec["id"]
        if spec["type"] == "integer" and field_id in payload:
            rules = spec.get("rules", {})
            high = rules.get("max", payload[field_id] + 1)
            low = rules.get("min", payload[field_id] - 1)
            payload[field_id] = payload[field_id] + 1 if payload[field_id] < high else low
            return field_id, payload
    raise ApiError(ErrorCode.MALFORMED_REQUEST, "No correctable integer field in this submission.")


class SupervisorEditView(APIView):
    @extend_schema(
        operation_id="demo_supervisor_edit",
        tags=["demo"],
        request=None,
        description=(
            "Demo mode only: a county supervisor corrects one numeric value (creates a conflict)."
        ),
        responses={200: enveloped(SupervisorEditSerializer, "SupervisorEdit")},
    )
    def post(self, request: Request, client_uuid: str) -> ApiResponse:
        if not settings.FIELDSYNC_DEMO_MODE:
            raise ApiError(ErrorCode.NOT_FOUND)
        scope = auth_context(request).scope
        submission = (
            Submission.objects.filter(client_uuid=client_uuid, **scope.submissions_filter())
            .select_related("template", "facility")
            .first()
        )
        if submission is None:
            raise ApiError(ErrorCode.NOT_FOUND)
        reviewer = (
            User.objects.filter(
                role=Role.SUPERVISOR, county_id=submission.facility.county_id
            ).first()
            or request.user
        )
        assert isinstance(reviewer, User)  # noqa: S101
        field_id, payload = _correction(submission)
        updated = services.review(
            submission,
            reviewer=reviewer,
            status="reviewed",
            note="Corrected during supervision visit (demo).",
            payload=payload,
            base_version=submission.version,
            request_id=get_request_id(request),
        )
        return ApiResponse(
            {"client_uuid": updated.client_uuid, "version": updated.version, "field": field_id}
        )
