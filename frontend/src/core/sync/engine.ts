/**
 * SyncEngine — the queue consumer (Producer–Consumer, ADD §7, §12).
 *
 * Runs identically in the page and in the service worker. One consumer per origin at a
 * time (Web Lock "fs-sync", ifAvailable); leases recover items orphaned by a killed tab/SW.
 *
 * Per drain:
 *   1. recover expired leases;
 *   2. if the ConnectivityBreaker is OPEN/HALF_OPEN, probe /health/live first;
 *   3. claim due items (FIFO, ≤ AIMD batch size), decrypt, POST /submissions/batch (gzip);
 *   4. apply one state-machine event per item from its own result;
 *   5. repeat until nothing is due; heartbeat if the queue is empty and a beat is due.
 */
import type { ApiFailure, ApiResult } from '../api/http';
import type { BatchResponse, DeviceState, SubmissionItem, UpsertResult } from '../api/client';
import { uuidv7 } from '../ids/uuidv7';
import type { ReceiptRecord } from '../db/schema';
import { QuotaExceededError, type Vault, isQuotaError } from '../repositories/vault';
import { BatchSizer } from './batcher';
import { backoffDelay } from './backoff';
import { ConnectivityBreaker } from './breaker';
import type { SyncEventBus } from './bus';
import { type EngineState, type ItemOutcome } from './bus';
import { computeDeviceState } from './device-state';
import type { OutboxEvent } from './states';
import type { LastError, OutboxItem, ServerCopy } from './types';

export interface SyncTransport {
  submitBatch(
    items: SubmissionItem[],
    deviceState: DeviceState | undefined,
    requestId: string,
  ): Promise<ApiResult<BatchResponse>>;
  heartbeat(state: DeviceState): Promise<ApiResult<unknown>>;
  probe(): Promise<boolean>;
}

export interface EngineDeps {
  vault: Vault;
  transport: SyncTransport;
  bus: SyncEventBus;
  breaker?: ConnectivityBreaker;
  sizer?: BatchSizer;
  clock?: () => number;
  random?: () => number;
  locks?: Pick<LockManager, 'request'> | null;
  heartbeatIntervalMs?: number;
  maxRounds?: number;
}

export interface DrainReport {
  skipped: boolean;
  state: EngineState;
  sent: number;
  replayed: number;
  failed: number;
  conflicts: number;
  retrying: number;
  /** Items still due right now (for Background Sync: reject so the browser retries). */
  remainingDue: number;
  nextDueAt: number | null;
}

export const SYNC_LOCK = 'fs-sync';
export const HEARTBEAT_INTERVAL_MS = 30 * 60_000;

const networkError = (failure: ApiFailure, now: number): LastError => ({
  errorClass: 'network',
  code: failure.kind,
  http: failure.status,
  requestId: failure.requestId,
  at: now,
});

/** Per-drain bookkeeping for device-state reporting. */
interface DrainProgress {
  /** A batch carrying device state was accepted by the server this drain. */
  reported: boolean;
  /** At least one batch was answered (so server-side queue counts are now stale). */
  acked: boolean;
}

export class SyncEngine {
  state: EngineState = 'IDLE';
  readonly breaker: ConnectivityBreaker;
  private readonly sizer: BatchSizer;
  private readonly clock: () => number;
  private readonly random: () => number;
  private readonly locks: Pick<LockManager, 'request'> | null;
  private draining: Promise<DrainReport> | null = null;
  /** The last batch failed for network reasons → "waiting for network", not "idle". */
  private lastFailureWasNetwork = false;

  constructor(private readonly deps: EngineDeps) {
    this.breaker = deps.breaker ?? new ConnectivityBreaker(deps.clock);
    this.sizer = deps.sizer ?? new BatchSizer();
    this.clock = deps.clock ?? Date.now;
    this.random = deps.random ?? Math.random;
    const nav = (globalThis as { navigator?: { locks?: LockManager } }).navigator;
    this.locks = deps.locks === undefined ? (nav?.locks ?? null) : deps.locks;
    this.breaker.subscribe((state) => deps.bus.emit({ type: 'breaker', state }));
  }

  private setState(state: EngineState): void {
    if (this.state === state) return;
    this.state = state;
    this.deps.bus.emit({ type: 'engine', state });
  }

