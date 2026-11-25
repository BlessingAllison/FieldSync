import { describe, expect, it } from 'vitest';

import { randomBytes } from '../util/bytes';
import { DecryptError, aadFor, open, seal } from './aead';
import { WrongPasswordError, createKeyring, rewrapWithEscrow, unlockWithPassword } from './keyring';

const FAST = 1_000; // iterations for tests; production uses PBKDF2_ITERATIONS

describe('keyring', () => {
  it('creates a non-extractable DEK that the password unlocks', async () => {
    const escrow = randomBytes(32);
    const { record, dek } = await createKeyring('correct horse', escrow, FAST);
    expect(dek.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', dek)).rejects.toThrow();
    const again = await unlockWithPassword(record, 'correct horse');
    const sealed = await seal(dek, { a: 1 }, aadFor('drafts', 'x'));
    expect(await open(again, sealed, aadFor('drafts', 'x'))).toEqual({ a: 1 });
  });

  it('rejects a wrong password', async () => {
    const { record } = await createKeyring('correct horse', randomBytes(32), FAST);
    await expect(unlockWithPassword(record, 'wrong')).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it('re-wraps under a new password via escrow without changing the DEK', async () => {
    const escrow = randomBytes(32);
    const { record, dek } = await createKeyring('old password', escrow, FAST);
    const sealed = await seal(dek, 'unsynced form', aadFor('outbox', 'u1'));
    const rewrapped = await rewrapWithEscrow(record, escrow, 'new password', FAST);
    await expect(unlockWithPassword(rewrapped.record, 'old password')).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
    const unlocked = await unlockWithPassword(rewrapped.record, 'new password');
    expect(await open(unlocked, sealed, aadFor('outbox', 'u1'))).toBe('unsynced form');
  });

  it('refuses escrow re-wrap with the wrong escrow secret', async () => {
    const { record } = await createKeyring('pw', randomBytes(32), FAST);
    await expect(rewrapWithEscrow(record, randomBytes(32), 'new', FAST)).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
  });
});

describe('aead', () => {
  it('binds ciphertext to its record via AAD', async () => {
    const { dek } = await createKeyring('pw', randomBytes(32), FAST);
    const sealed = await seal(dek, { patient: 'HH-0001-01' }, aadFor('outbox', 'a'));
    await expect(open(dek, sealed, aadFor('outbox', 'b'))).rejects.toBeInstanceOf(DecryptError);
    await expect(open(dek, sealed, aadFor('drafts', 'a'))).rejects.toBeInstanceOf(DecryptError);
  });

  it('detects tampering', async () => {
    const { dek } = await createKeyring('pw', randomBytes(32), FAST);
    const sealed = await seal(dek, 'x', aadFor('s', 'k'));
    const bytes = new Uint8Array(sealed.ct);
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    await expect(
      open(dek, { iv: sealed.iv, ct: bytes.buffer }, aadFor('s', 'k')),
    ).rejects.toBeInstanceOf(DecryptError);
  });

  it('uses a fresh IV for every encryption', async () => {
    const { dek } = await createKeyring('pw', randomBytes(32), FAST);
    const ivs = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const { iv } = await seal(dek, i, aadFor('s', 'k'));
      ivs.add(Array.from(iv).join(','));
    }
    expect(ivs.size).toBe(200);
  });
});
