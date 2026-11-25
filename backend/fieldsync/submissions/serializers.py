from __future__ import annotations

from typing import Any

from django.conf import settings
from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from fieldsync.submissions.models import Submission, SubmissionStatus, SubmissionVersion


class TemplateRefSerializer(serializers.Serializer[Any]):
    code = serializers.CharField(max_length=64)
    version = serializers.IntegerField(min_value=1)


class SubmissionItemSerializer(serializers.Serializer[Any]):
    client_uuid = serializers.UUIDField()
    op = serializers.ChoiceField(choices=["create", "update"])
    template = TemplateRefSerializer()
    facility_id = serializers.UUIDField()
    captured_at = serializers.DateTimeField()
    base_version = serializers.IntegerField(
        min_value=1, allow_null=True, required=False, default=None
    )
    resolution = serializers.ChoiceField(choices=["none", "override", "merge"], default="none")
    attempt = serializers.IntegerField(min_value=1, max_value=10_000, default=1)
    payload = serializers.DictField(child=serializers.JSONField(allow_null=True), allow_empty=True)

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        if attrs["op"] == "update" and attrs.get("base_version") is None:
            raise serializers.ValidationError({"base_version": "required"}, code="required")
        return attrs


class DeviceFacilityStateSerializer(serializers.Serializer[Any]):
    facility_id = serializers.UUIDField()
    pending = serializers.IntegerField(min_value=0, default=0)
    failed = serializers.IntegerField(min_value=0, default=0)
    conflicts = serializers.IntegerField(min_value=0, default=0)
    stuck = serializers.IntegerField(min_value=0, default=0)
    oldest_pending_at = serializers.DateTimeField(allow_null=True, required=False, default=None)
    last_attempt_at = serializers.DateTimeField(allow_null=True, required=False, default=None)
    last_success_at = serializers.DateTimeField(allow_null=True, required=False, default=None)


class DeviceStateSerializer(serializers.Serializer[Any]):
    facilities = DeviceFacilityStateSerializer(many=True)


class BatchRequestSerializer(serializers.Serializer[Any]):
    # Items are validated one by one in the view so a malformed item never fails the batch.
    items = serializers.ListField(
        child=serializers.JSONField(), min_length=1, max_length=settings.SUBMISSION_BATCH_MAX_ITEMS
    )
    device_state = DeviceStateSerializer(required=False)


class TemplateRefResponseSerializer(serializers.Serializer[Any]):
    code = serializers.CharField(read_only=True)
    version = serializers.IntegerField(read_only=True)


class SubmissionSerializer(serializers.ModelSerializer[Submission]):
    template = serializers.SerializerMethodField()

    class Meta:
        model = Submission
        fields: tuple[str, ...] = (
            "id",
            "client_uuid",
            "template",
            "facility_id",
            "submitted_by_id",
            "status",
            "version",
            "validation_errors",
            "captured_at",
            "received_at",
            "updated_at",
            "reviewed_at",
            "review_note",
        )
        read_only_fields = fields

    @extend_schema_field(TemplateRefResponseSerializer)
    def get_template(self, obj: Submission) -> dict[str, Any]:
        return {"code": obj.template.code, "version": obj.template.version}


class SubmissionDetailSerializer(SubmissionSerializer):
    class Meta(SubmissionSerializer.Meta):
        fields = (*SubmissionSerializer.Meta.fields, "payload")
        read_only_fields = fields


class SubmissionVersionSerializer(serializers.ModelSerializer[SubmissionVersion]):
    changed_by_role = serializers.CharField(source="changed_by.role")

    class Meta:
        model = SubmissionVersion
        fields = (
            "version",
            "payload",
            "status",
            "source",
            "changed_by_role",
            "device_id",
            "created_at",
        )


class ServerCopySerializer(serializers.Serializer[Any]):
    version = serializers.IntegerField()
    payload = serializers.DictField()
    status = serializers.ChoiceField(choices=SubmissionStatus.choices)
    changed_at = serializers.DateTimeField()
    changed_by_role = serializers.CharField(allow_null=True)


class UpsertResultSerializer(serializers.Serializer[Any]):
    client_uuid = serializers.UUIDField()
    outcome = serializers.ChoiceField(
        choices=["created", "updated", "replayed", "conflict", "rejected", "forbidden", "invalid"]
    )
    http_status = serializers.IntegerField()
    submission = SubmissionSerializer(required=False)
    error = serializers.DictField(required=False)
    server_copy = ServerCopySerializer(required=False)


class UpsertSuccessSerializer(serializers.Serializer[Any]):
    outcome = serializers.ChoiceField(choices=["created", "updated", "replayed"])
    submission = SubmissionSerializer()


class BatchResponseSerializer(serializers.Serializer[Any]):
    results = UpsertResultSerializer(many=True)


class ReviewRequestSerializer(serializers.Serializer[Any]):
    status = serializers.ChoiceField(choices=[SubmissionStatus.REVIEWED, SubmissionStatus.FLAGGED])
    note = serializers.CharField(max_length=500, allow_blank=True, default="")
    payload = serializers.DictField(child=serializers.JSONField(allow_null=True), required=False)
    base_version = serializers.IntegerField(min_value=1, required=False)

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        if "payload" in attrs and "base_version" not in attrs:
            raise serializers.ValidationError({"base_version": "required"}, code="required")
        return attrs


class RetryRequestSerializer(serializers.Serializer[Any]):
    template_version = serializers.IntegerField(min_value=1, required=False)
