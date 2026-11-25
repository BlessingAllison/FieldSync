"""Per-request authorisation scope (ADD §11.3).

Every queryset goes through a :class:`Scope`. Out-of-scope object lookups return 404 (not
403) so the existence of other facilities' records is never revealed.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any, TypeVar

from django.db.models import Model, QuerySet

from fieldsync.accounts.models import Role, User
from fieldsync.facilities.models import Facility

M = TypeVar("M", bound=Model)


@dataclass(frozen=True, slots=True)
class Scope:
    user_id: uuid.UUID
    role: Role
    county_id: int | None
    facility_ids: frozenset[uuid.UUID]  # facilities the user may read AND write

    @property
    def is_national(self) -> bool:
        return self.role == Role.ADMIN

    @property
    def is_chw(self) -> bool:
        return self.role == Role.CHW

    def facilities(self) -> QuerySet[Facility]:
        qs = Facility.objects.filter(is_active=True)
        if self.is_national:
            return qs
        return qs.filter(id__in=self.facility_ids)

    def can_access_facility(self, facility_id: uuid.UUID) -> bool:
        return self.is_national or facility_id in self.facility_ids

    def filter_by_facility(self, qs: QuerySet[M], field: str = "facility_id") -> QuerySet[M]:
        if self.is_national:
            return qs
        return qs.filter(**{f"{field}__in": self.facility_ids})

    def submissions_filter(self) -> dict[str, Any]:
        """Lookup kwargs for submissions the user may read."""
        if self.is_national:
            return {}
        if self.is_chw:
            return {"submitted_by_id": self.user_id, "facility_id__in": self.facility_ids}
        return {"facility_id__in": self.facility_ids}


def scope_for(user: User) -> Scope:
    role = Role(user.role)
    if role == Role.ADMIN:
        ids: frozenset[uuid.UUID] = frozenset()
    elif role == Role.SUPERVISOR:
        # A supervisor always has a county (DB check constraint); be defensive anyway.
        ids = (
            frozenset(
                Facility.objects.filter(county_id=user.county_id, is_active=True).values_list(
                    "id", flat=True
                )
            )
            if user.county_id is not None
            else frozenset()
        )
    else:
        ids = frozenset(user.facilities.filter(is_active=True).values_list("id", flat=True))
    return Scope(user_id=user.id, role=role, county_id=user.county_id, facility_ids=ids)
