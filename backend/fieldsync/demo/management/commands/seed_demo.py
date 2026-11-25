"""Seed synthetic reference data, demo accounts, templates and sync history.

    python manage.py seed_demo                    # random passwords, printed once as Markdown
    python manage.py seed_demo --password '…'     # fixed password for every account (E2E)

Idempotent: re-running keeps existing rows and only (re)sets passwords. Everything is
synthetic: county names are real geography; facilities, users and patients are fictional.
"""

from __future__ import annotations

import json
import random
import secrets
import uuid
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from django.conf import settings
from django.core.management.base import BaseCommand, CommandParser
from django.db import transaction
from django.utils import timezone

from fieldsync.accounts import escrow
from fieldsync.accounts.models import Device, FacilityAssignment, Role, User
from fieldsync.demo.synthetic import payload_for
from fieldsync.facilities.models import County, Facility, FacilityType
from fieldsync.formtemplates import services as template_services
from fieldsync.formtemplates.models import FormTemplate, TemplateStatus
from fieldsync.formtemplates.services import sha256_hex
from fieldsync.submissions.models import (
    Submission,
    SubmissionStatus,
    SubmissionVersion,
    VersionSource,
)
from fieldsync.sync.models import DeviceFacilityState, SyncEvent, SyncEventType

# ISO 3166-2:LR subdivision codes.
COUNTIES = [
    ("BM", "Bomi"), ("BG", "Bong"), ("GP", "Gbarpolu"), ("GB", "Grand Bassa"),
    ("CM", "Grand Cape Mount"), ("GG", "Grand Gedeh"), ("GK", "Grand Kru"), ("LO", "Lofa"),
    ("MG", "Margibi"), ("MY", "Maryland"), ("MO", "Montserrado"), ("NI", "Nimba"),
    ("RI", "River Cess"), ("RG", "River Gee"), ("SI", "Sinoe"),
]  # fmt: skip
DEMO_COUNTIES = ("BG", "NI", "MO", "LO")
FACILITY_LAYOUT = [
    ("HC", FacilityType.HEALTH_CENTER, "Demo Health Centre"),
    ("CL", FacilityType.CLINIC, "Demo Clinic"),
    ("CP", FacilityType.COMMUNITY_POST, "Demo Community Post"),
    ("HC", FacilityType.HEALTH_CENTER, "Demo Health Centre"),
    ("CP", FacilityType.COMMUNITY_POST, "Demo Community Post"),
    ("HO", FacilityType.HOSPITAL, "Demo District Hospital"),
]


@dataclass(frozen=True)
class Account:
    username: str
    display_name: str
    role: Role
    county: str | None
    facilities: tuple[str, ...] = ()


ACCOUNTS = [
    Account("admin", "National Administrator (demo)", Role.ADMIN, None),
    Account("supervisor.bong", "Bong CHT Supervisor (demo)", Role.SUPERVISOR, "BG"),
    Account("supervisor.nimba", "Nimba CHT Supervisor (demo)", Role.SUPERVISOR, "NI"),
    Account("chw.bong.1", "CHW Bong 1 (demo)", Role.CHW, "BG", ("BG-HC-001",)),
    Account("chw.bong.2", "CHW Bong 2 (demo)", Role.CHW, "BG", ("BG-CL-002", "BG-CP-003")),
    Account("chw.nimba.1", "CHW Nimba 1 (demo)", Role.CHW, "NI", ("NI-HC-001",)),
]


# facility code → (owner username, sync-health profile shown on the demo dashboard)
DEMO_PLAN: dict[str, tuple[str, str]] = {
    "BG-HC-001": ("chw.bong.1", "healthy"),
    "BG-CL-002": ("chw.bong.2", "degraded"),
    "BG-CP-003": ("chw.bong.2", "stale"),
    "NI-HC-001": ("chw.nimba.1", "healthy"),
}


