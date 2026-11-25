from __future__ import annotations

from rest_framework import serializers

from fieldsync.facilities.models import County, Facility


class CountySerializer(serializers.ModelSerializer[County]):
    class Meta:
        model = County
        fields = ("id", "code", "name")
        read_only_fields = fields


class FacilitySerializer(serializers.ModelSerializer[Facility]):
    county = CountySerializer(read_only=True)

    class Meta:
        model = Facility
        fields = ("id", "code", "name", "county", "district", "facility_type", "is_active")
        read_only_fields = fields
