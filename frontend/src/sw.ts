/// <reference lib="webworker" />
/**
 * FieldSync service worker (Workbox injectManifest).
 *
 * Responsibilities:
 *  - precache the hashed app shell so the app cold-starts with no network;
 *  - serve index.html for in-app navigations (SPA routing offline);
 *  - activate only when the page asks (SKIP_WAITING) — never mid-form;
 *  - Background Sync: drain the outbox with the shared core engine, even when the app is
 *    closed, for the active user while their session handle is valid (ADD §12.7).
 *
 * Deliberately NOT done: no runtime caching of /api/*. Cache Storage is unencrypted,
 * and API responses can carry patient data (ADD §5.2, D15).
 */
import { clientsClaim } from 'workbox-core';
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

import { ApiClient } from './core/api/client';
import { type NetworkProfile, withConditions } from './core/api/conditions';
import { activeUserId, openUserDb, userDbName } from './core/db/schema';
import { Vault } from './core/repositories/vault';
import { SyncEventBus } from './core/sync/bus';
import { SyncEngine } from './core/sync/engine';
import { APP_VERSION } from './core/version';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

/** Background Sync event (not in the standard WebWorker lib). */
interface SyncEvent extends ExtendableEvent {
  readonly tag: string;
  readonly lastChance: boolean;
}

const SYNC_TAG = 'fs-outbox';

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/index.html'), {
    denylist: [/^\/api\//],
  }),
);

self.addEventListener('message', (event: ExtendableMessageEvent) => {
  const data: unknown = event.data;
  if (
    typeof data === 'object' &&
    data !== null &&
    (data as { type?: unknown }).type === 'SKIP_WAITING'
  ) {
    void self.skipWaiting();
  }
});

// First install: take control immediately so the very first visit is already offline-capable.
// Updates still wait for SKIP_WAITING (above), because a waiting worker cannot claim.
clientsClaim();

/**
 * Drain for the active user. Returns normally when nothing is left to do; throws when due
 * work remains so the browser schedules another attempt (with its own backoff).
 */
async function backgroundDrain(lastChance: boolean): Promise<void> {
  const userId = await activeUserId();
  if (!userId) return;
  const db = await openUserDb(await userDbName(userId));
  try {
    const session = await db.get('session', 'current');
    if (!session || session.expiresAt <= Date.now()) return; // locked: data stays encrypted, wait for the user
    const vault = new Vault(db, session.dek, userId);
    const profile = (await vault.getMeta<NetworkProfile>('simulatorProfile')) ?? 'online';
    const bus = new SyncEventBus('sw');
    const api = new ApiClient({
      appVersion: APP_VERSION,
      fetchImpl: withConditions(
        (input, init) => fetch(input, init),
        () => profile,
        {
          onSimulatedDrop: (kind, path) => bus.emit({ type: 'simulated', kind, path }),
        },
      ),
    });
    const engine = new SyncEngine({ vault, transport: api, bus });
    const report = await engine.drain();
    bus.close();
    if (report.state === 'PAUSED_AUTH' || report.state === 'PAUSED_REVOKED') return; // needs the user
    if (report.remainingDue > 0 || report.state === 'PAUSED_OFFLINE') {
      if (!lastChance) throw new Error('fieldsync: work remains, retry later');
    }
  } finally {
    db.close();
  }
}

self.addEventListener('sync', (event: Event) => {
  const syncEvent = event as SyncEvent;
  if (syncEvent.tag === SYNC_TAG) syncEvent.waitUntil(backgroundDrain(syncEvent.lastChance));
});
