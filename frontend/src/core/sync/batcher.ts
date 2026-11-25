/** AIMD batch sizing (ADD §12.7): grow on fast success, halve on timeout/413. */
export const MIN_BATCH = 1;
export const START_BATCH = 10;
export const MAX_BATCH = 25;
export const FAST_MS = 3_000;

export class BatchSizer {
  size = START_BATCH;

  onSuccess(latencyMs: number): void {
    if (latencyMs < FAST_MS) this.size = Math.min(MAX_BATCH, this.size + 2);
  }

  onSlowOrTooLarge(): void {
    this.size = Math.max(MIN_BATCH, Math.floor(this.size / 2));
  }
}
