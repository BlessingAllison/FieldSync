"""Re-seal device escrow secrets under the active escrow KEK (ADD §11.4.3 rotation).

    python manage.py rotate_escrow --dry-run   # how many devices still use an old key
    python manage.py rotate_escrow             # re-seal them under ESCROW_ACTIVE_KEY_ID

Rotation procedure (see docs/MAINTENANCE.md): add the new key to ESCROW_KEKS, switch
ESCROW_ACTIVE_KEY_ID, deploy, run this command, confirm the dry run reports 0, then remove
the old key. The device secret itself does not change (phones keep their wrapped keys);
only the server-side envelope is re-encrypted. Each device is re-sealed in its own short
transaction with a row lock, so the command is safe to interrupt and re-run.
"""

from __future__ import annotations

from typing import Any

from django.core.management.base import BaseCommand, CommandError, CommandParser
from django.db import transaction

from fieldsync.accounts import escrow
from fieldsync.accounts.models import Device


class Command(BaseCommand):
    help = "Re-seal device escrow secrets under the active escrow KEK."

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("--dry-run", action="store_true")

    def handle(self, *args: Any, **options: Any) -> None:
        ring = escrow.keyring()
        stale = Device.objects.exclude(escrow_key_id=ring.active_id)
        missing = sorted(
            set(stale.values_list("escrow_key_id", flat=True).distinct()) - set(ring.keys)
        )
        if missing:
            raise CommandError(
                f"devices are sealed under key id(s) {missing}, which are not in ESCROW_KEKS; "
                "restore those keys before rotating"
            )
        total = stale.count()
        if options["dry_run"]:
            self.stdout.write(f"{total} device(s) not sealed under active key {ring.active_id}")
            return
        done = 0
        for device_id in stale.values_list("id", flat=True).iterator():
            with transaction.atomic():
                device = Device.objects.select_for_update().get(pk=device_id)
                if device.escrow_key_id == ring.active_id:
                    continue  # re-sealed concurrently (e.g. by a sign-in)
                secret = escrow.unseal(
                    bytes(device.escrow_secret_enc), device.escrow_key_id, device.id, ring
                )
                device.escrow_secret_enc, device.escrow_key_id = escrow.seal(
                    secret, device.id, ring
                )
                device.save(update_fields=["escrow_secret_enc", "escrow_key_id"])
                done += 1
        self.stdout.write(f"re-sealed {done} device(s) under key {ring.active_id}")
