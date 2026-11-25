"""Device key-escrow secrets (ADD §11.4.3).

Each device gets 32 random bytes at first registration. The PWA uses it (via HKDF) to
wrap its data-encryption key a second time, so a supervisor password reset does not
destroy unsynced forms. The secret is stored here encrypted under a server KEK
(AES-256-GCM, AAD = device id), is returned only in an authenticated online login
response, and is never persisted on the device.
"""

from __future__ import annotations

import base64
import os
import uuid
from dataclasses import dataclass
from functools import cache

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from django.conf import settings
from django.core.exceptions import ImproperlyConfigured

SECRET_BYTES = 32
_NONCE_BYTES = 12


@dataclass(frozen=True, slots=True)
class Keyring:
    keys: dict[int, bytes]
    active_id: int


def parse_keks(raw: str, active_id: int) -> Keyring:
    keys: dict[int, bytes] = {}
    for item in filter(None, (part.strip() for part in raw.split(","))):
        key_id_text, _, encoded = item.partition(":")
        try:
            key_id = int(key_id_text)
            key = base64.b64decode(encoded, validate=True)
        except ValueError as exc:
            raise ImproperlyConfigured("ESCROW_KEKS entries must be '<int>:<base64>'") from exc
        if len(key) != 32:
            raise ImproperlyConfigured(f"ESCROW_KEKS key {key_id} must be 32 bytes")
        keys[key_id] = key
    if active_id not in keys:
        raise ImproperlyConfigured("ESCROW_ACTIVE_KEY_ID is not present in ESCROW_KEKS")
    return Keyring(keys=keys, active_id=active_id)


@cache
def keyring() -> Keyring:
    return parse_keks(settings.ESCROW_KEKS, settings.ESCROW_ACTIVE_KEY_ID)


def new_secret() -> bytes:
    return os.urandom(SECRET_BYTES)


def seal(secret: bytes, device_id: uuid.UUID, ring: Keyring | None = None) -> tuple[bytes, int]:
    ring = ring or keyring()
    nonce = os.urandom(_NONCE_BYTES)
    sealed = AESGCM(ring.keys[ring.active_id]).encrypt(nonce, secret, device_id.bytes)
    return nonce + sealed, ring.active_id


def unseal(blob: bytes, key_id: int, device_id: uuid.UUID, ring: Keyring | None = None) -> bytes:
    ring = ring or keyring()
    nonce, sealed = blob[:_NONCE_BYTES], blob[_NONCE_BYTES:]
    return AESGCM(ring.keys[key_id]).decrypt(nonce, sealed, device_id.bytes)


def encode(secret: bytes) -> str:
    return base64.urlsafe_b64encode(secret).decode("ascii").rstrip("=")
