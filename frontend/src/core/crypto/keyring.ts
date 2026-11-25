/**
 * Envelope-encryption key hierarchy (ADD §11.4.1):
 *
 *   password ─PBKDF2-SHA256(600k, salt)─► KEK_pw ─┐
 *                                                  ├─ AES-KW wraps ─► DEK (AES-GCM-256)
 *   escrow secret ─HKDF-SHA256(salt, info)──► KEK_esc ┘
 *
 * The DEK is generated on the device, wrapped twice and never stored in the clear. Unwrapped
 * copies are non-extractable CryptoKeys: script (including injected script) cannot export
 * the key bytes. The escrow path lets a supervisor password reset re-wrap the DEK without
 * losing unsynced forms; the escrow secret itself is never persisted on the device.
 */
import { bufferOf, randomBytes, utf8 } from '../util/bytes';

/** OWASP 2023 recommendation for PBKDF2-HMAC-SHA256. Stored per keyring so it can be raised. */
export const PBKDF2_ITERATIONS = 600_000;
const HKDF_INFO = utf8('fs-escrow-kek-v1');

export interface KeyringRecord {
  version: 1;
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: Uint8Array;
  escrowSalt: Uint8Array;
  wrappedByPassword: ArrayBuffer;
  wrappedByEscrow: ArrayBuffer;
  createdAt: number;
}

const subtle = () => globalThis.crypto.subtle;

async function passwordKek(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const material = await subtle().importKey('raw', bufferOf(utf8(password)), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: bufferOf(salt), iterations },
    material,
    { name: 'AES-KW', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

async function escrowKek(secret: Uint8Array, salt: Uint8Array): Promise<CryptoKey> {
  const material = await subtle().importKey('raw', bufferOf(secret), 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: bufferOf(salt), info: bufferOf(HKDF_INFO) },
    material,
    { name: 'AES-KW', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

const unwrapDek = (wrapped: ArrayBuffer, kek: CryptoKey, extractable: boolean) =>
  subtle().unwrapKey('raw', wrapped, kek, 'AES-KW', { name: 'AES-GCM', length: 256 }, extractable, [
    'encrypt',
    'decrypt',
  ]);

export class WrongPasswordError extends Error {
  constructor() {
    super('The password does not unlock this device’s data');
    this.name = 'WrongPasswordError';
  }
}

/** First sign-in on a device: create and double-wrap a fresh DEK. */
export async function createKeyring(
  password: string,
  escrowSecret: Uint8Array,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<{ record: KeyringRecord; dek: CryptoKey }> {
  // Generated extractable only so it can be wrapped; the copy we keep is non-extractable.
  const transient = await subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
  const salt = randomBytes(16);
  const escrowSalt = randomBytes(16);
  const [kekPw, kekEsc] = await Promise.all([
    passwordKek(password, salt, iterations),
    escrowKek(escrowSecret, escrowSalt),
  ]);
  const [wrappedByPassword, wrappedByEscrow] = await Promise.all([
    subtle().wrapKey('raw', transient, kekPw, 'AES-KW'),
    subtle().wrapKey('raw', transient, kekEsc, 'AES-KW'),
  ]);
  const record: KeyringRecord = {
    version: 1,
    kdf: 'PBKDF2-SHA256',
    iterations,
    salt,
    escrowSalt,
    wrappedByPassword,
    wrappedByEscrow,
    createdAt: Date.now(),
  };
  const dek = await unwrapDek(wrappedByPassword, kekPw, false);
  return { record, dek };
}

export async function unlockWithPassword(
  record: KeyringRecord,
  password: string,
): Promise<CryptoKey> {
  const kek = await passwordKek(password, record.salt, record.iterations);
  try {
    return await unwrapDek(record.wrappedByPassword, kek, false);
  } catch {
    throw new WrongPasswordError(); // AES-KW integrity check failed
  }
}

/**
 * Online sign-in after a password reset: the old password no longer unwraps the DEK, but the
 * server-held escrow secret does. Re-wrap under the new password and return the new record.
 */
export async function rewrapWithEscrow(
  record: KeyringRecord,
  escrowSecret: Uint8Array,
  newPassword: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<{ record: KeyringRecord; dek: CryptoKey }> {
  const kekEsc = await escrowKek(escrowSecret, record.escrowSalt);
  let transient: CryptoKey;
  try {
    transient = await unwrapDek(record.wrappedByEscrow, kekEsc, true);
  } catch {
    throw new WrongPasswordError();
  }
  const salt = randomBytes(16);
  const kekPw = await passwordKek(newPassword, salt, iterations);
  const wrappedByPassword = await subtle().wrapKey('raw', transient, kekPw, 'AES-KW');
  const next: KeyringRecord = { ...record, iterations, salt, wrappedByPassword };
  const dek = await unwrapDek(wrappedByPassword, kekPw, false);
  return { record: next, dek };
}
