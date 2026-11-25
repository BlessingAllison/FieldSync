from __future__ import annotations

from django.contrib import admin

from fieldsync.facilities.models import County, Facility


@admin.register(County)
class CountyAdmin(admin.ModelAdmin[County]):
    list_display = ("code", "name")
    search_fields = ("code", "name")


@admin.register(Facility)
class FacilityAdmin(admin.ModelAdmin[Facility]):
    list_display = ("code", "name", "county", "facility_type", "is_active")
    list_filter = ("county", "facility_type", "is_active")
    search_fields = ("code", "name")
