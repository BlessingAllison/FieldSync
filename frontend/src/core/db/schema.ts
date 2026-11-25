/**
 * IndexedDB layout (ADD §9). One database per user per browser profile, plus a tiny
 * bootstrap database that only knows which users exist on this device.
 * Migrations are forward-only and run in `upgrade`.
 */
import { type DBSchema, type IDBPDatabase, openDB } from 'idb';

import type { Sealed } from '../crypto/aead';
import type { KeyringRecord } from '../crypto/keyring';
import type { OutboxItem } from '../sync/types';
import { sha256Hex } from '../util/bytes';

export const USER_DB_VERSION = 1;

export interface SessionRecord {
  /** Non-extractable AES-GCM DEK handle; usable by page and SW until expiresAt. */
  dek: CryptoKey;
  userId: string;
  unlockedAt: number;
  expiresAt: number;
  /** AES-GCM(profile) — cached for offline sign-in. */
  profile: Sealed;
  pin: { salt: Uint8Array; hash: string; iterations: number; failures: number } | null;
}

export interface DraftRecord {
  clientUuid: string;
  templateCode: string;
  templateVersion: number;
  facilityId: string;
  createdAt: number;
  updatedAt: number;
  /** For edits of synced submissions: the server version being edited. */
  baseVersion: number | null;
  /** AES-GCM({values, step}) */
  enc: Sealed;
}

export type ReceiptStatus = 'queued' | 'synced' | 'discarded';

export interface ReceiptRecord {
  clientUuid: string;
  templateCode: string;
  templateVersion: number;
  facilityId: string;
  capturedAt: number;
  createdAt: number;
  status: ReceiptStatus;
  serverId: string | null;
  serverVersion: number | null;
  serverStatus: string | null;
  syncedAt: number | null;
  /** AES-GCM({patientLabel}) */
  encSummary: Sealed;
}

export interface TemplateRecord {
  code: string;
  version: number;
  id: string;
  subject: 'patient' | 'facility';
  status: string;
  acceptUntil: string | null;
  definition: unknown;
  definitionHash: string;
}

export interface FacilityRecord {
  id: string;
  code: string;
  name: string;
  countyCode: string;
  countyName: string;
  district: string;
  facilityType: string;
}

export interface SyncLogEntry {
  id?: number;
  at: number;
  kind: string;
  clientUuid?: string;
  code?: string;
  requestId?: string | null;
  detail?: Record<string, string | number | boolean | null>;
}

export interface DashboardCacheRecord {
  scope: string;
  asOf: number;
  data: unknown;
}

export interface FieldSyncDB extends DBSchema {
  meta: { key: string; value: unknown };
  keyring: { key: string; value: KeyringRecord };
  session: { key: string; value: SessionRecord };
  templates: { key: [string, number]; value: TemplateRecord; indexes: { code: string } };
  facilities: { key: string; value: FacilityRecord };
  drafts: { key: string; value: DraftRecord; indexes: { updatedAt: number } };
  outbox: {
    key: string;
    value: OutboxItem;
    indexes: { stateNext: [string, number]; createdAt: number; facilityId: string };
  };
  receipts: { key: string; value: ReceiptRecord; indexes: { createdAt: number } };
  sync_log: { key: number; value: SyncLogEntry; indexes: { at: number } };
  dashboard_cache: { key: string; value: DashboardCacheRecord };
}

export type UserDB = IDBPDatabase<FieldSyncDB>;

export async function userDbName(userId: string): Promise<string> {
  return `fieldsync-u-${(await sha256Hex(userId)).slice(0, 16)}`;
}

