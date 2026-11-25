/**
 * Retry delay (ADD §12.6): exponential from 5 s to a 15 min cap with "equal jitter"
 * (half fixed, half random — spreads load, keeps a floor), never below Retry-After.
 */
export const BASE_MS = 5_000;
export const CAP_MS = 15 * 60_000;

export function backoffDelay(
  attempt: number,
  retryAfterSeconds: number | null,
  random: () => number = Math.random,
): number {
  const n = Math.max(1, attempt);
  const ceiling = Math.min(CAP_MS, BASE_MS * 2 ** (n - 1));
  const delay = ceiling / 2 + random() * (ceiling / 2);
  return Math.round(Math.max(delay, (retryAfterSeconds ?? 0) * 1000));
}
