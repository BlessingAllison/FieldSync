/**
 * Sync scheduling strategies (Strategy pattern, ADD §12.7). Page-side; the SW has its own
 * trigger (the `sync` event). Strategies compose: on Chromium both Background Sync and the
 * foreground timer are active; on Safari/Firefox only the timer.
 */
import type { SyncEngine } from '@/core/sync/engine';

export const BACKGROUND_SYNC_TAG = 'fs-outbox';
export const FOREGROUND_INTERVAL_MS = 30_000;
const MAX_WAKE_MS = 15 * 60_000;

interface SyncManagerLike {
  register(tag: string): Promise<void>;
}

/** Ask the browser to wake the SW when connectivity returns, even if the app is closed. */
export async function registerBackgroundSync(): Promise<boolean> {
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    const sync = (
      registration as (ServiceWorkerRegistration & { sync?: SyncManagerLike }) | undefined
    )?.sync;
    if (!sync) return false;
    await sync.register(BACKGROUND_SYNC_TAG);
    return true;
  } catch {
    return false;
  }
}

export class SyncScheduler {
  private interval: ReturnType<typeof setInterval> | null = null;
  private wake: ReturnType<typeof setTimeout> | null = null;
  private readonly cleanup: Array<() => void> = [];

  constructor(private readonly engine: SyncEngine) {}

  start(): void {
    const onOnline = () => {
      this.engine.breaker.nudge();
      void this.drainNow();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void this.drainNow();
    };
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
    this.cleanup.push(
      () => window.removeEventListener('online', onOnline),
      () => document.removeEventListener('visibilitychange', onVisible),
    );
    this.interval = setInterval(() => {
      if (document.visibilityState === 'visible') void this.drainNow();
    }, FOREGROUND_INTERVAL_MS);
    void this.drainNow();
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    if (this.wake) clearTimeout(this.wake);
    this.cleanup.splice(0).forEach((fn) => fn());
  }

  /** After a save: register Background Sync and try right away. */
  requestSync(): void {
    void registerBackgroundSync();
    void this.drainNow();
  }

  /** "Sync now": skip the breaker cool-down and drain. */
  syncNow(): Promise<void> {
    this.engine.breaker.nudge();
    return this.drainNow();
  }

  async drainNow(): Promise<void> {
    const report = await this.engine.drain();
    if (this.wake) clearTimeout(this.wake);
    if (report.nextDueAt !== null) {
      const delay = Math.min(MAX_WAKE_MS, Math.max(1_000, report.nextDueAt - Date.now()));
      this.wake = setTimeout(() => void this.drainNow(), delay);
    }
    if (report.remainingDue > 0 || report.state === 'PAUSED_OFFLINE') void registerBackgroundSync();
  }
}
