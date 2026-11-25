from __future__ import annotations

from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework.request import Request
from rest_framework.views import APIView

from fieldsync.accounts.models import User
from fieldsync.accounts.permissions import IsAdmin
from fieldsync.common.envelope import ApiResponse
from fieldsync.common.errors import ApiError, ErrorCode
from fieldsync.common.http import conditional_response
from fieldsync.common.openapi import ErrorEnvelopeSerializer, enveloped
from fieldsync.formtemplates import services
from fieldsync.formtemplates.models import FormTemplate
from fieldsync.formtemplates.serializers import (
    DefinitionProblemsSerializer,
    DeletedSerializer,
    FormTemplateAdminSerializer,
    FormTemplateSerializer,
    TemplateDefinitionRequestSerializer,
)


def _definition(request: Request) -> dict[str, object]:
    body = TemplateDefinitionRequestSerializer(data=request.data)
    body.is_valid(raise_exception=True)
    definition = body.validated_data["definition"]
    if not isinstance(definition, dict):
        raise ApiError(ErrorCode.MALFORMED_REQUEST, "definition must be an object.")
    return definition


def _get(template_id: str) -> FormTemplate:
    template = FormTemplate.objects.filter(id=template_id).first()
    if template is None:
        raise ApiError(ErrorCode.NOT_FOUND)
    return template


class FormTemplateListView(APIView):
    @extend_schema(
        operation_id="form_templates_list",
        tags=["templates"],
        description="Every version that currently accepts submissions (published + grace window).",
        responses={200: enveloped(FormTemplateSerializer, "FormTemplateList", many=True)},
    )
    def get(self, request: Request) -> ApiResponse:
        qs = services.accepting_templates().order_by("code", "-version")
        return conditional_response(request, FormTemplateSerializer(qs, many=True).data)

    @extend_schema(
        operation_id="form_templates_create",
        tags=["templates"],
        request=TemplateDefinitionRequestSerializer,
        responses={
            201: enveloped(FormTemplateSerializer, "FormTemplate"),
            422: OpenApiResponse(ErrorEnvelopeSerializer),
        },
    )
    def post(self, request: Request) -> ApiResponse:
        if not IsAdmin().has_permission(request, self):
            raise ApiError(ErrorCode.PERMISSION_DENIED)
        user = request.user
        assert isinstance(user, User)  # noqa: S101
        template = services.create_draft(definition=_definition(request), created_by=user)
        return ApiResponse(FormTemplateSerializer(template).data, status=201)


class FormTemplateVersionView(APIView):
    @extend_schema(
        operation_id="form_templates_version",
        tags=["templates"],
        responses={
            200: enveloped(FormTemplateSerializer, "FormTemplate"),
            404: OpenApiResponse(ErrorEnvelopeSerializer),
        },
    )
    def get(self, request: Request, code: str, version: int) -> ApiResponse:
        template = (
            FormTemplate.objects.filter(code=code, version=version).exclude(status="draft").first()
        )
        if template is None:
            raise ApiError(ErrorCode.NOT_FOUND)
        return conditional_response(request, FormTemplateSerializer(template).data)


class FormTemplateManageListView(APIView):
    permission_classes = (IsAdmin,)

    @extend_schema(
        operation_id="form_templates_manage_list",
        tags=["templates"],
        description="Admin form builder: every version of every template, drafts included.",
        responses={200: enveloped(FormTemplateAdminSerializer, "FormTemplateAdminList", many=True)},
    )
    def get(self, request: Request) -> ApiResponse:
        qs = services.all_templates_for_admin()
        return ApiResponse(FormTemplateAdminSerializer(qs, many=True).data)


class FormTemplateValidateView(APIView):
    permission_classes = (IsAdmin,)

    @extend_schema(
        operation_id="form_templates_validate",
        tags=["templates"],
        description="Dry run: every reason the definition could not be saved (nothing is stored).",
        request=TemplateDefinitionRequestSerializer,
        responses={200: enveloped(DefinitionProblemsSerializer, "DefinitionProblems")},
    )
    def post(self, request: Request) -> ApiResponse:
        problems = services.definition_problems(_definition(request))
        return ApiResponse({"valid": not problems, "problems": problems})


class FormTemplateDetailView(APIView):
    permission_classes = (IsAdmin,)

    @extend_schema(
        operation_id="form_templates_detail",
        tags=["templates"],
        responses={
            200: enveloped(FormTemplateAdminSerializer, "FormTemplateAdmin"),
            404: OpenApiResponse(ErrorEnvelopeSerializer),
        },
    )
    def get(self, request: Request, template_id: str) -> ApiResponse:
        template = services.all_templates_for_admin().filter(id=template_id).first()
        if template is None:
            raise ApiError(ErrorCode.NOT_FOUND)
        return ApiResponse(FormTemplateAdminSerializer(template).data)

    @extend_schema(
        operation_id="form_templates_delete",
        tags=["templates"],
        request=None,
        responses={
            200: enveloped(DeletedSerializer, "TemplateDeleted"),
            403: OpenApiResponse(ErrorEnvelopeSerializer),
        },
    )
    def delete(self, request: Request, template_id: str) -> ApiResponse:
        template = _get(template_id)
        deleted_id = template.id
        services.delete_draft(template)
        return ApiResponse({"id": deleted_id, "deleted": True})

    @extend_schema(
        operation_id="form_templates_update",
        tags=["templates"],
        request=TemplateDefinitionRequestSerializer,
        responses={200: enveloped(FormTemplateSerializer, "FormTemplate")},
    )
    def patch(self, request: Request, template_id: str) -> ApiResponse:
        template = services.update_draft(_get(template_id), definition=_definition(request))
        return ApiResponse(FormTemplateSerializer(template).data)


class FormTemplatePublishView(APIView):
    permission_classes = (IsAdmin,)

    @extend_schema(
        operation_id="form_templates_publish",
        tags=["templates"],
        request=None,
        responses={200: enveloped(FormTemplateSerializer, "FormTemplate")},
    )
    def post(self, request: Request, template_id: str) -> ApiResponse:
        return ApiResponse(FormTemplateSerializer(services.publish(_get(template_id))).data)


class FormTemplateRetireView(APIView):
    permission_classes = (IsAdmin,)

    @extend_schema(
        operation_id="form_templates_retire",
        tags=["templates"],
        request=None,
        responses={200: enveloped(FormTemplateSerializer, "FormTemplate")},
    )
    def post(self, request: Request, template_id: str) -> ApiResponse:
        return ApiResponse(FormTemplateSerializer(services.retire(_get(template_id))).data)
