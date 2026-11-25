"""Login (with progressive lockout) and device registration."""

from __future__ import annotations

import math
import uuid
from datetime import timedelta

from django.conf import settings
from django.contrib.auth.hashers import make_password
from django.db import transaction
from django.utils import timezone

from fieldsync.accounts import escrow
from fieldsync.accounts.models import Device, User
from fieldsync.common.errors import ApiError, ErrorCode
from fieldsync.sync import events
from fieldsync.sync.models import SyncEventType


def authenticate_credentials(username: str, password: str) -> User:
    now = timezone.now()
    user = User.objects.filter(username=username.strip().lower()).first()
    if user is not None and user.locked_until and user.locked_until > now:
        wait = math.ceil((user.locked_until - now).total_seconds())
        raise ApiError(ErrorCode.ACCOUNT_LOCKED, retry_after=wait)
    if user is None:
        make_password(password)  # equalise timing with the existing-user path
        raise ApiError(ErrorCode.INVALID_CREDENTIALS)
    if not user.is_active or not user.check_password(password):
        failures = user.failed_logins + 1
        if failures >= settings.LOGIN_MAX_FAILURES:
            user.locked_until = now + timedelta(minutes=settings.LOGIN_LOCKOUT_MINUTES)
            failures = 0
        user.failed_logins = failures
        user.save(update_fields=["failed_logins", "locked_until"])
        raise ApiError(ErrorCode.INVALID_CREDENTIALS)
    user.failed_logins = 0
    user.locked_until = None
    user.last_login = now
    user.save(update_fields=["failed_logins", "locked_until", "last_login"])
    return user


@transaction.atomic
def register_device(
    *, user: User, device_id: uuid.UUID, label: str, app_version: str, request_id: str | None
) -> tuple[Device, bytes]:
    """Create or refresh the device row; returns it with its (unsealed) escrow secret."""
    device = Device.objects.select_for_update().filter(id=device_id).first()
    if device is not None and device.user_id != user.id:
        raise ApiError(
            ErrorCode.PERMISSION_DENIED, "This device identifier belongs to another account."
        )
    if device is not None and device.is_revoked:
        raise ApiError(ErrorCode.DEVICE_REVOKED)
    if device is None:
        secret = escrow.new_secret()
        sealed, key_id = escrow.seal(secret, device_id)
        device = Device.objects.create(
            id=device_id,
            user=user,
            label=label,
            app_version=app_version,
            escrow_secret_enc=sealed,
            escrow_key_id=key_id,
        )
        events.record(
            SyncEventType.DEVICE_REGISTERED,
            request_id=request_id,
            user_id=user.id,
            device_id=device.id,
            detail={"app_version": app_version},
        )
        return device, secret

    secret = escrow.unseal(bytes(device.escrow_secret_enc), device.escrow_key_id, device.id)
    ring = escrow.keyring()
    if device.escrow_key_id != ring.active_id:  # lazy KEK rotation
        device.escrow_secret_enc, device.escrow_key_id = escrow.seal(secret, device.id, ring)
    device.label = label
    device.app_version = app_version
    device.last_seen_at = timezone.now()
    device.save()
    return device, secret


@transaction.atomic
def revoke_device(device: Device, *, by: User, reason: str, request_id: str | None) -> Device:
    locked = Device.objects.select_for_update().get(pk=device.pk)
    if locked.revoked_at is None:
        locked.revoked_at = timezone.now()
        locked.revoked_by = by
        locked.revoke_reason = reason
        locked.save(update_fields=["revoked_at", "revoked_by", "revoke_reason"])
        events.record(
            SyncEventType.DEVICE_REVOKED,
            request_id=request_id,
            user_id=by.id,
            device_id=locked.id,
        )
    return locked
