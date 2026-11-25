from __future__ import annotations

from typing import Any

from rest_framework.permissions import BasePermission
from rest_framework.request import Request

from fieldsync.accounts.models import Role


class HasRole(BasePermission):
    """``permission_classes = [HasRole.of(Role.SUPERVISOR, Role.ADMIN)]``."""

    roles: frozenset[str] = frozenset()

    @classmethod
    def of(cls, *roles: Role) -> type[HasRole]:
        return type(f"HasRole_{'_'.join(roles)}", (cls,), {"roles": frozenset(roles)})

    def has_permission(self, request: Request, view: Any) -> bool:
        user = request.user
        return bool(user and user.is_authenticated and getattr(user, "role", None) in self.roles)


IsSupervisorOrAdmin = HasRole.of(Role.SUPERVISOR, Role.ADMIN)
IsAdmin = HasRole.of(Role.ADMIN)
IsFieldWriter = HasRole.of(Role.CHW, Role.SUPERVISOR, Role.ADMIN)
