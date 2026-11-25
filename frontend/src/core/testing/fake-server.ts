/**
 * In-memory server with the same upsert semantics as backend submissions/services.py
 * (replay by content, version check with the own-writes rule, quarantine), plus fault
 * injection. Used by engine tests and to model lost acknowledgements precisely.
 */
import type { ApiFailure, ApiResult } from '../api/http';
import type { BatchResponse, DeviceState, SubmissionItem, UpsertResult } from '../api/client';
import type { SyncTransport } from '../sync/engine';

interface Row {
  id: string;
  version: number;
  hash: string;
  payload: Record<string, unknown>;
  status: 'accepted' | 'rejected';
  writers: Array<{ version: number; device: string }>; // device id, or 'supervisor'
}

export type Fault = 'drop' | 'ack_lost' | 'unavailable' | 'auth' | 'revoked' | 'timeout';

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );

const failure = (kind: 'network' | 'timeout'): ApiResult<never> => ({
  ok: false,
  error: { kind, errorClass: 'transient', status: null, requestId: 'r' },
});

const apiError = (
  status: number,
  code: string,
  errorClass: ApiFailure['errorClass'],
  retryAfter: number | null = null,
): ApiResult<never> => ({
  ok: false,
  error: {
    kind: 'api',
    status,
    code: code as never,
    errorClass: errorClass as never,
    message: code,
    details: undefined,
    data: null,
    retryAfterSeconds: retryAfter,
    requestId: 'r',
  },
});

export class FakeServer implements SyncTransport {
  rows = new Map<string, Row>();
  requests = 0;
  heartbeats: DeviceState[] = [];
  /** Faults consumed one per request, in order. */
  faults: Fault[] = [];
  online = true;
  constructor(private readonly device = 'device-1') {}

  supervisorEdit(clientUuid: string, patch: Record<string, unknown>): void {
    const row = this.rows.get(clientUuid);
    if (!row) throw new Error('no row');
    row.version += 1;
    row.payload = { ...row.payload, ...patch };
    row.hash = canonical(row.payload);
    row.writers.push({ version: row.version, device: 'supervisor' });
  }

  private upsert(item: SubmissionItem): UpsertResult {
    const payload = item.payload as Record<string, unknown>;
    const invalid = typeof payload.age_months === 'number' && payload.age_months > 59;
    const hash = canonical(payload);
    const row = this.rows.get(item.client_uuid);
    const submission = (r: Row) => ({ id: r.id, version: r.version, status: r.status }) as never;
    if (!row) {
      const created: Row = {
        id: `srv-${this.rows.size + 1}`,
        version: 1,
        hash,
        payload,
        status: invalid ? 'rejected' : 'accepted',
        writers: [{ version: 1, device: this.device }],
      };
      this.rows.set(item.client_uuid, created);
      return invalid
        ? ({
            client_uuid: item.client_uuid,
            outcome: 'rejected',
            http_status: 422,
            submission: submission(created),
            error: { code: 'validation_failed', details: { fields: { age_months: ['max'] } } },
          } as never)
        : ({
            client_uuid: item.client_uuid,
            outcome: 'created',
            http_status: 201,
            submission: submission(created),
          } as never);
    }
    if (row.hash === hash) {
      return {
        client_uuid: item.client_uuid,
        outcome: 'replayed',
        http_status: 200,
        submission: submission(row),
      } as never;
    }
    const base = item.base_version ?? 0;
    const ownWritesOnly = row.writers
      .filter((w) => w.version > base)
      .every((w) => w.device === this.device);
    if (base !== row.version && !ownWritesOnly) {
      return {
        client_uuid: item.client_uuid,
        outcome: 'conflict',
        http_status: 409,
        submission: submission(row),
        error: { code: 'conflict_version', details: { server_version: row.version } },
        server_copy: {
          version: row.version,
          payload: row.payload,
          status: row.status,
          changed_at: new Date().toISOString(),
          changed_by_role: 'supervisor',
        },
      } as never;
    }
    row.version += 1;
    row.payload = payload;
    row.hash = hash;
    row.status = invalid ? 'rejected' : 'accepted';
    row.writers.push({ version: row.version, device: this.device });
    return {
      client_uuid: item.client_uuid,
      outcome: 'updated',
      http_status: 200,
      submission: submission(row),
    } as never;
  }

  submitBatch(
    items: SubmissionItem[],
    deviceState: DeviceState | undefined,
  ): Promise<ApiResult<BatchResponse>> {
    return Promise.resolve(this.submitBatchSync(items, deviceState));
  }

  private submitBatchSync(
    items: SubmissionItem[],
    deviceState: DeviceState | undefined,
  ): ApiResult<BatchResponse> {
    this.requests += 1;
    if (!this.online) return failure('network');
    const fault = this.faults.shift();
    if (fault === 'drop') return failure('network');
    if (fault === 'timeout') return failure('timeout');
    if (fault === 'unavailable') return apiError(503, 'unavailable', 'transient', 3);
    if (fault === 'auth') return apiError(401, 'token_expired', 'auth');
    if (fault === 'revoked') return apiError(401, 'device_revoked', 'revoked');
    const results = items.map((item) => this.upsert(item));
    if (deviceState) this.heartbeats.push(deviceState);
    if (fault === 'ack_lost') return failure('network'); // committed, but the response never arrives
    return {
      ok: true,
      status: 200,
      data: { results },
      meta: { request_id: 'r', api_version: '1' },
      etag: null,
      notModified: false,
    };
  }

  heartbeat(state: DeviceState): Promise<ApiResult<unknown>> {
    if (!this.online) return Promise.resolve(failure('network'));
    this.heartbeats.push(state);
    return Promise.resolve({
      ok: true,
      status: 200,
      data: {},
      meta: { request_id: 'r', api_version: '1' },
      etag: null,
      notModified: false,
    });
  }

  probe(): Promise<boolean> {
    return Promise.resolve(this.online);
  }
}

/** A LockManager with real ifAvailable semantics (Node has no navigator.locks). */
export class FakeLocks implements Pick<LockManager, 'request'> {
  private held = new Set<string>();
  request(...args: unknown[]): Promise<never> {
    const name = args[0] as string;
    const options = (args.length === 3 ? args[1] : {}) as LockOptions;
    const callback = (args.length === 3 ? args[2] : args[1]) as (
      lock: Lock | null,
    ) => Promise<unknown>;
    if (this.held.has(name)) {
      if (options.ifAvailable) return callback(null) as Promise<never>;
      return new Promise((resolve) => setTimeout(resolve, 5)).then(() => this.request(...args));
    }
    this.held.add(name);
    return Promise.resolve(callback({ name, mode: 'exclusive' } as Lock)).finally(() =>
      this.held.delete(name),
    ) as Promise<never>;
  }
}
