/**
 * Low-level fetch adapter: timeout, request id, envelope parsing, error classification,
 * conditional GETs and pre-encoded (gzip) bodies.
 *
 * Domain code never sees `Response` objects — only a typed `ApiResult`. The ApiClient
 * (client.ts) adds auth, single-flight refresh, gzip and simulated network conditions.
 */
import type { ErrorClass, ErrorCode } from '../contracts/error-codes.gen';
import { ERROR_CODES } from '../contracts/error-codes.gen';
import { uuidv7 } from '../ids/uuidv7';
import type { EnvelopeMeta } from './envelope';
import { isEnvelope } from './envelope';

/** Failures that never produced an envelope. */
export type TransportFailure = 'network' | 'timeout' | 'malformed_response';

export type ApiFailure =
  | {
      kind: 'api';
      status: number;
      code: ErrorCode;
      errorClass: ErrorClass;
      message: string;
      details: Record<string, unknown> | undefined;
      /** Some errors carry a result too (e.g. 409 server_copy, 422 quarantined submission). */
      data: unknown;
      retryAfterSeconds: number | null;
      requestId: string | null;
    }
  | {
      kind: TransportFailure;
      /** Transport failures are always retryable and feed the circuit breaker. */
      errorClass: 'transient';
      status: number | null;
      requestId: string;
    };

export type ApiResult<T> =
  | {
      ok: true;
      status: number;
      data: T;
      meta: EnvelopeMeta;
      etag: string | null;
      notModified: boolean;
    }
  | { ok: false; error: ApiFailure };

export interface RequestOptions {
  method?: 'GET' | 'HEAD' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Pre-encoded body (e.g. gzip). The caller sets Content-Type / Content-Encoding. */
  rawBody?: Uint8Array;
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  requestId?: string;
}

/** 30 s suits 3G round trips with a 25-item batch (ADD §12.6). */
export const DEFAULT_TIMEOUT_MS = 30_000;

export function parseRetryAfter(header: string | null, nowMs: number = Date.now()): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(header);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.ceil((date - nowMs) / 1000));
}

const transportFailure = (
  kind: TransportFailure,
  status: number | null,
  requestId: string,
): ApiResult<never> => ({ ok: false, error: { kind, errorClass: 'transient', status, requestId } });

/** Timing of one request, for the network meter (time until the response headers). */
export interface RequestTiming {
  ms: number;
  /** The FieldSync server answered (any status). False: no answer, timeout, or not our server. */
  reached: boolean;
  /** Small request (no or tiny body), so its time approximates a round trip. */
  small: boolean;
}

let timingObserver: ((timing: RequestTiming) => void) | null = null;

/** One observer per context (the page's network meter); null removes it. */
export function setRequestTimingObserver(observer: ((timing: RequestTiming) => void) | null): void {
  timingObserver = observer;
}

const SMALL_BODY_BYTES = 4_096;

export async function requestJson<T>(
  path: string,
  options: RequestOptions = {},
): Promise<ApiResult<T>> {
  const requestId = options.requestId ?? uuidv7();
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onExternalAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onExternalAbort, { once: true });

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-Request-ID': requestId,
    ...options.headers,
  };
  let body: string | ArrayBuffer | undefined;
  if (options.rawBody !== undefined) {
    const raw = options.rawBody;
    body = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  const small =
    (typeof body === 'string' ? body.length : (body?.byteLength ?? 0)) <= SMALL_BODY_BYTES;
  const started = Date.now();
  const report = (reached: boolean) => {
    try {
      timingObserver?.({ ms: Date.now() - started, reached, small });
    } catch {
      // Monitoring must never affect requests.
    }
  };

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(path, {
      method: options.method ?? 'GET',
      headers,
      body,
      signal: controller.signal,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    report(false);
    return transportFailure(timedOut ? 'timeout' : 'network', null, requestId);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }
  // A proxy or captive portal also "answers"; only our envelope proves the server (below).
  const fromServer = response.headers.has('X-Request-ID') || response.status === 304;
  report(fromServer);

  const etag = response.headers.get('ETag');
  const bare = { request_id: requestId, api_version: '1' };
  if (response.status === 304) {
    return { ok: true, status: 304, data: null as T, meta: bare, etag, notModified: true };
  }
  if ((options.method === 'HEAD' || response.status === 204) && response.ok) {
    return {
      ok: true,
      status: response.status,
      data: null as T,
      meta: bare,
      etag,
      notModified: false,
    };
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    parsed = undefined;
  }

  if (!isEnvelope(parsed)) {
    // e.g. a captive-portal HTML page or a proxy error: not our server speaking.
    return transportFailure('malformed_response', response.status, requestId);
  }

  if (parsed.success && response.ok) {
    return {
      ok: true,
      status: response.status,
      data: parsed.data as T,
      meta: parsed.meta,
      etag,
      notModified: false,
    };
  }

  const errorBody = parsed.error;
  if (!errorBody) return transportFailure('malformed_response', response.status, requestId);
  return {
    ok: false,
    error: {
      kind: 'api',
      status: response.status,
      code: errorBody.code,
      errorClass: ERROR_CODES[errorBody.code].class,
      message: errorBody.message,
      details: errorBody.details,
      data: parsed.data,
      retryAfterSeconds: parseRetryAfter(response.headers.get('Retry-After')),
      requestId: parsed.meta.request_id,
    },
  };
}
