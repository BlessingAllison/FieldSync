"""UUIDv7 (RFC 9562) generation.

Server-side ids (``submissions.id``) and device-side idempotency keys
(``client_uuid``) are both UUIDv7: 48-bit Unix-ms timestamp, then a 12-bit
counter in ``rand_a`` (RFC 9562 §6.2 method 1) for monotonicity within a
millisecond, then 62 random bits. Time-ordering keeps the unique B-tree indexes
append-mostly. The TypeScript twin lives in ``frontend/src/core/ids/uuidv7.ts``;
both are tested against the same layout rules.
"""

from __future__ import annotations

import secrets
import threading
import time
import uuid
from collections.abc import Callable
from typing import Final

_COUNTER_MAX: Final = 0xFFF
_COUNTER_SEED_MAX: Final = 0x7FF  # seed in the lower half to leave room for increments


class UUIDv7Generator:
    def __init__(
        self,
        *,
        clock_ms: Callable[[], int] | None = None,
        random_bytes: Callable[[int], bytes] = secrets.token_bytes,
    ) -> None:
        self._clock_ms = clock_ms or (lambda: time.time_ns() // 1_000_000)
        self._random_bytes = random_bytes
        self._lock = threading.Lock()
        self._last_ms = -1
        self._counter = 0

    def _seed_counter(self) -> int:
        return int.from_bytes(self._random_bytes(2), "big") & _COUNTER_SEED_MAX

    def __call__(self) -> uuid.UUID:
        with self._lock:
            now = self._clock_ms()
            if now > self._last_ms:
                self._last_ms = now
                self._counter = self._seed_counter()
            else:
                # Same millisecond, or the clock moved backwards: stay monotonic.
                self._counter += 1
                if self._counter > _COUNTER_MAX:
                    self._last_ms += 1
                    self._counter = self._seed_counter()
            ms, counter = self._last_ms, self._counter

        rand = self._random_bytes(8)
        value = bytearray(16)
        value[0:6] = (ms & 0xFFFF_FFFF_FFFF).to_bytes(6, "big")
        value[6] = 0x70 | ((counter >> 8) & 0x0F)
        value[7] = counter & 0xFF
        value[8] = 0x80 | (rand[0] & 0x3F)
        value[9:16] = rand[1:8]
        return uuid.UUID(bytes=bytes(value))


uuid7: Final = UUIDv7Generator()


def uuid7_timestamp_ms(value: uuid.UUID) -> int:
    if value.version != 7:
        raise ValueError("not a UUIDv7")
    return int.from_bytes(value.bytes[0:6], "big")


def new_uuid7() -> uuid.UUID:
    """Model-field default (module-level so migrations can reference it)."""
    return uuid7()
