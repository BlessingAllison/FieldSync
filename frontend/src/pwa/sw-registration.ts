import { Workbox } from 'workbox-window';

import { whenSettled } from '@/lib/when-settled';

import { markOfflineReady, markUpdateReady, setActivator } from './update-store';

/**
 * Registers /sw.js (production builds only — the dev server has no SW, by design).
 * Update flow: new SW installs → 'waiting' → user taps "Update now" (respecting holds)
 * → SKIP_WAITING → 'controlling' → reload onto the new version.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;

  const wb = new Workbox('/sw.js', { scope: '/', type: 'classic' });

  wb.addEventListener('waiting', () => markUpdateReady());
  wb.addEventListener('installed', (event) => {
    if (!event.isUpdate) markOfflineReady();
  });
  wb.addEventListener('controlling', (event) => {
    if (event.isUpdate) window.location.reload();
  });

  setActivator(() => wb.messageSkipWaiting());

  const register = () =>
    void wb.register().then((registration) => {
      // Check for a new version when the app comes back to the foreground (sw.js is no-cache).
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void registration?.update();
      });
    });
  // After load + idle: installing precaches ~0.5 MB, which at boot competed with the login
  // page for a 2G/3G link (measured 8.9 s cold load on Slow 3G + 4x CPU). Return visits are
  // already SW-controlled; only a first visit becomes offline-capable a few seconds later.
  whenSettled(register);
}

