import { describe, expect, it } from 'vitest';

import type { Sealed } from '../crypto/aead';
import { BatchSizer, MAX_BATCH } from './batcher';
import { BASE_MS, CAP_MS, backoffDelay } from './backoff';
import { ConnectivityBreaker } from './breaker';
import { IllegalTransitionError, LEASE_MS, type OutboxEvent, transition } from './states';
import type { OutboxItem, OutboxState } from './types';

const S: Sealed = { iv: new Uint8Array(12), ct: new ArrayBuffer(0) };
const err = { errorClass: 'network' as const, code: 'network', http: null, requestId: null, at: 0 };

function item(state: OutboxState, patch: Partial<OutboxItem> = {}): OutboxItem {
  return {
    clientUuid: 'u',
    op: 'create',
    templateCode: 't',
    templateVersion: 1,
    facilityId: 'f',
    state,
    attempts: 0,
    nextAttemptAt: 0,
    leaseUntil: state === 'SYNCING' ? 1 : null,
    baseVersion: null,
    resolution: 'none',
    dirtyAfterSync: false,
    serverId: null,
    serverVersion: null,
    lastError: null,
    capturedAt: 0,
    createdAt: 0,
    updatedAt: 0,
    enc: S,
    encSummary: S,
    conflict: null,
    base: null,
    ...patch,
  };
}

const EVENTS: OutboxEvent[] = [
  { type: 'claim', now: 1 },
  { type: 'ack', now: 1, serverId: 's', serverVersion: 1 },
  { type: 'conflict', now: 1, serverVersion: 2, serverCopy: S },
  { type: 'permanent', now: 1, error: err },
  { type: 'transient', now: 1, error: err, delayMs: 5, countsAsAttempt: true },
  { type: 'auth_paused', now: 1 },
  { type: 'edit', now: 1, enc: S, encSummary: S },
  { type: 'lease_expired', now: 1 },
  { type: 'manual_retry', now: 1 },
  { type: 'connectivity_restored', now: 1, staggerMs: 0 },
  { type: 'resolve', now: 1, resolution: 'merge', baseVersion: 2, enc: S, encSummary: S },
  { type: 'accept_server', now: 1 },
  { type: 'fix', now: 1, enc: S, encSummary: S },
  { type: 'discard', now: 1 },
];

// The complete legal table (ADD §12.2). Everything else must throw.
const LEGAL: Record<OutboxState, OutboxEvent['type'][]> = {
  PENDING: ['claim', 'edit', 'manual_retry'],
  SYNCING: ['ack', 'conflict', 'permanent', 'transient', 'auth_paused', 'edit', 'lease_expired'],
  RETRY_WAIT: ['claim', 'edit', 'manual_retry', 'connectivity_restored'],
  FAILED: ['fix', 'discard'],
  CONFLICT: ['resolve', 'accept_server', 'discard'],
};

describe('outbox transition table', () => {
  for (const state of Object.keys(LEGAL) as OutboxState[]) {
    for (const event of EVENTS) {
      const legal = LEGAL[state].includes(event.type);
      it(`${state} --${event.type}--> ${legal ? 'allowed' : 'illegal'}`, () => {
        const run = () => transition(item(state), event);
        if (legal) expect(run).not.toThrow();
        else expect(run).toThrow(IllegalTransitionError);
      });
    }
  }

  it('claim takes a lease', () => {
    const result = transition(item('PENDING'), { type: 'claim', now: 100 });
    expect(result).toMatchObject({
      kind: 'update',
      item: { state: 'SYNCING', leaseUntil: 100 + LEASE_MS },
    });
  });

  it('edit during sync is re-queued as an update after the ack', () => {
    const edited = transition(item('SYNCING'), { type: 'edit', now: 5, enc: S, encSummary: S });
    if (edited.kind !== 'update') throw new Error();
    expect(edited.item.dirtyAfterSync).toBe(true);
    const acked = transition(edited.item, {
      type: 'ack',
      now: 6,
      serverId: 'srv',
      serverVersion: 1,
    });
    expect(acked).toMatchObject({
      kind: 'synced',
      requeue: {
        state: 'PENDING',
        op: 'update',
        baseVersion: 1,
        attempts: 0,
        dirtyAfterSync: false,
      },
    });
  });

  it('auth pause and lease expiry never count as attempts', () => {
    for (const type of ['auth_paused', 'lease_expired'] as const) {
      const result = transition(item('SYNCING', { attempts: 3 }), { type, now: 1 });
      expect(result).toMatchObject({ item: { state: 'PENDING', attempts: 3 } });
    }
  });

  it('connectivity restored only fast-tracks network failures', () => {
    const network = transition(item('RETRY_WAIT', { lastError: err, nextAttemptAt: 999 }), {
      type: 'connectivity_restored',
      now: 10,
      staggerMs: 2,
    });
    expect(network).toMatchObject({ item: { state: 'PENDING', nextAttemptAt: 12 } });
    const serverBusy = item('RETRY_WAIT', {
      lastError: { ...err, errorClass: 'transient', code: 'unavailable' },
      nextAttemptAt: 999,
    });
    expect(
      transition(serverBusy, { type: 'connectivity_restored', now: 10, staggerMs: 0 }),
    ).toMatchObject({
      item: { state: 'RETRY_WAIT', nextAttemptAt: 999 },
    });
  });
});

describe('backoff', () => {
  it('grows exponentially with equal jitter and caps at 15 minutes', () => {
    expect(backoffDelay(1, null, () => 0)).toBe(BASE_MS / 2);
    expect(backoffDelay(1, null, () => 1)).toBe(BASE_MS);
    expect(backoffDelay(3, null, () => 0)).toBe(10_000);
    expect(backoffDelay(30, null, () => 1)).toBe(CAP_MS);
    expect(backoffDelay(30, null, () => 0)).toBe(CAP_MS / 2);
  });

  it('never retries sooner than Retry-After', () => {
    expect(backoffDelay(1, 120, () => 0)).toBe(120_000);
  });
});

describe('ConnectivityBreaker', () => {
  it('opens after 3 failures, cools down, probes, and closes', () => {
    let now = 0;
    const breaker = new ConnectivityBreaker(() => now);
    breaker.recordNetworkFailure();
    breaker.recordNetworkFailure();
    expect(breaker.allowsRequests()).toBe(true);
    breaker.recordNetworkFailure();
    expect(breaker.state).toBe('OPEN');
    expect(breaker.allowsRequests()).toBe(false);
    now += 15_000;
    expect(breaker.needsProbe()).toBe(true);
    breaker.recordNetworkFailure(); // failed probe → open again, longer cool-down
    expect(breaker.state).toBe('OPEN');
    expect(breaker.cooldownMs()).toBe(30_000);
    breaker.nudge(); // online event
    expect(breaker.needsProbe()).toBe(true);
    breaker.recordSuccess();
    expect(breaker.allowsRequests()).toBe(true);
  });
});

describe('BatchSizer', () => {
  it('additive increase, multiplicative decrease', () => {
    const sizer = new BatchSizer();
    for (let i = 0; i < 20; i += 1) sizer.onSuccess(500);
    expect(sizer.size).toBe(MAX_BATCH);
    sizer.onSlowOrTooLarge();
    expect(sizer.size).toBe(12);
    sizer.onSuccess(10_000);
    expect(sizer.size).toBe(12);
  });
});
