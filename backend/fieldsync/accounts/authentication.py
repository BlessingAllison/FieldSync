"""DRF authentication: Bearer access JWT bound to a non-revoked device."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from django.utils import timezone
from drf_spectacular.extensions import OpenApiAuthenticationExtension
from rest_framework.authentication import BaseAuthentication
from rest_framework.request import Request
from rest_framework_simplejwt.tokens import AccessToken

from fieldsync.accounts.models import Device, User
from fieldsync.accounts.scope import Scope, scope_for
from fieldsync.accounts.tokens import decode_access, resolve_principal
from fieldsync.common.errors import ApiError, ErrorCode

_LAST_SEEN_WRITE_INTERVAL = timedelta(minutes=5)


@dataclass(frozen=True, slots=True)
class AuthContext:
    token: AccessToken
    device: Device
    scope: Scope


class DeviceBoundJWTAuthentication(BaseAuthentication):
    def authenticate(self, request: Request) -> tuple[User, AuthContext] | None:
        header = request.META.get("HTTP_AUTHORIZATION", "")
        if not header:
            return None
        scheme, _, raw = header.partition(" ")
        if scheme != "Bearer" or not raw.strip():
            raise ApiError(ErrorCode.TOKEN_INVALID)
        token = decode_access(raw.strip())
        user, device = resolve_principal(token)
        now = timezone.now()
        if now - device.last_seen_at > _LAST_SEEN_WRITE_INTERVAL:
            Device.objects.filter(pk=device.pk).update(last_seen_at=now)
        return user, AuthContext(token=token, device=device, scope=scope_for(user))

    def authenticate_header(self, request: Request) -> str:
        return 'Bearer realm="fieldsync"'


def auth_context(request: Request) -> AuthContext:
    ctx = request.auth
    if not isinstance(ctx, AuthContext):
        raise ApiError(ErrorCode.TOKEN_INVALID)
    return ctx


class DeviceBoundJWTScheme(OpenApiAuthenticationExtension):  # type: ignore[no-untyped-call]
    target_class = "fieldsync.accounts.authentication.DeviceBoundJWTAuthentication"
    name = "bearerAuth"

    def get_security_definition(self, auto_schema: Any) -> dict[str, str]:
        return {"type": "http", "scheme": "bearer", "bearerFormat": "JWT"}
