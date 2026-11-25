/** Wire types for the standard response envelope (ADD §10.1) and its runtime guard. */
import type { ErrorCode } from '../contracts/error-codes.gen';
import { isErrorCode } from '../contracts/error-codes.gen';

export interface ApiErrorBody {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface EnvelopeMeta {
  request_id: string | null;
  api_version: string;
  pagination?: { next_cursor: string | null; limit?: number };
  [key: string]: unknown;
}

export interface Envelope<T> {
  success: boolean;
  data: T | null;
  error: ApiErrorBody | null;
  meta: EnvelopeMeta;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Structural check only — `data` is validated by the caller that knows its shape.
 * An unknown error code is treated as malformed: the client must never guess how
 * to transition a queued item for a code it does not understand.
 */
export function isEnvelope(value: unknown): value is Envelope<unknown> {
  if (!isRecord(value) || typeof value.success !== 'boolean' || !isRecord(value.meta)) {
    return false;
  }
  if (!('data' in value)) return false;
  const error = value.error;
  if (error === null) return value.success;
  return (
    !value.success &&
    isRecord(error) &&
    isErrorCode(error.code) &&
    typeof error.message === 'string' &&
    (error.details === undefined || isRecord(error.details))
  );
}
