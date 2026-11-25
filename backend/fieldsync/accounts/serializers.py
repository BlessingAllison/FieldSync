from __future__ import annotations

from typing import Any

from rest_framework import serializers

from fieldsync.accounts.models import Device, Role, User
from fieldsync.accounts.scope import Scope


class DeviceInfoSerializer(serializers.Serializer[Any]):
    id = serializers.UUIDField()
    # A declared field named "label" shadows Field.label in the stubs only; DRF pops it.
    label = serializers.CharField(max_length=80)  # type: ignore[assignment]
    app_version = serializers.CharField(max_length=32)


class LoginRequestSerializer(serializers.Serializer[Any]):
    username = serializers.CharField(max_length=64, trim_whitespace=True)
    password = serializers.CharField(max_length=256, trim_whitespace=False)
    device = DeviceInfoSerializer()


class CountyRefSerializer(serializers.Serializer[Any]):
    id = serializers.IntegerField()
    code = serializers.CharField()
    name = serializers.CharField()


class UserProfileSerializer(serializers.Serializer[Any]):
    id = serializers.UUIDField()
    username = serializers.CharField()
    display_name = serializers.CharField()
    role = serializers.ChoiceField(choices=Role.choices)
    county = CountyRefSerializer(allow_null=True)
    facility_ids = serializers.ListField(child=serializers.UUIDField())
    preferred_locale = serializers.CharField()


def profile_data(user: User, scope: Scope) -> dict[str, Any]:
    county = user.county
    return {
        "id": user.id,
        "username": user.username,
        "display_name": user.display_name,
        "role": user.role,
        "county": {"id": county.id, "code": county.code, "name": county.name} if county else None,
        "facility_ids": sorted(scope.facility_ids, key=str),
        "preferred_locale": user.preferred_locale,
    }


class TokenSerializer(serializers.Serializer[Any]):
    access = serializers.CharField()
    access_expires_at = serializers.DateTimeField()


class LoginDeviceSerializer(serializers.Serializer[Any]):
    id = serializers.UUIDField()
    escrow_secret = serializers.CharField(help_text="base64url, 32 bytes; never persist on device")


class LoginResponseSerializer(TokenSerializer):
    user = UserProfileSerializer()
    device = LoginDeviceSerializer()


class RefreshResponseSerializer(TokenSerializer):
    user = UserProfileSerializer()


class SignedOutSerializer(serializers.Serializer[Any]):
    signed_out = serializers.BooleanField()


class DeviceUserSerializer(serializers.ModelSerializer[User]):
    class Meta:
        model = User
        fields = ("id", "username", "display_name", "role")
        read_only_fields = fields


class DeviceSerializer(serializers.ModelSerializer[Device]):
    user = DeviceUserSerializer(read_only=True)

    class Meta:
        model = Device
        fields = (
            "id",
            "user",
            "label",
            "app_version",
            "registered_at",
            "last_seen_at",
            "revoked_at",
            "revoke_reason",
        )
        read_only_fields = fields


class RevokeRequestSerializer(serializers.Serializer[Any]):
    reason = serializers.CharField(max_length=200)
