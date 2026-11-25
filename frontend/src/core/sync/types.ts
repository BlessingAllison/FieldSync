/** Outbox (sync queue) item model — ADD §9, §12.2. Plaintext fields are PII-free by design. */
import type { Sealed } from '../crypto/aead';
import type { ErrorClass } from '../contracts/error-codes.gen';

export type OutboxState = 'PENDING' | 'SYNCING' | 'RETRY_WAIT' | 'FAILED' | 'CONFLICT';
export type Resolution = 'none' | 'override' | 'merge';

export interface LastError {
  errorClass: ErrorClass | 'network';
  code: string;
  http: number | null;
  requestId: string | null;
  at: number;
  /** Field path → rule codes (no values) for validation failures. */
  fields?: Record<string, string[]>;
}

export interface OutboxItem {
  clientUuid: string;
  op: 'create' | 'update';
  templateCode: string;
  templateVersion: number;
  facilityId: string;
  state: OutboxState;
  /** Requests that actually left the device (offline time never counts). */
  attempts: number;
  nextAttemptAt: number;
  leaseUntil: number | null;
  baseVersion: number | null;
  resolution: Resolution;
  dirtyAfterSync: boolean;
  serverId: string | null;
  serverVersion: number | null;
  lastError: LastError | null;
  capturedAt: number;
  createdAt: number;
  updatedAt: number;
  /** AES-GCM({payload}) — AAD "fs:v1:outbox:<clientUuid>" */
  enc: Sealed;
  /** AES-GCM({patientLabel}) — tiny blob so lists never decrypt full payloads. */
  encSummary: Sealed;
  /** AES-GCM(server copy) when state = CONFLICT. */
  conflict: Sealed | null;
  /** AES-GCM(payload at baseVersion) for field-level conflict diffs (updates only). */
  base: Sealed | null;
}

export interface ServerCopy {
  version: number;
  payload: Record<string, unknown>;
  status: string;
  changed_at: string;
  changed_by_role: string | null;
}

export interface ItemSummary {
  patientLabel: string | null;
}

/** States that count as "stuck" for the dashboard and the device badge (ADD §12.6). */
export const STUCK_ATTEMPTS = 8;
export const STUCK_AGE_MS = 48 * 60 * 60 * 1000;

export const isStuck = (item: OutboxItem, now: number): boolean =>
  (item.state === 'RETRY_WAIT' || item.state === 'PENDING') &&
  (item.attempts >= STUCK_ATTEMPTS || now - item.createdAt > STUCK_AGE_MS);
