"""Plain-function factories (no factory library: explicit is easier to audit)."""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from django.utils import timezone
from rest_framework.test import APIClient

from fieldsync.accounts import escrow, tokens
from fieldsync.accounts.models import Device, FacilityAssignment, Role, User
from fieldsync.common.ids import uuid7
from fieldsync.facilities.models import County, Facility, FacilityType
from fieldsync.formtemplates import services as template_services
from fieldsync.formtemplates.models import FormTemplate
from tests.conftest import CONTRACTS

PASSWORD = "correct-horse-battery-staple"


def county(code: str, name: str) -> County:
    return County.objects.get_or_create(code=code, defaults={"name": name})[0]


def facility(code: str, in_county: County) -> Facility:
    return Facility.objects.get_or_create(
        code=code,
        defaults={
            "name": f"Test facility {code}",
            "county": in_county,
            "district": "Test District",
            "facility_type": FacilityType.HEALTH_CENTER,
        },
    )[0]


def user(
    username: str,
    role: Role,
    *,
    in_county: County | None = None,
    facilities: tuple[Facility, ...] = (),
) -> User:
    created = User.objects.create_user(
        username, PASSWORD, display_name=username, role=role, county=in_county
    )
    for f in facilities:
        FacilityAssignment.objects.create(user=created, facility=f)
    return created


def device(owner: User, device_id: uuid.UUID | None = None) -> Device:
    device_id = device_id or uuid.uuid4()
    sealed, key_id = escrow.seal(escrow.new_secret(), device_id)
    return Device.objects.create(
        id=device_id,
        user=owner,
        label="pytest",
        app_version="test",
        escrow_secret_enc=sealed,
        escrow_key_id=key_id,
    )


def example_definition(name: str = "iccm-child-u5.v1.json") -> dict[str, Any]:
    loaded: dict[str, Any] = json.loads((CONTRACTS / "examples" / name).read_text(encoding="utf-8"))
    return loaded


def published_template(definition: dict[str, Any] | None = None, *, by: User) -> FormTemplate:
    draft = template_services.create_draft(
        definition=definition or example_definition(), created_by=by
    )
    return template_services.publish(draft)


def client_for(owner: User, on_device: Device) -> APIClient:
    issued = tokens.issue(owner, on_device)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {issued.access}")
    return client


def valid_payload(**overrides: Any) -> dict[str, Any]:
    yesterday = (timezone.now() - timedelta(days=1)).date().isoformat()
    payload: dict[str, Any] = {
        "patient_ref": "HH-0042-03",
        "age_months": 26,
        "sex": "f",
        "visit_date": yesterday,
        "fever": False,
    }
    payload.update(overrides)
    return payload


def item(
    on_facility: Facility,
    *,
    client_uuid: uuid.UUID | None = None,
    op: str = "create",
    payload: dict[str, Any] | None = None,
    base_version: int | None = None,
    resolution: str = "none",
    attempt: int = 1,
    template_version: int = 1,
) -> dict[str, Any]:
    return {
        "client_uuid": str(client_uuid or uuid7()),
        "op": op,
        "template": {"code": "iccm-child-u5", "version": template_version},
        "facility_id": str(on_facility.id),
        "captured_at": timezone.now().isoformat(),
        "base_version": base_version,
        "resolution": resolution,
        "attempt": attempt,
        "payload": payload if payload is not None else valid_payload(),
    }


@dataclass
class World:
    bong: County
    nimba: County
    bg1: Facility
    bg2: Facility
    ni1: Facility
    admin: User
    sup_bg: User
    chw_bg: User
    chw_bg2: User
    chw_ni: User
    template: FormTemplate
    dev_chw_bg: Device
    dev_chw_bg_2: Device
    dev_chw_bg2: Device
    dev_sup_bg: Device
    dev_chw_ni: Device
    dev_admin: Device

    def client(self, who: str, device_attr: str | None = None) -> APIClient:
        owner: User = getattr(self, who)
        dev: Device = getattr(self, device_attr or f"dev_{who}")
        return client_for(owner, dev)


def build_world() -> World:
    bong, nimba = county("BG", "Bong"), county("NI", "Nimba")
    bg1, bg2, ni1 = facility("BG-1", bong), facility("BG-2", bong), facility("NI-1", nimba)
    admin = user("admin", Role.ADMIN)
    sup_bg = user("sup.bg", Role.SUPERVISOR, in_county=bong)
    chw_bg = user("chw.bg", Role.CHW, in_county=bong, facilities=(bg1,))
    chw_bg2 = user("chw.bg2", Role.CHW, in_county=bong, facilities=(bg2,))
    chw_ni = user("chw.ni", Role.CHW, in_county=nimba, facilities=(ni1,))
    template = published_template(by=admin)
    return World(
        bong=bong,
        nimba=nimba,
        bg1=bg1,
        bg2=bg2,
        ni1=ni1,
        admin=admin,
        sup_bg=sup_bg,
        chw_bg=chw_bg,
        chw_bg2=chw_bg2,
        chw_ni=chw_ni,
        template=template,
        dev_chw_bg=device(chw_bg),
        dev_chw_bg_2=device(chw_bg),
        dev_chw_bg2=device(chw_bg2),
        dev_sup_bg=device(sup_bg),
        dev_chw_ni=device(chw_ni),
        dev_admin=device(admin),
    )