export function openUserDb(name: string): Promise<UserDB> {
  return openDB<FieldSyncDB>(name, USER_DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        db.createObjectStore('meta');
        db.createObjectStore('keyring');
        db.createObjectStore('session');
        db.createObjectStore('templates', { keyPath: ['code', 'version'] }).createIndex(
          'code',
          'code',
        );
        db.createObjectStore('facilities', { keyPath: 'id' });
        db.createObjectStore('drafts', { keyPath: 'clientUuid' }).createIndex(
          'updatedAt',
          'updatedAt',
        );
        const outbox = db.createObjectStore('outbox', { keyPath: 'clientUuid' });
        outbox.createIndex('stateNext', ['state', 'nextAttemptAt']);
        outbox.createIndex('createdAt', 'createdAt');
        outbox.createIndex('facilityId', 'facilityId');
        db.createObjectStore('receipts', { keyPath: 'clientUuid' }).createIndex(
          'createdAt',
          'createdAt',
        );
        db.createObjectStore('sync_log', { keyPath: 'id', autoIncrement: true }).createIndex(
          'at',
          'at',
        );
        db.createObjectStore('dashboard_cache', { keyPath: 'scope' });
      }
    },
  });
}

// ── Bootstrap database (no PHI: which accounts exist on this device) ─────────

export interface KnownUser {
  userId: string;
  username: string;
  displayName: string;
  dbName: string;
  lastActiveAt: number;
}

interface BootDB extends DBSchema {
  users: { key: string; value: KnownUser; indexes: { username: string } };
  state: { key: string; value: string };
}

export const BOOT_DB = 'fieldsync-boot';

export function openBootDb(): Promise<IDBPDatabase<BootDB>> {
  return openDB<BootDB>(BOOT_DB, 1, {
    upgrade(db) {
      db.createObjectStore('users', { keyPath: 'userId' }).createIndex('username', 'username', {
        unique: true,
      });
      db.createObjectStore('state');
    },
  });
}

export async function knownUsers(): Promise<KnownUser[]> {
  const db = await openBootDb();
  try {
    return (await db.getAll('users')).sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  } finally {
    db.close();
  }
}

export async function rememberUser(user: KnownUser): Promise<void> {
  const db = await openBootDb();
  try {
    const tx = db.transaction(['users', 'state'], 'readwrite');
    const existing = await tx.objectStore('users').index('username').get(user.username);
    if (existing && existing.userId !== user.userId)
      await tx.objectStore('users').delete(existing.userId);
    await tx.objectStore('users').put(user);
    await tx.objectStore('state').put(user.userId, 'active');
    await tx.done;
  } finally {
    db.close();
  }
}

export async function activeUserId(): Promise<string | null> {
  const db = await openBootDb();
  try {
    return (await db.get('state', 'active')) ?? null;
  } finally {
    db.close();
  }
}

export async function setActiveUser(userId: string | null): Promise<void> {
  const db = await openBootDb();
  try {
    if (userId) await db.put('state', userId, 'active');
    else await db.delete('state', 'active');
  } finally {
    db.close();
  }
}

export async function forgetUser(userId: string): Promise<void> {
  const db = await openBootDb();
  try {
    const tx = db.transaction(['users', 'state'], 'readwrite');
    await tx.objectStore('users').delete(userId);
    if ((await tx.objectStore('state').get('active')) === userId)
      await tx.objectStore('state').delete('active');
    await tx.done;
  } finally {
    db.close();
  }
}

// ── Device preferences (no PHI; readable before sign-in so the login screen honours them) ──

export type ThemePreference = 'system' | 'light' | 'dark' | 'outdoor';

export interface Preferences {
  theme: ThemePreference;
  locale: 'en' | 'kpe';
}

export const DEFAULT_PREFERENCES: Preferences = { theme: 'system', locale: 'en' };

export async function readPreferences(): Promise<Preferences> {
  const db = await openBootDb();
  try {
    const [theme, locale] = await Promise.all([
      db.get('state', 'pref:theme'),
      db.get('state', 'pref:locale'),
    ]);
    return {
      theme:
        (['system', 'light', 'dark', 'outdoor'] as const).find((t) => t === theme) ??
        DEFAULT_PREFERENCES.theme,
      locale: locale === 'kpe' ? 'kpe' : 'en',
    };
  } finally {
    db.close();
  }
}

export async function writePreference<K extends keyof Preferences>(
  key: K,
  value: Preferences[K],
): Promise<void> {
  const db = await openBootDb();
  try {
    await db.put('state', value, `pref:${key}`);
  } finally {
    db.close();
  }
}
