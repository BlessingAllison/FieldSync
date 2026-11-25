from __future__ import annotations

from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework.request import Request
from rest_framework.views import APIView

from fieldsync.accounts.authentication import auth_context
from fieldsync.common.envelope import ApiResponse
from fieldsync.common.http import conditional_response
from fieldsync.common.openapi import enveloped
from fieldsync.facilities.models import County
from fieldsync.facilities.serializers import CountySerializer, FacilitySerializer


class CountyListView(APIView):
    @extend_schema(
        operation_id="counties_list",
        tags=["facilities"],
        responses={200: enveloped(CountySerializer, "CountyList", many=True)},
    )
    def get(self, request: Request) -> ApiResponse:
        return conditional_response(request, CountySerializer(County.objects.all(), many=True).data)


class FacilityListView(APIView):
    @extend_schema(
        operation_id="facilities_list",
        tags=["facilities"],
        parameters=[
            OpenApiParameter("county", str, description="County code (admins/supervisors)")
        ],
        responses={200: enveloped(FacilitySerializer, "FacilityList", many=True)},
    )
    def get(self, request: Request) -> ApiResponse:
        scope = auth_context(request).scope
        qs = scope.facilities().select_related("county")
        county = request.query_params.get("county")
        if county:
            qs = qs.filter(county__code=county)
        return conditional_response(request, FacilitySerializer(qs, many=True).data)
