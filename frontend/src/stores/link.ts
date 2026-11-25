/**
 * Network meter state: how well this phone can reach the FieldSync server right now.
 *
 * Inputs (see core/net/link-quality.ts):
 *  - every small API request the app already makes is timed (no extra traffic);
 *  - when the app is visible and nothing was measured for PROBE_AFTER_MS, a ~200-byte
 *    unauthenticated probe is sent (≈ 16 KB per hour in the foreground, none in the background);
 *  - the browser's Network Information estimate, where available (Chrome/Android).
 */
import { create } from 'zustand';

import { setRequestTimingObserver } from '@/core/api/http';
import {
  classifyLink,
  type LinkStatus,
  type NetInfo,
  smoothRtt,
} from '@/core/net/link-quality';

import { whenSettled } from '@/lib/when-settled';

import { useNetwork } from './network';

export const PROBE_AFTER_MS = 45_000;
const TICK_MS = 15_000;

interface LinkState {
  serverRttMs: number | null;
  lastSampleAt: number | null;
  consecutiveFailures: number;
  netInfo: NetInfo | null;
  checking: boolean;
  status: LinkStatus;
}

export const useLink = create<LinkState>(() => ({
  serverRttMs: null,
  lastSampleAt: null,
  consecutiveFailures: 0,
  netInfo: null,
  checking: false,
  status: 'checking',
}));

function recompute(): void {
  const s = useLink.getState();
  useLink.setState({
    status: classifyLink({
      online: useNetwork.getState().online,
      netInfo: s.netInfo,
      serverRttMs: s.serverRttMs,
      lastSampleAt: s.lastSampleAt,
      consecutiveFailures: s.consecutiveFailures,
      now: Date.now(),
    }),
  });
}

interface NetworkInformationLike extends EventTarget {
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
  saveData?: boolean;
}

function readNetInfo(connection: NetworkInformationLike | undefined): NetInfo | null {
  if (!connection) return null;
  return {
    ...(connection.effectiveType ? { effectiveType: connection.effectiveType } : {}),
    ...(typeof connection.downlink === 'number' ? { downlinkMbps: connection.downlink } : {}),
    ...(typeof connection.rtt === 'number' ? { rttMs: connection.rtt } : {}),
    ...(connection.saveData ? { saveData: true } : {}),
  };
}

let probeFn: (() => Promise<boolean>) | null = null;

/** Measure now (the meter's "Check now" button, and when the device comes back online). */
export async function checkLinkNow(): Promise<void> {
  if (!probeFn || useLink.getState().checking) return;
  if (!useNetwork.getState().online) {
    recompute();
    return;
  }
  useLink.setState({ checking: true });
  try {
    await probeFn(); // timed by the request observer like any other request
  } finally {
    useLink.setState({ checking: false });
    recompute();
  }
}

export function startLinkMonitor(options: {
  probe: () => Promise<boolean>;
  target?: Window;
}): () => void {
  const target = options.target ?? window;
  probeFn = options.probe;

  setRequestTimingObserver(({ ms, reached, small }) => {
    const s = useLink.getState();
    if (!reached) {
      useLink.setState({ consecutiveFailures: s.consecutiveFailures + 1 });
    } else if (small) {
      useLink.setState({
        serverRttMs: smoothRtt(s.serverRttMs, ms),
        lastSampleAt: Date.now(),
        consecutiveFailures: 0,
      });
    } else {
      useLink.setState({ consecutiveFailures: 0 });
    }
    recompute();
  });

  const connection = (target.navigator as Navigator & { connection?: NetworkInformationLike })
    .connection;
  const onConnection = () => {
    useLink.setState({ netInfo: readNetInfo(connection) });
    recompute();
  };
  connection?.addEventListener('change', onConnection);
  onConnection();

  const onOnline = () => void checkLinkNow();
  const onOffline = () => recompute();
  target.addEventListener('online', onOnline);
  target.addEventListener('offline', onOffline);
  const unsubscribeNetwork = useNetwork.subscribe(recompute);

  const tick = () => {
    const { lastSampleAt } = useLink.getState();
    const visible = target.document.visibilityState === 'visible';
    if (visible && (lastSampleAt === null || Date.now() - lastSampleAt > PROBE_AFTER_MS)) {
      void checkLinkNow();
    } else {
      recompute(); // let stale samples age out
    }
  };
  const timer = target.setInterval(tick, TICK_MS);
  whenSettled(tick); // never compete with the first paint on 2G/3G

  return () => {
    target.clearInterval(timer);
    connection?.removeEventListener('change', onConnection);
    target.removeEventListener('online', onOnline);
    target.removeEventListener('offline', onOffline);
    unsubscribeNetwork();
    setRequestTimingObserver(null);
    probeFn = null;
  };
}
