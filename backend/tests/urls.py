"""Test-only routes that exercise the envelope and exception paths."""

from __future__ import annotations

from typing import Any

from django.urls import include, path
from rest_framework import exceptions as drf
from rest_framework import serializers
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.views import APIView

from fieldsync.common.envelope import ApiResponse
from fieldsync.common.errors import ApiError, ErrorCode


class _Payload(serializers.Serializer[Any]):
    age = serializers.IntegerField(min_value=0)
    sex = serializers.ChoiceField(choices=["f", "m"])


class EchoView(APIView):
    authentication_classes = ()
    permission_classes = (AllowAny,)

    def post(self, request: Request) -> ApiResponse:
        return ApiResponse({"received": request.data}, meta={"pagination": {"next_cursor": None}})


class ValidateView(APIView):
    authentication_classes = ()
    permission_classes = (AllowAny,)

    def post(self, request: Request) -> ApiResponse:
        serializer = _Payload(data=request.data)
        serializer.is_valid(raise_exception=True)
        return ApiResponse(serializer.validated_data)


class RaiseView(APIView):
    authentication_classes = ()
    permission_classes = (AllowAny,)

    def get(self, request: Request, kind: str) -> ApiResponse:
        if kind == "api-error":
            raise ApiError(ErrorCode.CONFLICT_VERSION, details={"server_version": 4})
        if kind == "throttled":
            raise drf.Throttled(wait=12.2)
        if kind == "permission":
            raise drf.PermissionDenied
        if kind == "not-authenticated":
            raise drf.NotAuthenticated
        if kind == "crash":
            raise RuntimeError("boom with patient_name=Secret")
        return ApiResponse(None, status=204)


urlpatterns = [
    path("", include("config.urls")),
    path("api/v1/_test/echo", EchoView.as_view()),
    path("api/v1/_test/validate", ValidateView.as_view()),
    path("api/v1/_test/raise/<str:kind>", RaiseView.as_view()),
]

# pytest.mark.urls swaps ROOT_URLCONF, and Django reads handler404/500 from it.
handler400 = "fieldsync.common.exceptions.handler400"
handler403 = "fieldsync.common.exceptions.handler403"
handler404 = "fieldsync.common.exceptions.handler404"
handler500 = "fieldsync.common.exceptions.handler500"
