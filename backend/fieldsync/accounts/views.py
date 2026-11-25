"""Auth endpoints (ADD §10.3, §11.2) and device registry."""

from __future__ import annotations

import contextlib
from typing import Any
from urllib.parse import urlparse

from django.conf import settings
from django.db.models import Q
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.request import Request
from rest_framework.views import APIView

from fieldsync.accounts import escrow, services, tokens
from fieldsync.accounts.authentication import auth_context
from fieldsync.accounts.models import Device, Role, User
from fieldsync.accounts.permissions import IsSupervisorOrAdmin
from fieldsync.accounts.scope import Scope, scope_for
from fieldsync.accounts.serializers import (
    DeviceSerializer,
    LoginRequestSerializer,
    LoginResponseSerializer,
    RefreshResponseSerializer,
    RevokeRequestSerializer,
    SignedOutSerializer,
    UserProfileSerializer,
    profile_data,
)
from fieldsync.common import metrics
from fieldsync.common.envelope import ApiResponse, get_request_id
from fieldsync.common.errors import ApiError, ErrorCode
from fieldsync.common.openapi import ErrorEnvelopeSerializer, enveloped
from fieldsync.sync import events
from fieldsync.sync.models import SyncEventType

CSRF_HEADER = "HTTP_X_REQUESTED_WITH"
CSRF_HEADER_VALUE = "fieldsync"


def _assert_same_origin(request: Request) -> None:
    """Defence in depth on cookie-authenticated endpoints (SameSite=Strict is the first line)."""
    if request.META.get(CSRF_HEADER) != CSRF_HEADER_VALUE:
        raise ApiError(ErrorCode.PERMISSION_DENIED, "Missing X-Requested-With header.")
    origin = request.META.get("HTTP_ORIGIN")
    # Behind the Vercel rewrite the request reaches Django addressed to the API host, while the
    # browser's Origin is the site the PWA was loaded from; that site is trusted explicitly.
    allowed_hosts = {request.get_host(), *settings.FIELDSYNC_TRUSTED_ORIGIN_HOSTS}
    if origin and urlparse(origin).netloc not in allowed_hosts:
        raise ApiError(ErrorCode.PERMISSION_DENIED, "Cross-origin request refused.")


class LoginView(APIView):
    authentication_classes = ()
    permission_classes = (AllowAny,)
    throttle_scope = "login"

    @extend_schema(
        operation_id="auth_login",
        tags=["auth"],
        request=LoginRequestSerializer,
        responses={
            200: enveloped(LoginResponseSerializer, "Login"),
            401: OpenApiResponse(ErrorEnvelopeSerializer),
            403: OpenApiResponse(ErrorEnvelopeSerializer),
        },
    )
    def post(self, request: Request) -> ApiResponse:
        body = LoginRequestSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        data = body.validated_data
        try:
            user = services.authenticate_credentials(data["username"], data["password"])
        except ApiError as error:
            metrics.AUTH_EVENTS.labels(f"login_{error.code}").inc()
            raise
        metrics.AUTH_EVENTS.labels("login_ok").inc()
        device_info = data["device"]
        device, secret = services.register_device(
            user=user,
            device_id=device_info["id"],
            label=device_info["label"],
            app_version=device_info["app_version"],
            request_id=get_request_id(request),
        )
        issued = tokens.issue(user, device)
        response = ApiResponse(
            {
                **tokens.token_payload(issued),
                "user": profile_data(user, scope_for(user)),
                "device": {"id": device.id, "escrow_secret": escrow.encode(secret)},
            }
        )
        tokens.set_refresh_cookie(response, issued.refresh)
        return response


