/**
 * Connection quality for the network meter (pure; no DOM).
 *
 * The truth that matters to a CHW is "can FieldSync's server be reached, and how fast", so
 * a fresh measured server round trip wins. Without one, the browser's Network Information
 * estimate (Chrome/Android: effectiveType, rtt, downlink) is used. navigator.onLine only
 * says an interface is up (captive Wi-Fi and dead cells report "online"), so it can force
 * "offline" but never "good".
 */

export type LinkStatus = 'offline' | 'no_server' | 'poor' | 'fair' | 'good' | 'excellent' | 'checking';

/** Bars shown (0–4); `checking` shows none filled. */
export const LINK_LEVEL: Record<LinkStatus, 0 | 1 | 2 | 3 | 4> = {
  offline: 0,
  no_server: 0,
  checking: 0,
  poor: 1,
  fair: 2,
  good: 3,
  excellent: 4,
};

export interface NetInfo {
  effectiveType?: string;
  downlinkMbps?: number;
  rttMs?: number;
  saveData?: boolean;
}

export interface LinkInputs {
  online: boolean;
  netInfo: NetInfo | null;
  /** Smoothed round trip to the FieldSync server (small requests only). */
  serverRttMs: number | null;
  lastSampleAt: number | null;
  /** Consecutive requests that got no answer from the server at all. */
  consecutiveFailures: number;
  now: number;
}

/** A server sample older than this no longer describes the connection. */
export const SAMPLE_FRESH_MS = 2 * 60_000;
export const FAILURES_FOR_NO_SERVER = 2;

/** Round-trip thresholds (ms) tuned for sync over mobile data: a 25-form batch is ~10 KB. */
export function statusFromRtt(rttMs: number): LinkStatus {
  if (rttMs < 300) return 'excellent';
  if (rttMs < 800) return 'good';
  if (rttMs < 2_000) return 'fair';
  return 'poor';
}

function statusFromNetInfo(info: NetInfo): LinkStatus | null {
  const type: string = info.effectiveType ?? '';
  switch (type) {
    case 'slow-2g':
    case '2g':
      return 'poor';
    case '3g':
      return 'fair';
    case '4g':
      return info.rttMs !== undefined && info.rttMs < 100 && (info.downlinkMbps ?? 0) >= 5
        ? 'excellent'
        : 'good';
    default:
      return info.rttMs !== undefined ? statusFromRtt(info.rttMs) : null;
  }
}

export function classifyLink(inputs: LinkInputs): LinkStatus {
  if (!inputs.online) return 'offline';
  if (inputs.consecutiveFailures >= FAILURES_FOR_NO_SERVER) return 'no_server';
  const fresh =
    inputs.serverRttMs !== null &&
    inputs.lastSampleAt !== null &&
    inputs.now - inputs.lastSampleAt < SAMPLE_FRESH_MS;
  if (fresh) return statusFromRtt(inputs.serverRttMs!);
  return (inputs.netInfo && statusFromNetInfo(inputs.netInfo)) ?? 'checking';
}

/** Exponentially weighted moving average; the first sample seeds it. */
export function smoothRtt(previous: number | null, sample: number, alpha = 0.3): number {
  return previous === null ? sample : Math.round(previous + alpha * (sample - previous));
}
