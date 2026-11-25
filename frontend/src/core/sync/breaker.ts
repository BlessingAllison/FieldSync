/**
 * ConnectivityBreaker (ADD §7). `navigator.onLine` only says an interface is up; on a captive
 * portal or a dead 3G cell it lies. After 3 consecutive network-class failures the breaker
 * OPENs and no submission requests are attempted (saving battery and airtime); after a
 * cool-down (15 s doubling to 5 min) — or immediately on an `online` event — it goes
 * HALF_OPEN and a ~200-byte HEAD /health/live probe decides.
 */
export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export const FAILURE_THRESHOLD = 3;
export const COOLDOWN_BASE_MS = 15_000;
export const COOLDOWN_CAP_MS = 5 * 60_000;

export class ConnectivityBreaker {
  private failures = 0;
  private opens = 0;
  private openedAt = 0;
  state: BreakerState = 'CLOSED';
  private listeners = new Set<(state: BreakerState) => void>();

  constructor(private readonly clock: () => number = Date.now) {}

  subscribe(listener: (state: BreakerState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(state: BreakerState): void {
    if (this.state === state) return;
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }

  cooldownMs(): number {
    return Math.min(COOLDOWN_CAP_MS, COOLDOWN_BASE_MS * 2 ** Math.max(0, this.opens - 1));
  }

  /** May real requests be sent now? (HALF_OPEN requires a probe first.) */
  allowsRequests(): boolean {
    if (this.state === 'OPEN' && this.clock() - this.openedAt >= this.cooldownMs())
      this.set('HALF_OPEN');
    return this.state === 'CLOSED';
  }

  needsProbe(): boolean {
    this.allowsRequests();
    return this.state === 'HALF_OPEN';
  }

  recordSuccess(): void {
    this.failures = 0;
    this.opens = 0;
    this.set('CLOSED');
  }

  recordNetworkFailure(): void {
    this.failures += 1;
    if (this.state === 'HALF_OPEN' || this.failures >= FAILURE_THRESHOLD) {
      this.opens += 1;
      this.openedAt = this.clock();
      this.set('OPEN');
    }
  }

  /** `online` event or "Sync now": skip the remaining cool-down. */
  nudge(): void {
    if (this.state === 'OPEN') this.set('HALF_OPEN');
  }
}
