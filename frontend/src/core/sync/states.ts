/**
 * Outbox state machine (ADD §12.2). Pure: (item, event) → result. Anything not in the
 * table throws IllegalTransitionError — sync bugs are almost always illegal transitions,
 * so they are made unrepresentable rather than debugged in the field.
 */
import type { Sealed } from '../crypto/aead';
import type { LastError, OutboxItem, OutboxState } from './types';

export const LEASE_MS = 60_000;

export type OutboxEvent =
  | { type: 'claim'; now: number }
  | { type: 'ack'; now: number; serverId: string; serverVersion: number }
  | { type: 'conflict'; now: number; serverVersion: number; serverCopy: Sealed }
  | { type: 'permanent'; now: number; error: LastError }
  | { type: 'transient'; now: number; error: LastError; delayMs: number; countsAsAttempt: boolean }
  | { type: 'auth_paused'; now: number }
  | { type: 'edit'; now: number; enc: Sealed; encSummary: Sealed }
  | { type: 'lease_expired'; now: number }
  | { type: 'manual_retry'; now: number }
  | { type: 'connectivity_restored'; now: number; staggerMs: number }
  | {
      type: 'resolve';
      now: number;
      resolution: 'override' | 'merge';
      baseVersion: number;
      enc: Sealed;
      encSummary: Sealed;
    }
  | { type: 'accept_server'; now: number }
  | { type: 'fix'; now: number; enc: Sealed; encSummary: Sealed }
  | { type: 'discard'; now: number };

export type TransitionResult =
  | { kind: 'update'; item: OutboxItem }
  /** Acknowledged: remove from outbox, record the receipt. `requeue` = edited during sync. */
  | { kind: 'synced'; serverId: string; serverVersion: number; requeue: OutboxItem | null }
  | { kind: 'remove' };

export class IllegalTransitionError extends Error {
  constructor(state: OutboxState, event: OutboxEvent['type']) {
    super(`Illegal outbox transition: ${state} --${event}-->`);
    this.name = 'IllegalTransitionError';
  }
}

const update = (item: OutboxItem, patch: Partial<OutboxItem>, now: number): TransitionResult => ({
  kind: 'update',
  item: { ...item, ...patch, updatedAt: now },
});

export function transition(item: OutboxItem, event: OutboxEvent): TransitionResult {
  const illegal = () => new IllegalTransitionError(item.state, event.type);
  switch (event.type) {
    case 'claim':
      if (item.state !== 'PENDING' && item.state !== 'RETRY_WAIT') throw illegal();
      return update(item, { state: 'SYNCING', leaseUntil: event.now + LEASE_MS }, event.now);

    case 'ack': {
      if (item.state !== 'SYNCING') throw illegal();
      const requeue: OutboxItem | null = item.dirtyAfterSync
        ? {
            ...item,
            op: 'update',
            state: 'PENDING',
            attempts: 0,
            nextAttemptAt: 0,
            leaseUntil: null,
            baseVersion: event.serverVersion,
            resolution: 'none',
            dirtyAfterSync: false,
            serverId: event.serverId,
            serverVersion: event.serverVersion,
            lastError: null,
            updatedAt: event.now,
          }
        : null;
      return {
        kind: 'synced',
        serverId: event.serverId,
        serverVersion: event.serverVersion,
        requeue,
      };
    }

    case 'conflict':
      if (item.state !== 'SYNCING') throw illegal();
      return update(
        item,
        {
          state: 'CONFLICT',
          leaseUntil: null,
          conflict: event.serverCopy,
          serverVersion: event.serverVersion,
          dirtyAfterSync: false,
          lastError: {
            errorClass: 'conflict',
            code: 'conflict_version',
            http: 409,
            requestId: null,
            at: event.now,
          },
        },
        event.now,
      );

    case 'permanent':
      if (item.state !== 'SYNCING') throw illegal();
      return update(
        item,
        { state: 'FAILED', leaseUntil: null, lastError: event.error, dirtyAfterSync: false },
        event.now,
      );

    case 'transient':
      if (item.state !== 'SYNCING') throw illegal();
      return update(
        item,
        {
          state: 'RETRY_WAIT',
          leaseUntil: null,
          attempts: item.attempts + (event.countsAsAttempt ? 1 : 0),
          nextAttemptAt: event.now + event.delayMs,
          lastError: event.error,
        },
        event.now,
      );

    case 'auth_paused':
    case 'lease_expired':
      // Not the item's fault: back in line, attempt count untouched.
      if (item.state !== 'SYNCING') throw illegal();
      return update(item, { state: 'PENDING', leaseUntil: null, nextAttemptAt: 0 }, event.now);

    case 'edit':
      if (item.state === 'PENDING' || item.state === 'RETRY_WAIT') {
        return update(item, { enc: event.enc, encSummary: event.encSummary }, event.now);
      }
      if (item.state === 'SYNCING') {
        // The in-flight request carries the old payload; send the new one right after the ack.
        return update(
          item,
          { enc: event.enc, encSummary: event.encSummary, dirtyAfterSync: true },
          event.now,
        );
      }
      throw illegal();

    case 'manual_retry':
      if (item.state !== 'RETRY_WAIT' && item.state !== 'PENDING') throw illegal();
      return update(item, { state: 'PENDING', nextAttemptAt: 0 }, event.now);

    case 'connectivity_restored':
      // Only items that failed because the network was down become due immediately;
      // items waiting on a 429/5xx keep the server-requested backoff.
      if (item.state !== 'RETRY_WAIT') throw illegal();
      if (item.lastError?.errorClass !== 'network') return { kind: 'update', item };
      return update(
        item,
        { state: 'PENDING', nextAttemptAt: event.now + event.staggerMs },
        event.now,
      );

    case 'resolve':
      if (item.state !== 'CONFLICT') throw illegal();
      return update(
        item,
        {
          state: 'PENDING',
          op: 'update',
          baseVersion: event.baseVersion,
          resolution: event.resolution,
          enc: event.enc,
          encSummary: event.encSummary,
          conflict: null,
          attempts: 0,
          nextAttemptAt: 0,
          lastError: null,
        },
        event.now,
      );

    case 'accept_server':
      if (item.state !== 'CONFLICT') throw illegal();
      return {
        kind: 'synced',
        serverId: item.serverId ?? '',
        serverVersion: item.serverVersion ?? 0,
        requeue: null,
      };

    case 'fix':
      if (item.state !== 'FAILED') throw illegal();
      return update(
        item,
        {
          state: 'PENDING',
          enc: event.enc,
          encSummary: event.encSummary,
          attempts: 0,
          nextAttemptAt: 0,
          lastError: null,
        },
        event.now,
      );

    case 'discard':
      if (item.state !== 'FAILED' && item.state !== 'CONFLICT') throw illegal();
      return { kind: 'remove' };
  }
}
