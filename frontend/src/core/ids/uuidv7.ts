/**
 * UUIDv7 (RFC 9562) — the idempotency key (`client_uuid`) for every submission.
 *
 * Layout: 48-bit Unix ms | ver 7 | 12-bit counter (method 1, monotonic within a ms) |
 * variant 10 | 62 random bits. Twin of backend/fieldsync/common/ids.py; both are
 * tested against the same layout rules. Generated when the *draft* is created so
 * autosaves, saves, retries and edits all share one identity (ADD §12.4).
 */

const COUNTER_MAX = 0xfff;
const COUNTER_SEED_MAX = 0x7ff; // seed in the lower half, leaving room for increments

export type RandomFill = (bytes: Uint8Array) => Uint8Array;

const defaultRandom: RandomFill = (bytes) => globalThis.crypto.getRandomValues(bytes);

export class UUIDv7Generator {
  private lastMs = -1;
  private counter = 0;

  constructor(
    private readonly clockMs: () => number = () => Date.now(),
    private readonly random: RandomFill = defaultRandom,
  ) {}

  private seedCounter(): number {
    const seed = this.random(new Uint8Array(2));
    return (((seed[0] ?? 0) << 8) | (seed[1] ?? 0)) & COUNTER_SEED_MAX;
  }

  next(): string {
    const now = this.clockMs();
    if (now > this.lastMs) {
      this.lastMs = now;
      this.counter = this.seedCounter();
    } else {
      // Same millisecond, or the device clock moved backwards: stay monotonic.
      this.counter += 1;
      if (this.counter > COUNTER_MAX) {
        this.lastMs += 1;
        this.counter = this.seedCounter();
      }
    }

    const bytes = new Uint8Array(16);
    // 48-bit big-endian timestamp. Split to stay within 32-bit bitwise ops.
    const ms = this.lastMs;
    const high = Math.floor(ms / 2 ** 32);
    const low = ms >>> 0;
    bytes[0] = (high >>> 8) & 0xff;
    bytes[1] = high & 0xff;
    bytes[2] = (low >>> 24) & 0xff;
    bytes[3] = (low >>> 16) & 0xff;
    bytes[4] = (low >>> 8) & 0xff;
    bytes[5] = low & 0xff;
    bytes[6] = 0x70 | ((this.counter >>> 8) & 0x0f);
    bytes[7] = this.counter & 0xff;
    const rand = this.random(new Uint8Array(8));
    bytes[8] = 0x80 | ((rand[0] ?? 0) & 0x3f);
    bytes.set(rand.subarray(1, 8), 9);
    return format(bytes);
  }
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

function format(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < 16; i += 1) {
    if (i === 4 || i === 6 || i === 8 || i === 10) out += '-';
    out += HEX[bytes[i] ?? 0];
  }
  return out;
}

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidV7(value: string): boolean {
  return UUID_V7_RE.test(value);
}

export function uuidV7TimestampMs(value: string): number {
  if (!isUuidV7(value)) throw new Error('not a UUIDv7');
  return parseInt(value.slice(0, 8) + value.slice(9, 13), 16);
}

const shared = new UUIDv7Generator();

export const uuidv7 = (): string => shared.next();
