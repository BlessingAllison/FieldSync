"""Device-bound JWT issuance and refresh (ADD §11.2).

- Access token: 10 min, in memory on the client; claims ``sub, role, did, auth_time``.
- Refresh token: rotating + blacklisted after use, 14-day sliding lifetime, delivered only
  as an ``HttpOnly; Secure; SameSite=Strict`` cookie scoped to ``/api/v1/auth/``;
  refused after a 30-day absolute cap from ``auth_time`` or once the device is revoked.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from django.conf import settings
from django.http import HttpResponse
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.tokens import AccessToken, RefreshToken, Token

from fieldsync.accounts.models import Device, User
from fieldsync.common.errors import ApiError, ErrorCode


@dataclass(frozen=True, slots=True)
class IssuedTokens:
    access: str
    access_expires_at: datetime
    refresh: str


def issue(user: User, device: Device, *, auth_time: int | None = None) -> IssuedTokens:
    refresh = RefreshToken.for_user(user)
    refresh["did"] = str(device.id)
    refresh["auth_time"] = auth_time if auth_time is not None else int(time.time())
    access = refresh.access_token
    access["role"] = user.role
    return IssuedTokens(
        access=str(access),
        access_expires_at=datetime.fromtimestamp(int(access["exp"]), tz=UTC),
        refresh=str(refresh),
    )


def _is_expired(raw: str, token_class: type[Token]) -> bool:
    try:
        unverified = token_class(raw, verify=False)  # type: ignore[arg-type]
    except TokenError:
        return False
    exp = unverified.payload.get("exp")
    return isinstance(exp, int | float) and exp < time.time()


def decode_access(raw: str) -> AccessToken:
    try:
        return AccessToken(raw)  # type: ignore[arg-type]
    except TokenError as exc:
        code = ErrorCode.TOKEN_EXPIRED if _is_expired(raw, AccessToken) else ErrorCode.TOKEN_INVALID
        raise ApiError(code) from exc


def decode_refresh(raw: str) -> RefreshToken:
    """Signature, expiry and blacklist checks (the blacklist app hooks verify())."""
    try:
        return RefreshToken(raw)  # type: ignore[arg-type]
    except TokenError as exc:
        code = (
            ErrorCode.TOKEN_EXPIRED if _is_expired(raw, RefreshToken) else ErrorCode.TOKEN_INVALID
        )
        raise ApiError(code) from exc


def resolve_principal(token: Token) -> tuple[User, Device]:
    """User + device for a decoded token, enforcing active user and non-revoked device."""
    subject, device_id = token.payload.get("sub"), token.payload.get("did")
    if not isinstance(subject, str) or not isinstance(device_id, str):
        raise ApiError(ErrorCode.TOKEN_INVALID)
    # One query (device JOIN user): this runs on every authenticated request.
    device = (
        Device.objects.select_related("user")
        .filter(id=device_id, user_id=subject, user__is_active=True)
        .first()
    )
    if device is None:
        raise ApiError(ErrorCode.TOKEN_INVALID)
    user = device.user
    if device.is_revoked:
        raise ApiError(ErrorCode.DEVICE_REVOKED)
    return user, device


def rotate(raw_refresh: str) -> tuple[User, Device, IssuedTokens]:
    token = decode_refresh(raw_refresh)
    user, device = resolve_principal(token)
    auth_time = int(token.payload.get("auth_time", 0))
    if time.time() - auth_time > settings.JWT_REFRESH_ABSOLUTE.total_seconds():
        token.blacklist()
        raise ApiError(ErrorCode.TOKEN_EXPIRED, "Please sign in again.")
    token.blacklist()
    return user, device, issue(user, device, auth_time=auth_time)


def set_refresh_cookie(response: HttpResponse, refresh: str) -> None:
    response.set_cookie(
        settings.JWT_REFRESH_COOKIE,
        refresh,
        max_age=int(settings.JWT_REFRESH_TTL.total_seconds()),
        path=settings.JWT_REFRESH_COOKIE_PATH,
        secure=settings.JWT_REFRESH_COOKIE_SECURE,
        httponly=True,
        samesite="Strict",
    )


def clear_refresh_cookie(response: HttpResponse) -> None:
    response.delete_cookie(
        settings.JWT_REFRESH_COOKIE, path=settings.JWT_REFRESH_COOKIE_PATH, samesite="Strict"
    )


def token_payload(tokens: IssuedTokens) -> dict[str, Any]:
    return {"access": tokens.access, "access_expires_at": tokens.access_expires_at}
