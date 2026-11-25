import { describe, expect, it } from 'vitest';

import { UUIDv7Generator, isUuidV7, uuidV7TimestampMs, uuidv7 } from './uuidv7';

describe('uuidv7', () => {
  it('has version 7 and RFC 4122 variant', () => {
    for (let i = 0; i < 100; i += 1) expect(isUuidV7(uuidv7())).toBe(true);
  });

  it('embeds the millisecond timestamp (48 bits, beyond 2^32)', () => {
    const gen = new UUIDv7Generator(() => 1_763_553_600_000);
    expect(uuidV7TimestampMs(gen.next())).toBe(1_763_553_600_000);
  });

  it('is strictly increasing within one millisecond, across counter overflow', () => {
    const gen = new UUIDv7Generator(() => 1_000);
    const values = Array.from({ length: 5000 }, () => gen.next());
    expect([...values].sort()).toEqual(values);
    expect(new Set(values).size).toBe(values.length);
  });

  it('stays monotonic when the device clock goes backwards', () => {
    const ticks = [5_000, 5_000, 4_000, 3_000, 6_000, 6_000];
    const gen = new UUIDv7Generator(() => ticks.shift() ?? 6_000);
    const values = Array.from({ length: 6 }, () => gen.next());
    expect([...values].sort()).toEqual(values);
  });

  it('seeds the counter in the lower half', () => {
    const gen = new UUIDv7Generator(
      () => 1,
      (b) => b.fill(0xff),
    );
    const value = gen.next();
    const counter = parseInt(value.slice(15, 18), 16);
    expect(counter).toBe(0x7ff);
  });

  it('matches the Python twin byte layout for a fixed clock and randomness', () => {
    // Same inputs as backend: ms=1, random bytes all 0xff → counter 0x7ff.
    const gen = new UUIDv7Generator(
      () => 1,
      (b) => b.fill(0xff),
    );
    expect(gen.next()).toBe('00000000-0001-77ff-bfff-ffffffffffff');
  });
});
