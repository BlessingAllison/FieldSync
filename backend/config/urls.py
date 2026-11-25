"""Root URL configuration. Everything lives under ``/api/`` (nginx proxies only that prefix)."""

from __future__ import annotations

from django.contrib import admin
from django.urls import include, path
from drf_spectacular.views import (
    SpectacularAPIView,
    SpectacularRedocView,
    SpectacularSwaggerSplitView,
)

from fieldsync.accounts import views as accounts
from fieldsync.common.views import LiveView, ReadyView, metrics_view
from fieldsync.demo.views import SupervisorEditView
from fieldsync.facilities import views as facilities
from fieldsync.formtemplates import views as templates
from fieldsync.submissions import views as submissions
from fieldsync.sync import views as sync

api_v1 = [
    # Operations
    path("health/live", LiveView.as_view(), name="health-live"),
    path("health/ready", ReadyView.as_view(), name="health-ready"),
    path("metrics", metrics_view, name="metrics"),
    path("schema", SpectacularAPIView.as_view(), name="schema"),
    path("docs", SpectacularSwaggerSplitView.as_view(url_name="schema"), name="swagger-ui"),
    path("redoc", SpectacularRedocView.as_view(url_name="schema"), name="redoc"),
    # Auth & devices
    path("auth/login", accounts.LoginView.as_view(), name="auth-login"),
    path("auth/refresh", accounts.RefreshView.as_view(), name="auth-refresh"),
    path("auth/logout", accounts.LogoutView.as_view(), name="auth-logout"),
    path("auth/me", accounts.MeView.as_view(), name="auth-me"),
    path("devices", accounts.DeviceListView.as_view(), name="devices"),
    path(
        "devices/<uuid:device_id>/revoke", accounts.DeviceRevokeView.as_view(), name="device-revoke"
    ),
    # Reference data
    path("counties", facilities.CountyListView.as_view(), name="counties"),
    path("facilities", facilities.FacilityListView.as_view(), name="facilities"),
    path("form-templates", templates.FormTemplateListView.as_view(), name="form-templates"),
    path(
        "form-templates/<slug:code>/versions/<int:version>",
        templates.FormTemplateVersionView.as_view(),
        name="form-template-version",
    ),
    path("form-templates/<uuid:template_id>", templates.FormTemplateDetailView.as_view()),
    path("form-templates/<uuid:template_id>/publish", templates.FormTemplatePublishView.as_view()),
    path("form-templates/<uuid:template_id>/retire", templates.FormTemplateRetireView.as_view()),
    # Submissions & sync
    path("submissions", submissions.SubmissionCollectionView.as_view(), name="submissions"),
    path("submissions/batch", submissions.SubmissionBatchView.as_view(), name="submissions-batch"),
    path("submissions/sync-status", sync.SyncStatusView.as_view(), name="sync-status"),
    path(
        "submissions/by-client/<uuid:client_uuid>",
        submissions.SubmissionByClientView.as_view(),
        name="submission-by-client",
    ),
    path("submissions/<uuid:submission_id>", submissions.SubmissionDetailView.as_view()),
    path("submissions/<uuid:submission_id>/versions", submissions.SubmissionVersionsView.as_view()),
    path("submissions/<uuid:submission_id>/review", submissions.SubmissionReviewView.as_view()),
    path("submissions/<uuid:submission_id>/retry", submissions.SubmissionRetryView.as_view()),
    path("sync/heartbeat", sync.HeartbeatView.as_view(), name="sync-heartbeat"),
    # Demo (404 unless FIELDSYNC_DEMO_MODE)
    path("demo/supervisor-edit/<uuid:client_uuid>", SupervisorEditView.as_view()),
]

urlpatterns = [
    path("api/v1/", include(api_v1)),
    path("api/admin/", admin.site.urls),
]

admin.site.site_header = "FieldSync back-office (demo)"
admin.site.site_title = "FieldSync admin"

handler400 = "fieldsync.common.exceptions.handler400"
handler403 = "fieldsync.common.exceptions.handler403"
handler404 = "fieldsync.common.exceptions.handler404"
handler500 = "fieldsync.common.exceptions.handler500"
