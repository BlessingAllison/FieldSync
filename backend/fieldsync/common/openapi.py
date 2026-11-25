"""OpenAPI helpers so the published schema describes the real (enveloped) wire format."""

from __future__ import annotations

from functools import cache
from typing import Any

from drf_spectacular.utils import inline_serializer
from rest_framework import serializers

from fieldsync.common.errors import ErrorCode


class MetaSerializer(serializers.Serializer[Any]):
    request_id = serializers.UUIDField()
    api_version = serializers.CharField()


class ErrorBodySerializer(serializers.Serializer[Any]):
    code = serializers.ChoiceField(choices=[code.value for code in ErrorCode])
    message = serializers.CharField()
    details = serializers.DictField(required=False)


# Built with inline_serializer: a Serializer subclass cannot declare a field named
# "data" (it would shadow Serializer.data).
ErrorEnvelopeSerializer: Any = inline_serializer(
    name="ErrorEnvelope",
    fields={
        "success": serializers.BooleanField(default=False),
        "data": serializers.JSONField(allow_null=True),
        "error": ErrorBodySerializer(),
        "meta": MetaSerializer(),
    },
)


@cache
def enveloped(
    data_serializer: type[serializers.Serializer[Any]], name: str, *, many: bool = False
) -> Any:
    """Schema component ``<name>Envelope``: ``{success, data: <serializer>, error, meta}``."""
    return inline_serializer(
        name=f"{name}Envelope",
        fields={
            "success": serializers.BooleanField(default=True),
            "data": data_serializer(many=many),
            "error": serializers.JSONField(allow_null=True, default=None),
            "meta": MetaSerializer(),
        },
    )
