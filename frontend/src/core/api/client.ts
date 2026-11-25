/**
 * ApiClient (Adapter, ADD §7): typed endpoints over requestJson with
 *  - device-bound auth: access token in memory only; refresh via the HttpOnly cookie;
 *  - single-flight refresh across page AND service worker (Web Locks), so token rotation
 *    never presents an already-blacklisted refresh token (ADD §11.2);
 *  - gzip request bodies for sync batches (CompressionStream);
 *  - optional simulated network conditions.
 */
import type { components } from './schema.gen';
import type { ApiFailure, ApiResult, RequestOptions } from './http';
import { requestJson } from './http';

type Schemas = components['schemas'];
export type UserProfile = Schemas['UserProfile'];
export type LoginResponse = Schemas['LoginResponse'];
export type RefreshResponse = Schemas['RefreshResponse'];
export type Facility = Schemas['Facility'];
export type FormTemplate = Schemas['FormTemplate'];
export type SubmissionItem = Schemas['SubmissionItemRequest'];
export type DeviceState = Schemas['DeviceStateRequest'];
export type BatchResponse = Schemas['BatchResponse'];
export type UpsertResult = Schemas['UpsertResult'];
export type SubmissionDetail = Schemas['SubmissionDetail'];
export type SyncStatus = Schemas['SyncStatus'];
export type FacilityHealth = Schemas['FacilityHealth'];
export type SupervisorEdit = Schemas['SupervisorEdit'];

export type RefreshOutcome =
  | { ok: true; profile: UserProfile }
  | { ok: false; reason: 'auth' | 'revoked' | 'network' };

const REFRESH_LOCK = 'fs-auth-refresh';
const EXPIRY_SKEW_MS = 30_000;
const GZIP_THRESHOLD = 1_024;

export interface ApiClientOptions {
  appVersion: string;
  fetchImpl?: typeof fetch;
  clock?: () => number;
  /** Cross-context mutual exclusion; null disables (tests). */
  locks?: Pick<LockManager, 'request'> | null;
}

const authFailure = (code: 'token_expired' | 'device_revoked'): ApiResult<never> => ({
  ok: false,
  error: {
    kind: 'api',
    status: 401,
    code,
    errorClass: code === 'device_revoked' ? 'revoked' : 'auth',
    message: code,
    details: undefined,
    data: null,
    retryAfterSeconds: null,
    requestId: null,
  },
});