  /** Coalesces concurrent calls in this context; the Web Lock coalesces across contexts. */
  drain(): Promise<DrainReport> {
    if (this.draining) return this.draining;
    const run = async (): Promise<DrainReport> => {
      if (!this.locks) return this.run(false);
      let report: DrainReport | null = null;
      await this.locks.request(SYNC_LOCK, { ifAvailable: true }, async (lock) => {
        if (lock) report = await this.run(true);
      });
      return report ?? this.emptyReport(true);
    };
    this.draining = run().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  private emptyReport(skipped: boolean): DrainReport {
    return {
      skipped,
      state: this.state,
      sent: 0,
      replayed: 0,
      failed: 0,
      conflicts: 0,
      retrying: 0,
      remainingDue: 0,
      nextDueAt: null,
    };
  }

  /**
   * @param exclusive true when this context holds the "fs-sync" Web Lock. The browser releases
   *   a lock when its holder dies, so while we hold it every SYNCING item is provably orphaned
   *   (killed tab/SW) and is recovered at once; without locks we wait for the lease to expire.
   */
  private async run(exclusive: boolean): Promise<DrainReport> {
    const { vault, bus } = this.deps;
    const report = this.emptyReport(false);
    const drain: DrainProgress = { reported: false, acked: false };
    try {
      await vault.recoverLeases(exclusive ? Number.POSITIVE_INFINITY : this.clock());
      let rounds = 0;
      while (rounds < (this.deps.maxRounds ?? 200)) {
        rounds += 1;
        if (!(await this.ensureConnectivity())) {
          this.setState('PAUSED_OFFLINE');
          break;
        }
        const due = await vault.listDue(this.clock(), this.sizer.size);
        if (due.length === 0) {
          if (this.lastFailureWasNetwork) {
            this.setState('PAUSED_OFFLINE');
          } else {
            this.setState('IDLE');
            // Device state rides on the first batch, computed BEFORE its acks; once anything
            // was acknowledged, report the post-drain queue at once so the supervisor does
            // not see "waiting on phones" for forms that already arrived.
            if (drain.acked) await this.heartbeat();
            else await this.maybeHeartbeat();
          }
          break;
        }
        this.setState('DRAINING');
        const stop = await this.sendBatch(due, report, drain);
        if (stop) break;
      }
    } catch (error) {
      if (isQuotaError(error) || error instanceof QuotaExceededError) this.setState('PAUSED_QUOTA');
      else throw error;
    } finally {
      report.state = this.state;
      report.nextDueAt = await vault.nextDueAt().catch(() => null);
      report.remainingDue = (await vault.listDue(this.clock(), 1).catch(() => [])).length;
      bus.emit({ type: 'queue_changed' });
      bus.emit({
        type: 'drained',
        sent: report.sent,
        replayed: report.replayed,
        failed: report.failed,
        conflicts: report.conflicts,
        retrying: report.retrying,
      });
    }
    return report;
  }

  /** Breaker gate with a cheap probe; fast-tracks network-failed items when it closes. */
  private async ensureConnectivity(): Promise<boolean> {
    if (this.breaker.allowsRequests()) return true;
    if (!this.breaker.needsProbe()) return false;
    const ok = await this.deps.transport.probe();
    if (!ok) {
      this.breaker.recordNetworkFailure();
      return false;
    }
    this.breaker.recordSuccess();
    this.lastFailureWasNetwork = false;
    await this.connectivityRestored();
    return true;
  }

  async connectivityRestored(): Promise<void> {
    const { vault } = this.deps;
    const now = this.clock();
    const waiting = (await vault.listOutbox()).filter((item) => item.state === 'RETRY_WAIT');
    await vault.applyMany(
      waiting.map((item) => ({
        clientUuid: item.clientUuid,
        event: {
          type: 'connectivity_restored',
          now,
          staggerMs: Math.round(this.random() * 3_000),
        } as const,
      })),
    );
  }

  private async claim(due: OutboxItem[]): Promise<OutboxItem[]> {
    const now = this.clock();
    const results = await this.deps.vault.applyMany(
      due.map((item) => ({ clientUuid: item.clientUuid, event: { type: 'claim', now } as const })),
    );
    const claimed: OutboxItem[] = [];
    for (const result of results) {
      if (result?.kind === 'update') {
        claimed.push(result.item);
        this.deps.bus.emit({
          type: 'item',
          clientUuid: result.item.clientUuid,
          state: 'SYNCING',
          attempts: result.item.attempts,
        });
      }
    }
    return claimed;
  }

  private async toRequestItem(item: OutboxItem): Promise<SubmissionItem> {
    return {
      client_uuid: item.clientUuid,
      op: item.op,
      template: { code: item.templateCode, version: item.templateVersion },
      facility_id: item.facilityId,
      captured_at: new Date(item.capturedAt).toISOString(),
      base_version: item.baseVersion,
      resolution: item.resolution,
      attempt: item.attempts + 1,
      payload: (await this.deps.vault.outboxPayload(item)) as SubmissionItem['payload'],
    };
  }

  /** Returns true when the engine must stop (auth, revoked). */
  private async sendBatch(
    due: OutboxItem[],
    report: DrainReport,
    drain: DrainProgress,
  ): Promise<boolean> {
    const { vault, transport, bus } = this.deps;
    const claimed = await this.claim(due);
    if (claimed.length === 0) return false;
    const items = await Promise.all(claimed.map((item) => this.toRequestItem(item)));
    // One full-queue read per drain, not per batch (it was 1 of 3 O(queue) reads per round).
    const deviceState = drain.reported ? undefined : await computeDeviceState(vault, this.clock());
    const requestId = uuidv7();
    const started = this.clock();
    await vault.setMeta('lastAttemptAt', started);
    const result = await transport.submitBatch(items, deviceState, requestId);
    const latencyMs = this.clock() - started;
    bus.emit({ type: 'batch', size: items.length, latencyMs, ok: result.ok });

    if (!result.ok) return this.handleBatchFailure(claimed, result.error, report);

    this.lastFailureWasNetwork = false;
    drain.reported = true;
    drain.acked = true;
    this.breaker.recordSuccess();
    this.sizer.onSuccess(latencyMs);
    await vault.setMeta('lastSuccessAt', this.clock());
    const byUuid = new Map<string, UpsertResult>(
      result.data.results.filter((r) => r.client_uuid).map((r) => [String(r.client_uuid), r]),
    );
    const prepared = await Promise.all(
      claimed.map((item) =>
        this.prepareResult(item, byUuid.get(item.clientUuid), result.meta.request_id),
      ),
    );
    const applied = await vault.applyMany(prepared.map((p) => p.entry));
    prepared.forEach((p, index) => {
      const outcome = p.outcome;
      if (outcome === 'replayed') report.replayed += 1;
      else if (outcome === 'created' || outcome === 'updated') report.sent += 1;
      else if (outcome === 'conflict') report.conflicts += 1;
      else if (outcome === 'retry') report.retrying += 1;
      else report.failed += 1;
      const res = applied[index];
      const state =
        res?.kind === 'synced'
          ? res.requeue
            ? 'PENDING'
            : 'SYNCED'
          : res?.kind === 'update'
            ? res.item.state
            : 'REMOVED';
      bus.emit({ type: 'item', clientUuid: p.entry.clientUuid, state, outcome });
    });
    const at = this.clock();
    await vault.logMany(
      prepared.map((p) => ({
        at,
        kind: `item_${p.outcome}`,
        clientUuid: p.entry.clientUuid,
        code: p.code,
        requestId: result.meta.request_id,
      })),
    );
    return false;
  }

  private async handleBatchFailure(
    claimed: OutboxItem[],
    error: ApiFailure,
    report: DrainReport,
  ): Promise<boolean> {
    const { vault, bus } = this.deps;
    const now = this.clock();
    const applyAll = async (event: (item: OutboxItem) => OutboxEvent) => {
      const results = await vault.applyMany(
        claimed.map((item) => ({ clientUuid: item.clientUuid, event: event(item) })),
      );
      for (const result of results) {
        if (result?.kind === 'update') {
          bus.emit({
            type: 'item',
            clientUuid: result.item.clientUuid,
            state: result.item.state,
            outcome: 'retry',
            attempts: result.item.attempts,
            nextAttemptAt: result.item.nextAttemptAt,
          });
        }
      }
    };

    if (error.kind !== 'api') {
      this.lastFailureWasNetwork = true;
      this.breaker.recordNetworkFailure();
      if (error.kind === 'timeout') this.sizer.onSlowOrTooLarge();
      report.retrying += claimed.length;
      await applyAll((item) => ({
        type: 'transient',
        now,
        error: networkError(error, now),
        delayMs: backoffDelay(item.attempts + 1, null, this.random),
        countsAsAttempt: true,
      }));
      await vault.log({
        at: now,
        kind: 'batch_network_failure',
        code: error.kind,
        requestId: error.requestId,
      });
      return false; // the loop re-checks the breaker
    }

    if (error.errorClass === 'auth') {
      await applyAll(() => ({ type: 'auth_paused', now }));
      this.setState('PAUSED_AUTH');
      bus.emit({ type: 'auth_required' });
      return true;
    }
    if (error.errorClass === 'revoked') {
      await applyAll(() => ({ type: 'auth_paused', now }));
      this.setState('PAUSED_REVOKED');
      bus.emit({ type: 'device_revoked' });
      return true;
    }

    this.lastFailureWasNetwork = false;
    this.breaker.recordSuccess(); // the server answered: the network is fine
    const lastError: LastError = {
      errorClass: error.errorClass,
      code: error.code,
      http: error.status,
      requestId: error.requestId,
      at: now,
    };
    if (error.code === 'payload_too_large' && claimed.length > 1) {
      this.sizer.onSlowOrTooLarge();
      await applyAll(() => ({
        type: 'transient',
        now,
        error: lastError,
        delayMs: 0,
        countsAsAttempt: false,
      }));
      return false;
    }
    if (error.errorClass === 'transient') {
      report.retrying += claimed.length;
      await applyAll((item) => ({
        type: 'transient',
        now,
        error: lastError,
        delayMs: backoffDelay(item.attempts + 1, error.retryAfterSeconds, this.random),
        countsAsAttempt: true,
      }));
      await vault.log({
        at: now,
        kind: 'batch_server_error',
        code: error.code,
        requestId: error.requestId,
      });
      return false;
    }
    report.failed += claimed.length;
    await applyAll(() => ({ type: 'permanent', now, error: lastError }));
    return false;
  }

  /** Turn one per-item server result into a prepared (already-encrypted) state event. */
  private async prepareResult(
    item: OutboxItem,
    result: UpsertResult | undefined,
    requestId: string | null,
  ): Promise<{
    entry: { clientUuid: string; event: OutboxEvent; receiptPatch?: Partial<ReceiptRecord> };
    outcome: ItemOutcome;
    code: string;
  }> {
    const now = this.clock();
    const uuid = item.clientUuid;
    if (!result) {
      // The server did not report on this item: transient, never assumed successful.
      const error: LastError = {
        errorClass: 'transient',
        code: 'missing_result',
        http: null,
        requestId,
        at: now,
      };
      return {
        entry: {
          clientUuid: uuid,
          event: {
            type: 'transient',
            now,
            error,
            delayMs: backoffDelay(item.attempts + 1, null, this.random),
            countsAsAttempt: true,
          },
        },
        outcome: 'retry',
        code: 'missing_result',
      };
    }
    const outcome = result.outcome as ItemOutcome;
    const code = (result.error as { code?: string } | undefined)?.code ?? outcome;
    const submission = result.submission;
    if (outcome === 'created' || outcome === 'updated' || outcome === 'replayed') {
      return {
        entry: {
          clientUuid: uuid,
          event: {
            type: 'ack',
            now,
            serverId: submission ? String(submission.id) : (item.serverId ?? ''),
            serverVersion: submission?.version ?? item.serverVersion ?? 1,
          },
          ...(submission ? { receiptPatch: { serverStatus: submission.status } } : {}),
        },
        outcome,
        code,
      };
    }
    if (outcome === 'conflict') {
      const copy = result.server_copy as unknown as ServerCopy;
      const serverCopy = await this.deps.vault.seal('outbox-conflict', uuid, copy);
      return {
        entry: {
          clientUuid: uuid,
          event: { type: 'conflict', now, serverVersion: copy.version, serverCopy },
          ...(submission ? { receiptPatch: { serverId: String(submission.id) } } : {}),
        },
        outcome,
        code,
      };
    }
    const details = (
      result.error as { details?: { fields?: Record<string, string[]> } } | undefined
    )?.details;
    return {
      entry: {
        clientUuid: uuid,
        event: {
          type: 'permanent',
          now,
          error: {
            errorClass: 'permanent',
            code,
            http: result.http_status,
            requestId,
            at: now,
            ...(details?.fields ? { fields: details.fields } : {}),
          },
        },
        ...(submission
          ? {
              receiptPatch: {
                serverId: String(submission.id),
                serverVersion: submission.version,
                serverStatus: submission.status,
              },
            }
          : {}),
      },
      outcome,
      code,
    };
  }

  private async maybeHeartbeat(): Promise<void> {
    const last = (await this.deps.vault.getMeta<number>('lastHeartbeatAt')) ?? 0;
    if (this.clock() - last < (this.deps.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS)) return;
    await this.heartbeat();
  }

  private async heartbeat(): Promise<void> {
    const { vault, transport } = this.deps;
    const now = this.clock();
    const result = await transport.heartbeat(await computeDeviceState(vault, now));
    if (result.ok) await vault.setMeta('lastHeartbeatAt', now);
  }
}
