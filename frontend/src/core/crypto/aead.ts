/**
 * Record encryption: AES-256-GCM, 96-bit random IV, AAD binding (ADD §11.4.1-11.4.2).
 *
 * AAD = "fs:v1:<store>:<key>" binds each ciphertext to the record it belongs to, so an
 * attacker who can write IndexedDB cannot move one record's ciphertext into another
 * (authentication fails). Plaintexts are JSON.
 */
import { bufferOf, fromUtf8, randomBytes, utf8 } from '../util/bytes';

export interface Sealed {
  iv: Uint8Array;
  ct: ArrayBuffer;
}

export const SCHEMA_TAG = 'fs:v1';

export const aadFor = (store: string, key: string): Uint8Array =>
  utf8(`${SCHEMA_TAG}:${store}:${key}`);

export async function seal(key: CryptoKey, value: unknown, aad: Uint8Array): Promise<Sealed> {
  const iv = randomBytes(12);
  const ct = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: bufferOf(iv), additionalData: bufferOf(aad) },
    key,
    bufferOf(utf8(JSON.stringify(value))),
  );
  return { iv, ct };
}

export class DecryptError extends Error {
  constructor() {
    super('Record could not be decrypted (wrong key or tampered data)');
    this.name = 'DecryptError';
  }
}

export async function open<T>(key: CryptoKey, sealed: Sealed, aad: Uint8Array): Promise<T> {
  let plain: ArrayBuffer;
  try {
    plain = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bufferOf(sealed.iv), additionalData: bufferOf(aad) },
      key,
      sealed.ct,
    );
  } catch {
    throw new DecryptError();
  }
  return JSON.parse(fromUtf8(plain)) as T;
}