export async function gzipJson(value: unknown): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null;
  const json = JSON.stringify(value);
  if (json.length < GZIP_THRESHOLD) return null;
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export class ApiClient {
  private access: { token: string; expiresAt: number } | null = null;
  private inflightRefresh: Promise<RefreshOutcome> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => number;
  private readonly locks: Pick<LockManager, 'request'> | null;

  constructor(private readonly options: ApiClientOptions) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.clock = options.clock ?? Date.now;
    // Works in both Window and ServiceWorkerGlobalScope (core/ never names DOM-only types).
    const nav = (globalThis as { navigator?: { locks?: LockManager } }).navigator;
    this.locks = options.locks === undefined ? (nav?.locks ?? null) : options.locks;
  }

  setAccess(token: string, expiresAt: string | number): void {
    this.access = {
      token,
      expiresAt: typeof expiresAt === 'number' ? expiresAt : Date.parse(expiresAt),
    };
  }

  clearAccess(): void {
    this.access = null;
  }

  private request<T>(path: string, options: RequestOptions = {}): Promise<ApiResult<T>> {
    return requestJson<T>(path, {
      ...options,
      fetchImpl: this.fetchImpl,
      headers: {
        'X-App-Version': this.options.appVersion,
        'X-Client-Time': new Date(this.clock()).toISOString(),
        ...options.headers,
      },
    });
  }

  /** Rotate the refresh cookie. One refresh at a time per origin (page + SW + tabs). */
  refresh(): Promise<RefreshOutcome> {
    if (this.inflightRefresh) return this.inflightRefresh;
    const run = async (): Promise<RefreshOutcome> => {
      const result = await this.request<RefreshResponse>('/api/v1/auth/refresh', {
        method: 'POST',
        headers: { 'X-Requested-With': 'fieldsync' },
      });
      if (result.ok) {
        this.setAccess(result.data.access, result.data.access_expires_at);
        return { ok: true, profile: result.data.user };
      }
      this.clearAccess();
      if (result.error.kind !== 'api') return { ok: false, reason: 'network' };
      if (result.error.errorClass === 'revoked') return { ok: false, reason: 'revoked' };
      if (result.error.errorClass === 'transient') return { ok: false, reason: 'network' };
      return { ok: false, reason: 'auth' };
    };
    const locked = this.locks
      ? (this.locks.request(REFRESH_LOCK, run) as Promise<RefreshOutcome>)
      : run();
    this.inflightRefresh = locked.finally(() => {
      this.inflightRefresh = null;
    });
    return this.inflightRefresh;
  }

  private async ensureAccess(): Promise<ApiResult<never> | null> {
    if (this.access && this.access.expiresAt - this.clock() > EXPIRY_SKEW_MS) return null;
    const outcome = await this.refresh();
    if (outcome.ok) return null;
    if (outcome.reason === 'revoked') return authFailure('device_revoked');
    if (outcome.reason === 'network') {
      return {
        ok: false,
        error: { kind: 'network', errorClass: 'transient', status: null, requestId: '' },
      };
    }
    return authFailure('token_expired');
  }

  private async authed<T>(path: string, options: RequestOptions = {}): Promise<ApiResult<T>> {
    const blocked = await this.ensureAccess();
    if (blocked) return blocked;
    const send = () =>
      this.request<T>(path, {
        ...options,
        headers: { ...options.headers, Authorization: `Bearer ${this.access?.token ?? ''}` },
      });
    const first = await send();
    if (first.ok || first.error.kind !== 'api' || first.error.status !== 401) return first;
    if (first.error.code === 'device_revoked') return first;
    // Expired/invalid access token: refresh once and retry.
    this.clearAccess();
    const blockedAgain = await this.ensureAccess();
    if (blockedAgain) return blockedAgain;
    return send();
  }

  // ── Endpoints ─────────────────────────────────────────────────────────────
  login(
    username: string,
    password: string,
    device: { id: string; label: string; app_version: string },
  ) {
    return this.request<LoginResponse>('/api/v1/auth/login', {
      method: 'POST',
      body: { username, password, device },
    }).then((result) => {
      if (result.ok) this.setAccess(result.data.access, result.data.access_expires_at);
      return result;
    });
  }

  logout() {
    this.clearAccess();
    return this.request<{ signed_out: boolean }>('/api/v1/auth/logout', {
      method: 'POST',
      headers: { 'X-Requested-With': 'fieldsync' },
    });
  }

  me() {
    return this.authed<UserProfile>('/api/v1/auth/me');
  }

  facilities(etag?: string | null) {
    return this.authed<Facility[]>('/api/v1/facilities', {
      headers: etag ? { 'If-None-Match': etag } : {},
    });
  }

  templates(etag?: string | null) {
    return this.authed<FormTemplate[]>('/api/v1/form-templates', {
      headers: etag ? { 'If-None-Match': etag } : {},
    });
  }

  async submitBatch(items: SubmissionItem[], deviceState?: DeviceState, requestId?: string) {
    const body = deviceState ? { items, device_state: deviceState } : { items };
    const gzipped = await gzipJson(body);
    return this.authed<BatchResponse>('/api/v1/submissions/batch', {
      method: 'POST',
      requestId,
      ...(gzipped
        ? {
            rawBody: gzipped,
            headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
          }
        : { body }),
    });
  }

  heartbeat(state: DeviceState) {
    return this.authed<{ facilities_applied: number }>('/api/v1/sync/heartbeat', {
      method: 'POST',
      body: state,
    });
  }

  submissionByClient(clientUuid: string) {
    return this.authed<SubmissionDetail>(`/api/v1/submissions/by-client/${clientUuid}`);
  }

  syncStatus(county?: string) {
    const query = county ? `?county=${encodeURIComponent(county)}` : '';
    return this.authed<SyncStatus>(`/api/v1/submissions/sync-status${query}`);
  }

  supervisorEdit(clientUuid: string) {
    return this.authed<SupervisorEdit>(`/api/v1/demo/supervisor-edit/${clientUuid}`, {
      method: 'POST',
    });
  }

  /** Circuit-breaker probe: ~200 bytes, unauthenticated. */
  async probe(): Promise<boolean> {
    const result = await this.request<null>('/api/v1/health/live', {
      method: 'HEAD',
      timeoutMs: 8_000,
    });
    return result.ok;
  }
}

export const isNetworkFailure = (error: ApiFailure): boolean => error.kind !== 'api';
