from __future__ import annotations

import base64
import uuid
from datetime import timedelta
from typing import Any

import pytest
from cryptography.exceptions import InvalidTag
from django.test import override_settings
from django.utils import timezone
from freezegun import freeze_time
from rest_framework.test import APIClient

from fieldsync.accounts import escrow
from fieldsync.accounts.models import Device
from tests.factories import PASSWORD, World

pytestmark = pytest.mark.django_db

REFRESH_HEADER = "fieldsync"


def _login(
    client: APIClient, username: str, password: str = PASSWORD, device_id: uuid.UUID | None = None
) -> Any:
    return client.post(
        "/api/v1/auth/login",
        {
            "username": username,
            "password": password,
            "device": {
                "id": str(device_id or uuid.uuid4()),
                "label": "Pixel 5",
                "app_version": "0.1.0",
            },
        },
        format="json",
    )


def test_login_issues_access_cookie_profile_and_escrow(world: World) -> None:
    client = APIClient()
    device_id = uuid.uuid4()
    response = _login(client, "CHW.BG", device_id=device_id)  # usernames are case-insensitive
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["access"].count(".") == 2
    assert data["user"]["role"] == "chw"
    assert data["user"]["facility_ids"] == [str(world.bg1.id)]
    assert data["user"]["county"]["code"] == "BG"
    secret = base64.urlsafe_b64decode(data["device"]["escrow_secret"] + "==")
    assert len(secret) == 32
    cookie = response.cookies["fs_rt"]
    assert cookie["httponly"]
    assert cookie["secure"]
    assert cookie["samesite"] == "Strict"
    assert cookie["path"] == "/api/v1/auth/"
    assert "fs_rt" not in response.content.decode()  # refresh token never in the body
    device = Device.objects.get(id=device_id)
    assert escrow.unseal(bytes(device.escrow_secret_enc), device.escrow_key_id, device.id) == secret


def test_repeat_login_on_same_device_returns_same_escrow_secret(world: World) -> None:
    device_id = uuid.uuid4()
    first = _login(APIClient(), "chw.bg", device_id=device_id).json()["data"]["device"]
    second = _login(APIClient(), "chw.bg", device_id=device_id).json()["data"]["device"]
    assert first["escrow_secret"] == second["escrow_secret"]


def test_wrong_password_and_unknown_user_look_identical(world: World) -> None:
    wrong = _login(APIClient(), "chw.bg", "nope")
    unknown = _login(APIClient(), "nobody", "nope")
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json()["error"] == unknown.json()["error"]
    assert wrong.json()["error"]["code"] == "invalid_credentials"


@override_settings(LOGIN_MAX_FAILURES=3)
def test_progressive_lockout(world: World) -> None:
    for _ in range(3):
        assert _login(APIClient(), "chw.bg", "wrong").status_code == 401
    locked = _login(APIClient(), "chw.bg")  # even the right password is refused while locked
    assert locked.status_code == 403
    assert locked.json()["error"]["code"] == "account_locked"
    assert int(locked["Retry-After"]) > 0


def test_device_id_of_another_user_is_refused(world: World) -> None:
    response = _login(APIClient(), "chw.bg2", device_id=world.dev_chw_bg.id)
    assert response.status_code == 403


def test_revoked_device_cannot_log_in(world: World) -> None:
    Device.objects.filter(pk=world.dev_chw_bg.pk).update(revoked_at=timezone.now())
    response = _login(APIClient(), "chw.bg", device_id=world.dev_chw_bg.id)
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "device_revoked"


def test_refresh_rotates_and_old_token_is_blacklisted(world: World) -> None:
    client = APIClient()
    _login(client, "chw.bg")
    old_cookie = client.cookies["fs_rt"].value
    response = client.post("/api/v1/auth/refresh", HTTP_X_REQUESTED_WITH=REFRESH_HEADER)
    assert response.status_code == 200
    assert response.json()["data"]["user"]["username"] == "chw.bg"
    new_cookie = client.cookies["fs_rt"].value
    assert new_cookie != old_cookie
    replay = APIClient()
    replay.cookies["fs_rt"] = old_cookie
    reused = replay.post("/api/v1/auth/refresh", HTTP_X_REQUESTED_WITH=REFRESH_HEADER)
    assert reused.status_code == 401
    assert reused.json()["error"]["code"] == "token_invalid"


def test_refresh_requires_csrf_header_and_same_origin(world: World) -> None:
    client = APIClient()
    _login(client, "chw.bg")
    assert client.post("/api/v1/auth/refresh").status_code == 403
    cross = client.post(
        "/api/v1/auth/refresh",
        HTTP_ORIGIN="https://evil.example",
        HTTP_X_REQUESTED_WITH=REFRESH_HEADER,
    )
    assert cross.status_code == 403


def test_refresh_refused_for_revoked_device(world: World) -> None:
    client = APIClient()
    device_id = uuid.uuid4()
    _login(client, "chw.bg", device_id=device_id)
    Device.objects.filter(pk=device_id).update(revoked_at=timezone.now())
    response = client.post("/api/v1/auth/refresh", HTTP_X_REQUESTED_WITH=REFRESH_HEADER)
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "device_revoked"


def test_refresh_absolute_cap(world: World) -> None:
    """Sliding 14-day refresh keeps a session alive, but never past 30 days from sign-in."""
    client = APIClient()
    start = timezone.now() - timedelta(days=29, hours=23)
    with freeze_time(start):
        _login(client, "chw.bg")
    for day in (13, 26):
        with freeze_time(start + timedelta(days=day)):
            assert (
                client.post(
                    "/api/v1/auth/refresh", HTTP_X_REQUESTED_WITH=REFRESH_HEADER
                ).status_code
                == 200
            )
    assert (
        client.post("/api/v1/auth/refresh", HTTP_X_REQUESTED_WITH=REFRESH_HEADER).status_code == 200
    )
    with freeze_time(timezone.now() + timedelta(hours=2)):
        expired = client.post("/api/v1/auth/refresh", HTTP_X_REQUESTED_WITH=REFRESH_HEADER)
    assert expired.status_code == 401
    assert expired.json()["error"]["code"] == "token_expired"


