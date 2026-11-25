/**
 * SessionService — sign-in, offline unlock, idle/explicit lock, PIN, erase (ADD §11.2, §11.4).
 *
 * Crypto boundary = password: it derives the KEK that unwraps the DEK. A successful unlock
 * stores a non-extractable DEK handle in the `session` store for ≤ 12 h so the service
 * worker can sync while the app is closed; lock/expiry deletes it.
 *
 * UI boundary = optional 6-digit PIN: re-opens the UI after an idle lock while the session
 * handle is still valid. It is a shoulder-surfing control, not a cryptographic one;
 * 5 wrong PINs drop the session handle (password required).
 */
import type { ApiClient, UserProfile } from '../api/client';
import type { ApiFailure } from '../api/http';
import type { open } from '../crypto/aead';
import { aadFor, seal } from '../crypto/aead';
import {
  PBKDF2_ITERATIONS,
  WrongPasswordError,
  createKeyring,
  rewrapWithEscrow,
  unlockWithPassword,
} from '../crypto/keyring';
import {
  type KnownUser,
  type SessionRecord,
  type UserDB,
  activeUserId,
  forgetUser,
  knownUsers,
  openUserDb,
  rememberUser,
  setActiveUser,
  userDbName,
} from '../db/schema';
import { uuidv7 } from '../ids/uuidv7';
import { Vault } from '../repositories/vault';
import { bufferOf, fromBase64Url, randomBytes, utf8 } from '../util/bytes';
import { APP_VERSION } from '../version';

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const MAX_PIN_FAILURES = 5;
export const PIN_ITERATIONS = 100_000;
/** Offline password attempts: free for 5, then exponential delay (ADD §11.4.5). */
export const FREE_UNLOCK_ATTEMPTS = 5;

export type SignInError =
  | { kind: 'invalid_credentials' }
  | { kind: 'account_locked'; retryAfterSeconds: number | null }
  | { kind: 'device_revoked' }
  | { kind: 'offline_unknown_user' }
  | { kind: 'wrong_password' }
  | { kind: 'too_many_attempts'; retryAfterSeconds: number }
  | { kind: 'server'; code: string }
  | { kind: 'storage_full' };

export type SignInResult =
  | { ok: true; vault: Vault; profile: UserProfile; online: boolean }
  | { ok: false; error: SignInError };

export interface SessionOptions {
  api: ApiClient;
  deviceLabel: () => string;
  clock?: () => number;
  pbkdf2Iterations?: number;
  pinIterations?: number;
  sessionTtlMs?: number;
}

const PROFILE_KEY = 'profile';

