/**
 * Device capability probes behind the Device check screen.
 *
 * Each probe answers one question a CHW (or supervisor helping them) actually needs
 * answered before going to the field: will saved forms survive, are they encrypted,
 * will they send by themselves? Probes never throw; they return a status.
 */
import { requestJson } from '@/core/api/http';

export type ProbeStatus = 'ok' | 'warn' | 'fail';

export interface StorageInfo {
  usage: number;
  quota: number;
}

export function probeServiceWorker(): ProbeStatus {
  if (!('serviceWorker' in navigator)) return 'fail';
  // Controlled = the precached app shell is serving this page right now.
  return navigator.serviceWorker.controller ? 'ok' : 'warn';
}

export async function probeIndexedDb(): Promise<ProbeStatus> {
  if (typeof indexedDB === 'undefined') return 'fail';
  const name = 'fieldsync-probe';
  try {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('probe');
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('probe', 'readwrite');
        tx.objectStore('probe').put(Date.now(), 'k');
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error ?? new Error('probe write failed'));
      };
      request.onerror = () => reject(request.error ?? new Error('probe open failed'));
    });
    indexedDB.deleteDatabase(name);
    return 'ok';
  } catch {
    return 'fail';
  }
}

/** Round-trips AES-GCM with a non-extractable key — the exact primitive the vault uses. */
export async function probeCrypto(): Promise<ProbeStatus> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return 'fail';
    const key = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode('fieldsync');
    const sealed = await subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
    const opened = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv }, key, sealed));
    return opened.every((byte, i) => byte === plain[i]) ? 'ok' : 'fail';
  } catch {
    return 'fail';
  }
}

export async function probePersistence(): Promise<ProbeStatus> {
  if (!navigator.storage?.persisted) return 'fail';
  try {
    return (await navigator.storage.persisted()) ? 'ok' : 'warn';
  } catch {
    return 'fail';
  }
}

/** Ask the browser not to evict our storage. Chrome grants this to installed PWAs. */
export async function requestPersistence(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

/** Warn at 80% of quota (ADD §12.10). */
export const STORAGE_WARN_RATIO = 0.8;

export async function probeStorage(): Promise<{ status: ProbeStatus; info: StorageInfo | null }> {
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (!estimate?.quota) return { status: 'fail', info: null };
    const info = { usage: estimate.usage ?? 0, quota: estimate.quota };
    return { status: info.usage / info.quota >= STORAGE_WARN_RATIO ? 'warn' : 'ok', info };
  } catch {
    return { status: 'fail', info: null };
  }
}

export function probeBackgroundSync(): ProbeStatus {
  // Chromium only. Elsewhere the foreground timer strategy sends while the app is open.
  return typeof ServiceWorkerRegistration !== 'undefined' &&
    'sync' in ServiceWorkerRegistration.prototype
    ? 'ok'
    : 'warn';
}

/** Readiness, not just liveness: a server that cannot reach its database is "warn". */
export async function probeServer(): Promise<ProbeStatus> {
  const result = await requestJson<{ status: string }>('/api/v1/health/ready', {
    timeoutMs: 8_000,
  });
  if (result.ok) return 'ok';
  return result.error.kind === 'api' ? 'warn' : 'fail';
}