def test_access_token_expiry_and_revocation(world: World) -> None:
    client = APIClient()
    data = _login(client, "chw.bg").json()["data"]
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {data['access']}")
    assert client.get("/api/v1/auth/me").status_code == 200
    with freeze_time(timezone.now() + timedelta(minutes=11)):
        expired = client.get("/api/v1/auth/me")
    assert expired.status_code == 401
    assert expired.json()["error"]["code"] == "token_expired"
    assert expired["WWW-Authenticate"].startswith("Bearer")


def test_revocation_takes_effect_immediately_for_access_tokens(world: World) -> None:
    client = world.client("chw_bg")
    Device.objects.filter(pk=world.dev_chw_bg.pk).update(revoked_at=timezone.now())
    response = client.get("/api/v1/facilities")
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "device_revoked"


@pytest.mark.parametrize("header", ["Basic abc", "Bearer", "Bearer not.a.jwt"])
def test_malformed_authorization(world: World, header: str) -> None:
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=header)
    response = client.get("/api/v1/auth/me")
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "token_invalid"


def test_logout_blacklists_refresh_and_clears_cookie(world: World) -> None:
    client = APIClient()
    _login(client, "chw.bg")
    cookie = client.cookies["fs_rt"].value
    response = client.post("/api/v1/auth/logout", HTTP_X_REQUESTED_WITH=REFRESH_HEADER)
    assert response.status_code == 200
    assert response.cookies["fs_rt"].value == ""
    stale = APIClient()
    stale.cookies["fs_rt"] = cookie
    assert (
        stale.post("/api/v1/auth/refresh", HTTP_X_REQUESTED_WITH=REFRESH_HEADER).status_code == 401
    )


def test_me_reports_scope(world: World) -> None:
    data = world.client("sup_bg").get("/api/v1/auth/me").json()["data"]
    assert data["role"] == "supervisor"
    assert set(data["facility_ids"]) == {str(world.bg1.id), str(world.bg2.id)}


def test_escrow_key_rotation_reseals_on_login(world: World, settings: Any) -> None:
    device_id = uuid.uuid4()
    first = _login(APIClient(), "chw.bg", device_id=device_id).json()["data"]["device"]
    original_id = Device.objects.get(id=device_id).escrow_key_id
    new_id = original_id + 1
    new_key = base64.b64encode(escrow.new_secret()).decode()
    settings.ESCROW_KEKS = f"{settings.ESCROW_KEKS},{new_id}:{new_key}"
    settings.ESCROW_ACTIVE_KEY_ID = new_id
    escrow.keyring.cache_clear()
    try:
        second = _login(APIClient(), "chw.bg", device_id=device_id).json()["data"]["device"]
        assert second["escrow_secret"] == first["escrow_secret"]
        assert Device.objects.get(id=device_id).escrow_key_id == new_id
    finally:
        escrow.keyring.cache_clear()


def test_rotate_escrow_command_reseals_devices_that_never_sign_in_again(
    world: World, settings: Any
) -> None:
    from io import StringIO

    from django.core.management import call_command
    from django.core.management.base import CommandError

    device = world.dev_chw_bg
    secret = escrow.unseal(bytes(device.escrow_secret_enc), device.escrow_key_id, device.id)
    old_id = device.escrow_key_id
    new_id = old_id + 1
    old_keks = settings.ESCROW_KEKS
    settings.ESCROW_KEKS = f"{old_keks},{new_id}:{base64.b64encode(escrow.new_secret()).decode()}"
    settings.ESCROW_ACTIVE_KEY_ID = new_id
    escrow.keyring.cache_clear()
    try:
        out = StringIO()
        call_command("rotate_escrow", "--dry-run", stdout=out)
        stale = Device.objects.exclude(escrow_key_id=new_id).count()
        assert f"{stale} device(s) not sealed under active key {new_id}" in out.getvalue()
        call_command("rotate_escrow", stdout=StringIO())
        device.refresh_from_db()
        assert device.escrow_key_id == new_id
        assert escrow.unseal(bytes(device.escrow_secret_enc), new_id, device.id) == secret
        out = StringIO()
        call_command("rotate_escrow", "--dry-run", stdout=out)
        assert "0 device(s)" in out.getvalue()  # safe to retire the old key now
        # A device sealed under a key that is no longer configured stops the command.
        Device.objects.filter(pk=device.pk).update(escrow_key_id=99)
        with pytest.raises(CommandError, match="99"):
            call_command("rotate_escrow", stdout=StringIO())
    finally:
        settings.ESCROW_KEKS = old_keks
        escrow.keyring.cache_clear()


def test_escrow_ciphertext_is_bound_to_device() -> None:
    secret = escrow.new_secret()
    a, b = uuid.uuid4(), uuid.uuid4()
    sealed, key_id = escrow.seal(secret, a)
    assert escrow.unseal(sealed, key_id, a) == secret
    with pytest.raises(InvalidTag):
        escrow.unseal(sealed, key_id, b)


def test_login_is_throttled(world: World) -> None:
    from django.core.cache import cache

    statuses = [_login(APIClient(), "nobody", "x").status_code for _ in range(12)]
    cache.clear()
    assert 429 in statuses
    assert statuses[:10] == [401] * 10