async function hashPin(pin: string, salt: Uint8Array, iterations: number): Promise<string> {
  const material = await crypto.subtle.importKey('raw', bufferOf(utf8(pin)), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: bufferOf(salt), iterations },
    material,
    256,
  );
  return Array.from(new Uint8Array(bits), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string comparison. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export class SessionService {
  private readonly clock: () => number;
  private readonly iterations: number;

  constructor(private readonly options: SessionOptions) {
    this.clock = options.clock ?? Date.now;
    this.iterations = options.pbkdf2Iterations ?? PBKDF2_ITERATIONS;
  }

  knownUsers(): Promise<KnownUser[]> {
    return knownUsers();
  }

  /** App start: resume the active user's session if its handle is still valid. */
  async restore(): Promise<
    | { status: 'unlocked'; vault: Vault; profile: UserProfile }
    | { status: 'locked'; user: KnownUser }
    | { status: 'signed_out' }
  > {
    const userId = await activeUserId();
    if (!userId) return { status: 'signed_out' };
    const user = (await knownUsers()).find((u) => u.userId === userId);
    if (!user) return { status: 'signed_out' };
    const db = await openUserDb(user.dbName);
    const session = await db.get('session', 'current');
    if (!session || session.expiresAt <= this.clock()) {
      if (session) await db.delete('session', 'current');
      db.close();
      return { status: 'locked', user };
    }
    const vault = new Vault(db, session.dek, userId);
    const profile = await this.readProfile(vault);
    if (!profile) {
      db.close();
      return { status: 'locked', user };
    }
    return { status: 'unlocked', vault, profile };
  }

  /** Online sign-in (falls back to offline unlock for a known user when the network fails). */
  async signIn(username: string, password: string): Promise<SignInResult> {
    const normalized = username.trim().toLowerCase();
    const known = (await knownUsers()).find((u) => u.username === normalized) ?? null;
    let deviceId = uuidv7();
    if (known) {
      const db = await openUserDb(known.dbName);
      deviceId = ((await db.get('meta', 'deviceId')) as string | undefined) ?? deviceId;
      db.close();
    }
    const result = await this.options.api.login(normalized, password, {
      id: deviceId,
      label: this.options.deviceLabel(),
      app_version: APP_VERSION,
    });
    if (!result.ok) {
      if (result.error.kind !== 'api') {
        return known
          ? this.unlockOffline(normalized, password)
          : { ok: false, error: { kind: 'offline_unknown_user' } };
      }
      return { ok: false, error: this.mapLoginError(result.error) };
    }

    const { user, device } = result.data;
    const userId = String(user.id);
    const escrow = fromBase64Url(device.escrow_secret);
    const dbName = await userDbName(userId);
    const db = await openUserDb(dbName);
    try {
      const existing = await db.get('keyring', 'dek');
      let dek: CryptoKey;
      if (!existing) {
        const created = await createKeyring(password, escrow, this.iterations);
        await db.put('keyring', created.record, 'dek');
        dek = created.dek;
      } else {
        try {
          dek = await unlockWithPassword(existing, password);
        } catch (error) {
          if (!(error instanceof WrongPasswordError)) throw error;
          // Password was reset by a supervisor: recover the DEK via escrow, re-wrap (ADD §11.4.3).
          const rewrapped = await rewrapWithEscrow(existing, escrow, password, this.iterations);
          await db.put('keyring', rewrapped.record, 'dek');
          dek = rewrapped.dek;
        }
      }
      await db.put('meta', String(device.id), 'deviceId');
      await db.put('meta', 0, 'unlockFailures');
      const vault = new Vault(db, dek, userId);
      await this.writeSession(vault, dek, user);
      await rememberUser({
        userId,
        username: user.username,
        displayName: user.display_name,
        dbName,
        lastActiveAt: this.clock(),
      });
      return { ok: true, vault, profile: user, online: true };
    } catch (error) {
      db.close();
      if ((error as { name?: string }).name === 'QuotaExceededError')
        return { ok: false, error: { kind: 'storage_full' } };
      throw error;
    }
  }

  /** Offline unlock with the password (rate-limited locally). */
  async unlockOffline(username: string, password: string): Promise<SignInResult> {
    const known = (await knownUsers()).find((u) => u.username === username.trim().toLowerCase());
    if (!known) return { ok: false, error: { kind: 'offline_unknown_user' } };
    const db = await openUserDb(known.dbName);
    const keyring = await db.get('keyring', 'dek');
    if (!keyring) {
      db.close();
      return { ok: false, error: { kind: 'offline_unknown_user' } };
    }
    const blockedUntil = ((await db.get('meta', 'unlockBlockedUntil')) as number | undefined) ?? 0;
    if (blockedUntil > this.clock()) {
      db.close();
      return {
        ok: false,
        error: {
          kind: 'too_many_attempts',
          retryAfterSeconds: Math.ceil((blockedUntil - this.clock()) / 1000),
        },
      };
    }
    try {
      const dek = await unlockWithPassword(keyring, password);
      await db.put('meta', 0, 'unlockFailures');
      const vault = new Vault(db, dek, known.userId);
      const profile = await this.readProfile(vault);
      if (!profile) {
        db.close();
        return { ok: false, error: { kind: 'offline_unknown_user' } };
      }
      await this.writeSession(vault, dek, profile);
      await rememberUser({ ...known, lastActiveAt: this.clock() });
      return { ok: true, vault, profile, online: false };
    } catch (error) {
      if (!(error instanceof WrongPasswordError)) {
        db.close();
        throw error;
      }
      const failures = (((await db.get('meta', 'unlockFailures')) as number | undefined) ?? 0) + 1;
      await db.put('meta', failures, 'unlockFailures');
      if (failures >= FREE_UNLOCK_ATTEMPTS) {
        const delay = 30_000 * 2 ** (failures - FREE_UNLOCK_ATTEMPTS);
        await db.put('meta', this.clock() + delay, 'unlockBlockedUntil');
      }
      db.close();
      return { ok: false, error: { kind: 'wrong_password' } };
    }
  }

  private mapLoginError(error: ApiFailure): SignInError {
    if (error.kind !== 'api') return { kind: 'server', code: error.kind };
    if (error.code === 'invalid_credentials') return { kind: 'invalid_credentials' };
    if (error.code === 'account_locked')
      return { kind: 'account_locked', retryAfterSeconds: error.retryAfterSeconds };
    if (error.code === 'device_revoked') return { kind: 'device_revoked' };
    return { kind: 'server', code: error.code };
  }

  private async writeSession(vault: Vault, dek: CryptoKey, profile: UserProfile): Promise<void> {
    const sealedProfile = await seal(dek, profile, aadFor('meta', PROFILE_KEY));
    await vault.setMeta(PROFILE_KEY, sealedProfile);
    const previous = await vault.db.get('session', 'current');
    const now = this.clock();
    const record: SessionRecord = {
      dek,
      userId: vault.userId,
      unlockedAt: now,
      expiresAt: now + (this.options.sessionTtlMs ?? SESSION_TTL_MS),
      profile: sealedProfile,
      pin: previous?.pin
        ? { ...previous.pin, failures: 0 }
        : ((await vault.getMeta<SessionRecord['pin']>('pin')) ?? null),
    };
    await vault.db.put('session', record, 'current');
  }

  async readProfile(vault: Vault): Promise<UserProfile | null> {
    const sealed = await vault.getMeta<Parameters<typeof open>[1]>(PROFILE_KEY);
    return sealed ? vault.open<UserProfile>('meta', PROFILE_KEY, sealed) : null;
  }

  async updateProfile(vault: Vault, profile: UserProfile): Promise<void> {
    await vault.setMeta(PROFILE_KEY, await vault.seal('meta', PROFILE_KEY, profile));
  }

  // ── PIN (UI quick-unlock) ────────────────────────────────────────────────────
  async setPin(vault: Vault, pin: string): Promise<void> {
    if (!/^\d{6}$/.test(pin)) throw new Error('PIN must be 6 digits');
    const salt = randomBytes(16);
    const iterations = this.options.pinIterations ?? PIN_ITERATIONS;
    const pinRecord = { salt, hash: await hashPin(pin, salt, iterations), iterations, failures: 0 };
    await vault.setMeta('pin', pinRecord);
    const session = await vault.db.get('session', 'current');
    if (session) await vault.db.put('session', { ...session, pin: pinRecord }, 'current');
  }

  async clearPin(vault: Vault): Promise<void> {
    await vault.db.delete('meta', 'pin');
    const session = await vault.db.get('session', 'current');
    if (session) await vault.db.put('session', { ...session, pin: null }, 'current');
  }

  async hasPin(vault: Vault): Promise<boolean> {
    return Boolean(await vault.getMeta('pin'));
  }

  /** 'ok' | 'wrong' | 'locked_out' (session handle dropped: password required). */
  async verifyPin(vault: Vault, pin: string): Promise<'ok' | 'wrong' | 'locked_out'> {
    const session = await vault.db.get('session', 'current');
    if (!session?.pin || session.expiresAt <= this.clock()) return 'locked_out';
    const candidate = await hashPin(pin, session.pin.salt, session.pin.iterations);
    if (safeEqual(candidate, session.pin.hash)) {
      await vault.db.put(
        'session',
        { ...session, pin: { ...session.pin, failures: 0 } },
        'current',
      );
      return 'ok';
    }
    const failures = session.pin.failures + 1;
    if (failures >= MAX_PIN_FAILURES) {
      await vault.db.delete('session', 'current');
      return 'locked_out';
    }
    await vault.db.put('session', { ...session, pin: { ...session.pin, failures } }, 'current');
    return 'wrong';
  }

  // ── Lock / switch / erase ────────────────────────────────────────────────────
  /** Drop the session handle: data stays encrypted, the password is needed again. */
  async lock(vault: Vault): Promise<void> {
    await vault.db.delete('session', 'current');
    this.options.api.clearAccess();
    vault.close();
  }

  async switchUser(vault: Vault): Promise<void> {
    await this.lock(vault);
    await setActiveUser(null);
  }

  /**
   * Crypto-shred, then delete (ADD §11.7): removing the keyring and session first makes every
   * ciphertext unrecoverable even if deleting the database is interrupted.
   */
  async eraseUser(userId: string, vault: Vault | null): Promise<void> {
    const dbName = await userDbName(userId);
    let db: UserDB | null = vault?.db ?? null;
    if (!db) db = await openUserDb(dbName);
    await db.delete('keyring', 'dek');
    await db.delete('session', 'current');
    db.close();
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(dbName);
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    });
    await forgetUser(userId);
  }

  async signOutAndErase(vault: Vault): Promise<void> {
    await this.options.api.logout().catch(() => undefined);
    await this.eraseUser(vault.userId, vault);
  }
}
