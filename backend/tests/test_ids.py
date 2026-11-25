from __future__ import annotations

import itertools
import uuid

from fieldsync.common.ids import UUIDv7Generator, uuid7, uuid7_timestamp_ms


def test_layout_version_and_variant() -> None:
    value = uuid7()
    assert value.version == 7
    assert value.variant == uuid.RFC_4122


def test_timestamp_is_embedded() -> None:
    gen = UUIDv7Generator(clock_ms=lambda: 1_763_553_600_000)
    assert uuid7_timestamp_ms(gen()) == 1_763_553_600_000


def test_monotonic_within_same_millisecond() -> None:
    gen = UUIDv7Generator(clock_ms=lambda: 1_000)
    values = [gen() for _ in range(5000)]  # exceeds the 12-bit counter → ms advances
    assert values == sorted(values)
    assert len(set(values)) == len(values)


def test_monotonic_when_clock_goes_backwards() -> None:
    ticks = itertools.chain([5_000, 5_000, 4_000, 3_000], itertools.repeat(6_000))
    gen = UUIDv7Generator(clock_ms=lambda: next(ticks))
    values = [gen() for _ in range(6)]
    assert values == sorted(values)


def test_counter_seeded_in_lower_half() -> None:
    gen = UUIDv7Generator(clock_ms=lambda: 1, random_bytes=lambda n: b"\xff" * n)
    first = gen()
    counter = ((first.bytes[6] & 0x0F) << 8) | first.bytes[7]
    assert counter == 0x7FF


def test_matches_typescript_twin_byte_layout() -> None:
    # Same vector as frontend/src/core/ids/uuidv7.test.ts: ms=1, all random bytes 0xff.
    gen = UUIDv7Generator(clock_ms=lambda: 1, random_bytes=lambda n: b"\xff" * n)
    assert str(gen()) == "00000000-0001-77ff-bfff-ffffffffffff"
