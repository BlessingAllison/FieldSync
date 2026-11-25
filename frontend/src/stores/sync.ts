import { create } from 'zustand';

import type { NetworkProfile } from '@/core/api/conditions';
import type { BreakerState } from '@/core/sync/breaker';
import type { EngineState, SyncBusEvent } from '@/core/sync/bus';
import type { OutboxState } from '@/core/sync/types';

export type Counts = Record<OutboxState, number>;

interface SyncStoreState {
  engine: EngineState;
  breaker: BreakerState;
  counts: Counts;
  stuck: number;
  lastSuccessAt: number | null;
  /** Bumped on every queue change so list screens reload. */
  revision: number;
}

export const EMPTY_COUNTS: Counts = {
  PENDING: 0,
  SYNCING: 0,
  RETRY_WAIT: 0,
  FAILED: 0,
  CONFLICT: 0,
};

export const useSync = create<SyncStoreState>(() => ({
  engine: 'IDLE',
  breaker: 'CLOSED',
  counts: EMPTY_COUNTS,
  stuck: 0,
  lastSuccessAt: null,
  revision: 0,
}));

/** Waiting to be sent (anything not yet acknowledged and not needing a person). */
export const waitingCount = (counts: Counts) => counts.PENDING + counts.SYNCING + counts.RETRY_WAIT;
export const needsActionCount = (counts: Counts) => counts.FAILED + counts.CONFLICT;

// ── Simulator ────────────────────────────────────────────────────────────────

export interface SimLogEntry {
  id: number;
  at: number;
  text: string;
  tone: 'info' | 'good' | 'warn' | 'bad';
}

interface SimState {
  profile: NetworkProfile;
  stats: {
    requests: number;
    sent: number;
    duplicatesPrevented: number;
    retries: number;
    conflicts: number;
    dropped: number;
    acksLost: number;
    serverErrors: number;
  };
  log: SimLogEntry[];
}

export const useSim = create<SimState>(() => ({
  profile: 'online',
  stats: {
    requests: 0,
    sent: 0,
    duplicatesPrevented: 0,
    retries: 0,
    conflicts: 0,
    dropped: 0,
    acksLost: 0,
    serverErrors: 0,
  },
  log: [],
}));

let logId = 0;

export function simLog(text: string, tone: SimLogEntry['tone'] = 'info'): void {
  logId += 1;
  useSim.setState((s) => ({
    log: [{ id: logId, at: Date.now(), text, tone }, ...s.log].slice(0, 80),
  }));
}

/** Fold bus events into simulator statistics (counts only; never payloads). */
export function recordSimEvent(event: SyncBusEvent): void {
  const bump = (key: keyof SimState['stats'], by = 1) =>
    useSim.setState((s) => ({ stats: { ...s.stats, [key]: s.stats[key] + by } }));
  switch (event.type) {
    case 'batch':
      bump('requests');
      simLog(
        `Batch of ${event.size} ${event.ok ? 'answered' : 'failed'} in ${Math.round(event.latencyMs)} ms`,
        event.ok ? 'info' : 'warn',
      );
      break;
    case 'item':
      if (event.outcome === 'replayed') {
        bump('duplicatesPrevented');
        simLog('Server recognised a resend — duplicate prevented', 'good');
      } else if (event.outcome === 'created' || event.outcome === 'updated') bump('sent');
      else if (event.outcome === 'retry') bump('retries');
      else if (event.outcome === 'conflict') {
        bump('conflicts');
        simLog('Conflict: the server copy changed — needs a decision', 'warn');
      }
      break;
    case 'simulated':
      if (event.kind === 'ack_lost') {
        bump('acksLost');
        simLog('Acknowledgement lost after the server saved (simulated)', 'bad');
      } else if (event.kind === 'server_error') {
        bump('serverErrors');
        simLog('Server busy: 503 + Retry-After (simulated)', 'warn');
      } else if (event.kind === 'drop' || event.kind === 'offline') {
        bump('dropped');
      }
      break;
    case 'breaker':
      simLog(
        `Connection check: ${event.state === 'CLOSED' ? 'server reachable' : event.state === 'OPEN' ? 'no connection — pausing' : 'testing connection…'}`,
        event.state === 'CLOSED' ? 'good' : 'warn',
      );
      break;
    case 'engine':
    case 'queue_changed':
    case 'drained':
    case 'auth_required':
    case 'device_revoked':
      break;
  }
}
