from __future__ import annotations

from typing import Any

from rest_framework import serializers

from fieldsync.formtemplates.models import FormTemplate


class FormTemplateSerializer(serializers.ModelSerializer[FormTemplate]):
    class Meta:
        model = FormTemplate
        fields = (
            "id",
            "code",
            "version",
            "subject",
            "title",
            "description",
            "definition",
            "definition_hash",
            "status",
            "accept_until",
            "published_at",
        )
        read_only_fields = fields


class TemplateDefinitionRequestSerializer(serializers.Serializer[Any]):
    definition = serializers.JSONField(
        help_text="A definition valid against contracts/form-template.schema.json"
    )


class FormTemplateAdminSerializer(serializers.ModelSerializer[FormTemplate]):
    """Every lifecycle field, for the admin form builder (drafts included)."""

    submission_count = serializers.IntegerField(read_only=True)

    class Meta:
        model = FormTemplate
        fields = (
            "id",
            "code",
            "version",
            "subject",
            "title",
            "description",
            "definition",
            "definition_hash",
            "status",
            "accept_until",
            "published_at",
            "superseded_at",
            "retired_at",
            "created_at",
            "submission_count",
        )
        read_only_fields = fields


class DefinitionProblemsSerializer(serializers.Serializer[Any]):
    valid = serializers.BooleanField()
    problems = serializers.ListField(child=serializers.CharField())


class DeletedSerializer(serializers.Serializer[Any]):
    id = serializers.UUIDField()
    deleted = serializers.BooleanField()