class RefreshView(APIView):
    authentication_classes = ()
    permission_classes = (AllowAny,)
    throttle_scope = "refresh"

    @extend_schema(
        operation_id="auth_refresh",
        tags=["auth"],
        request=None,
        description="Rotates the refresh cookie. Requires `X-Requested-With: fieldsync`.",
        responses={
            200: enveloped(RefreshResponseSerializer, "Refresh"),
            401: OpenApiResponse(ErrorEnvelopeSerializer),
        },
    )
    def post(self, request: Request) -> ApiResponse:
        _assert_same_origin(request)
        raw = request.COOKIES.get(settings.JWT_REFRESH_COOKIE)
        if not raw:
            raise ApiError(ErrorCode.TOKEN_INVALID, "No session.")
        try:
            user, _device, issued = tokens.rotate(raw)
        except ApiError as error:
            metrics.AUTH_EVENTS.labels(f"refresh_{error.code}").inc()
            events.record(
                SyncEventType.AUTH_REFRESH_DENIED,
                request_id=get_request_id(request),
                detail={"code": str(error.code)},
            )
            raise
        metrics.AUTH_EVENTS.labels("refresh_ok").inc()
        response = ApiResponse(
            {**tokens.token_payload(issued), "user": profile_data(user, scope_for(user))}
        )
        tokens.set_refresh_cookie(response, issued.refresh)
        return response


class LogoutView(APIView):
    authentication_classes = ()
    permission_classes = (AllowAny,)

    @extend_schema(
        operation_id="auth_logout",
        tags=["auth"],
        request=None,
        responses={200: enveloped(SignedOutSerializer, "SignedOut")},
    )
    def post(self, request: Request) -> ApiResponse:
        _assert_same_origin(request)
        raw = request.COOKIES.get(settings.JWT_REFRESH_COOKIE)
        if raw:
            with contextlib.suppress(ApiError):  # already invalid: nothing to revoke
                tokens.decode_refresh(raw).blacklist()
        response = ApiResponse({"signed_out": True})
        tokens.clear_refresh_cookie(response)
        return response


class MeView(APIView):
    permission_classes = (IsAuthenticated,)

    @extend_schema(
        operation_id="auth_me",
        tags=["auth"],
        responses={200: enveloped(UserProfileSerializer, "Me")},
    )
    def get(self, request: Request) -> ApiResponse:
        ctx = auth_context(request)
        user = request.user
        assert isinstance(user, User)  # noqa: S101 — guaranteed by IsAuthenticated
        return ApiResponse(profile_data(user, ctx.scope))


def devices_in_scope(scope: Scope) -> Any:
    qs = Device.objects.select_related("user")
    if scope.is_national:
        return qs
    if scope.role == Role.SUPERVISOR:
        return qs.filter(
            Q(user__assignments__facility_id__in=scope.facility_ids)
            | Q(user__county_id=scope.county_id)
        ).distinct()
    return qs.filter(user_id=scope.user_id)


class DeviceListView(APIView):
    permission_classes = (IsAuthenticated,)

    @extend_schema(
        operation_id="devices_list",
        tags=["devices"],
        responses={200: enveloped(DeviceSerializer, "DeviceList", many=True)},
    )
    def get(self, request: Request) -> ApiResponse:
        scope = auth_context(request).scope
        devices = devices_in_scope(scope).order_by("-last_seen_at")[:500]
        return ApiResponse(DeviceSerializer(devices, many=True).data)


class DeviceRevokeView(APIView):
    permission_classes = (IsSupervisorOrAdmin,)

    @extend_schema(
        operation_id="devices_revoke",
        tags=["devices"],
        request=RevokeRequestSerializer,
        responses={
            200: enveloped(DeviceSerializer, "Device"),
            404: OpenApiResponse(ErrorEnvelopeSerializer),
        },
    )
    def post(self, request: Request, device_id: str) -> ApiResponse:
        scope = auth_context(request).scope
        device = devices_in_scope(scope).filter(id=device_id).first()
        if device is None:
            raise ApiError(ErrorCode.NOT_FOUND)
        body = RevokeRequestSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        user = request.user
        assert isinstance(user, User)  # noqa: S101
        revoked = services.revoke_device(
            device,
            by=user,
            reason=body.validated_data["reason"],
            request_id=get_request_id(request),
        )
        return ApiResponse(DeviceSerializer(revoked).data)
