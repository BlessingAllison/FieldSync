/**
 * SyncEventBus (Observer, ADD §7). Typed in-context emitter, bridged across page ↔ service
 * worker ↔ other tabs with BroadcastChannel('fs-sync') so the badge updates when the SW
 * syncs in the background. Events carry ids and states only — never payloads.
 */
import type { OutboxState } from './types';

export type EngineState =
  | 'IDLE'
  | 'DRAINING'
  | 'PAUSED_OFFLINE'
  | 'PAUSED_AUTH'
  | 'PAUSED_LOCKED'
  | 'PAUSED_QUOTA'
  | 'PAUSED_REVOKED';

export type ItemOutcome =
  | 'created'
  | 'updated'
  | 'replayed'
  | 'conflict'
  | 'rejected'
  | 'forbidden'
  | 'invalid'
  | 'retry';

export type SyncBusEvent =
  | { type: 'engine'; state: EngineState }
  | { type: 'queue_changed' }
  | {
      type: 'item';
      clientUuid: string;
      state: OutboxState | 'SYNCED' | 'REMOVED';
      outcome?: ItemOutcome;
      attempts?: number;
      nextAttemptAt?: number;
    }
  | { type: 'batch'; size: number; latencyMs: number; ok: boolean }
  | {
      type: 'drained';
      sent: number;
      replayed: number;
      failed: number;
      conflicts: number;
      retrying: number;
    }
  | { type: 'breaker'; state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' }
  | { type: 'auth_required' }
  | { type: 'device_revoked' }
  | { type: 'simulated'; kind: 'offline' | 'drop' | 'ack_lost' | 'server_error'; path: string };

type Listener = (event: SyncBusEvent) => void;

export const CHANNEL_NAME = 'fs-sync';

export class SyncEventBus {
  private readonly listeners = new Set<Listener>();
  private readonly channel: BroadcastChannel | null;

  constructor(
    readonly origin: string,
    useChannel = typeof BroadcastChannel !== 'undefined',
  ) {
    this.channel = useChannel ? new BroadcastChannel(CHANNEL_NAME) : null;
    this.channel?.addEventListener(
      'message',
      (message: MessageEvent<{ from: string; event: SyncBusEvent }>) => {
        if (message.data?.from !== this.origin) this.dispatch(message.data.event);
      },
    );
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: SyncBusEvent): void {
    this.dispatch(event);
    try {
      this.channel?.postMessage({ from: this.origin, event });
    } catch {
      // A closed channel must never break syncing.
    }
  }

  private dispatch(event: SyncBusEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  close(): void {
    this.channel?.close();
    this.listeners.clear();
  }
}