class Command(BaseCommand):
    help = "Seed synthetic demo data (counties, facilities, accounts, templates, history)."

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("--password", help="Use this password for every demo account.")
        parser.add_argument("--history-days", type=int, default=14)
        parser.add_argument("--no-history", action="store_true")
        parser.add_argument("--seed", type=int, default=20261119, help="RNG seed (reproducible)")
        parser.add_argument(
            "--reset-device-states",
            action="store_true",
            help="Test stacks: drop queue reports from throwaway (non-seeded) devices, e.g. "
            "earlier E2E browser contexts, so the dashboard shows only the seeded scenario.",
        )

    @transaction.atomic
    def handle(self, *args: Any, **options: Any) -> None:
        rng = random.Random(options["seed"])
        counties = self._counties()
        facilities = self._facilities(counties)
        credentials = self._accounts(counties, facilities, options.get("password"))
        templates = self._templates()
        if not options["no_history"] and not Submission.objects.exists():
            self._history(rng, facilities, templates, days=options["history_days"])
        if not options["no_history"]:
            # Time-relative ("reported an hour ago"), so refreshed on every run: otherwise the
            # demo dashboard silently ages from "degraded" to "stale" two days after seeding.
            self._device_states(random.Random(options["seed"]), facilities)
        if options["reset_device_states"]:
            DeviceFacilityState.objects.exclude(device__label__startswith="Seeded").delete()
        self._print_credentials(credentials, fixed=bool(options.get("password")))

    # ── Reference data ────────────────────────────────────────────────────────
    def _counties(self) -> dict[str, County]:
        result = {}
        for code, name in COUNTIES:
            county, _ = County.objects.get_or_create(code=code, defaults={"name": name})
            result[code] = county
        return result

    def _facilities(self, counties: dict[str, County]) -> dict[str, Facility]:
        result = {}
        for county_code in DEMO_COUNTIES:
            for index, (kind, facility_type, label) in enumerate(FACILITY_LAYOUT, start=1):
                code = f"{county_code}-{kind}-{index:03d}"
                facility, _ = Facility.objects.get_or_create(
                    code=code,
                    defaults={
                        "name": f"{label} {index} ({counties[county_code].name})",
                        "county": counties[county_code],
                        "district": f"Demo District {'AB'[index % 2]}",
                        "facility_type": facility_type,
                    },
                )
                result[code] = facility
        return result

    def _accounts(
        self, counties: dict[str, County], facilities: dict[str, Facility], password: str | None
    ) -> list[tuple[Account, str]]:
        credentials = []
        for account in ACCOUNTS:
            user = User.objects.filter(username=account.username).first()
            if user is None:
                user = User.objects.create_user(
                    account.username,
                    None,
                    display_name=account.display_name,
                    role=account.role,
                    county=counties[account.county] if account.county else None,
                    is_staff=account.role == Role.ADMIN,
                    is_superuser=account.role == Role.ADMIN,
                )
            secret = password or secrets.token_urlsafe(12)
            user.set_password(secret)
            user.failed_logins = 0
            user.locked_until = None
            user.save()
            for code in account.facilities:
                FacilityAssignment.objects.get_or_create(user=user, facility=facilities[code])
            credentials.append((account, secret))
        return credentials

    def _templates(self) -> list[FormTemplate]:
        admin = User.objects.get(username="admin")
        result = []
        for path in sorted((settings.FIELDSYNC_CONTRACTS_DIR / "examples").glob("*.json")):
            definition = json.loads(path.read_text(encoding="utf-8"))
            template = FormTemplate.objects.filter(
                code=definition["code"], version=definition["version"]
            ).first()
            if template is None:
                template = template_services.create_draft(definition=definition, created_by=admin)
            if template.status == TemplateStatus.DRAFT:
                template = template_services.publish(template)
            result.append(template)
        return result

    # ── Synthetic history (gives the supervisor dashboard every health state) ──
    def _history(
        self,
        rng: random.Random,
        facilities: dict[str, Facility],
        templates: list[FormTemplate],
        *,
        days: int,
    ) -> None:
        now = timezone.now()
        patient_template = next(t for t in templates if t.subject == "patient")
        facility_template = next(t for t in templates if t.subject == "facility")
        for code, (username, profile) in DEMO_PLAN.items():
            user = User.objects.get(username=username)
            facility = facilities[code]
            device = self._device(user, rng)
            last_day = days if profile != "stale" else 5  # stale: nothing in the last 4 days
            first_day = 4 if profile == "stale" else 0
            for day in range(first_day, last_day):
                for _ in range(rng.randint(2, 5)):
                    at = now - timedelta(
                        days=day, hours=rng.randint(0, 8), minutes=rng.randint(0, 59)
                    )
                    template = facility_template if rng.random() < 0.1 else patient_template
                    attempt = (
                        1
                        if rng.random() < (0.92 if profile == "healthy" else 0.6)
                        else rng.randint(2, 6)
                    )
                    self._submission(user, device, facility, template, rng, at, attempt)

    def _device_states(self, rng: random.Random, facilities: dict[str, Facility]) -> None:
        now = timezone.now()
        for code, (username, profile) in DEMO_PLAN.items():
            device = self._device(User.objects.get(username=username), rng)
            facility = facilities[code]
            state: dict[str, Any] = {
                "healthy": {"pending": rng.randint(0, 2), "oldest": timedelta(hours=2)},
                "degraded": {
                    "pending": 6,
                    "failed": 1,
                    "conflicts": 1,
                    "oldest": timedelta(hours=20),
                },
                "stale": {"pending": 23, "stuck": 3, "oldest": timedelta(days=4)},
            }[profile]
            DeviceFacilityState.objects.update_or_create(
                device=device,
                facility=facility,
                defaults={
                    "pending": state["pending"],
                    "failed": state.get("failed", 0),
                    "conflicts": state.get("conflicts", 0),
                    "stuck": state.get("stuck", 0),
                    "oldest_pending_at": now - state["oldest"] if state["pending"] else None,
                    "last_attempt_at": now - timedelta(hours=1),
                    "last_success_at": now
                    - (timedelta(days=4) if profile == "stale" else timedelta(hours=3)),
                    "reported_at": now
                    - (timedelta(days=4) if profile == "stale" else timedelta(hours=1)),
                },
            )

    def _device(self, user: User, rng: random.Random) -> Device:
        device = Device.objects.filter(user=user, label__startswith="Seeded").first()
        if device:
            return device
        device_id = uuid.UUID(int=rng.getrandbits(128), version=4)
        sealed, key_id = escrow.seal(escrow.new_secret(), device_id)
        return Device.objects.create(
            id=device_id,
            user=user,
            label="Seeded Android · Chrome",
            app_version="0.1.0",
            escrow_secret_enc=sealed,
            escrow_key_id=key_id,
        )

    def _submission(
        self,
        user: User,
        device: Device,
        facility: Facility,
        template: FormTemplate,
        rng: random.Random,
        at: Any,
        attempt: int,
    ) -> None:
        payload = payload_for(template.definition, rng, at)
        client_uuid = uuid.UUID(int=rng.getrandbits(128), version=4)
        submission = Submission.objects.create(
            client_uuid=client_uuid,
            template=template,
            facility=facility,
            submitted_by=user,
            device=device,
            payload=payload,
            payload_hash=sha256_hex(payload),
            status=SubmissionStatus.ACCEPTED,
            version=1,
            captured_at=at - timedelta(minutes=rng.randint(5, 600)),
        )
        Submission.objects.filter(pk=submission.pk).update(received_at=at, updated_at=at)
        SubmissionVersion.objects.create(
            submission=submission,
            version=1,
            payload=payload,
            payload_hash=submission.payload_hash,
            status=SubmissionStatus.ACCEPTED,
            source=VersionSource.DEVICE,
            changed_by=user,
            device=device,
        )
        SyncEvent.objects.create(
            occurred_at=at,
            event_type=SyncEventType.SUBMISSION_CREATED,
            user_id=user.id,
            device_id=device.id,
            facility_id=facility.id,
            submission_id=submission.id,
            client_uuid=client_uuid,
            client_attempt=attempt,
            detail={"version": 1, "seeded": True},
        )

    def _print_credentials(self, credentials: list[tuple[Account, str]], *, fixed: bool) -> None:
        out = self.stdout
        out.write("# FieldSync demo accounts (synthetic — local use only)\n\n")
        out.write("Generated by `seed_demo`. Keep this file out of version control.\n\n")
        out.write("| Username | Role | County | Facilities | Password |\n|---|---|---|---|---|\n")
        for account, password in credentials:
            shown = "(the --password value)" if fixed else f"`{password}`"
            facilities = ", ".join(account.facilities) or "—"
            out.write(
                f"| `{account.username}` | {account.role} | {account.county or 'national'} "
                f"| {facilities} | {shown} |\n"
            )
