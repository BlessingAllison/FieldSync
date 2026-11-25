import { describe, expect, it, vi } from 'vitest';

import { parseRetryAfter, requestJson } from './http';

const envelope = (body: Record<string, unknown>) => ({
  success: true,
  data: null,
  error: null,
  meta: { request_id: '0193', api_version: '1' },
  ...body,
});

const respond = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  vi.fn<typeof fetch>().mockResolvedValue(
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    }),
  );

describe('requestJson', () => {
  it('unwraps a success envelope and sends a UUIDv7 request id', async () => {
    const fetchImpl = respond(200, envelope({ data: { status: 'ok' } }));
    const result = await requestJson<{ status: string }>('/api/v1/health/live', { fetchImpl });
    expect(result).toEqual({
      ok: true,
      status: 200,
      data: { status: 'ok' },
      meta: { request_id: '0193', api_version: '1' },
      etag: null,
      notModified: false,
    });
    const init = fetchImpl.mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string>)['X-Request-ID']).toMatch(/^[0-9a-f-]{14}7/);
    expect(init?.credentials).toBe('same-origin');
    expect(init?.cache).toBe('no-store');
  });

  it('classifies API errors from the shared contract', async () => {
    const fetchImpl = respond(
      409,
      envelope({
        success: false,
        error: { code: 'conflict_version', message: 'x', details: { server_version: 4 } },
      }),
    );
    const result = await requestJson('/x', { fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      kind: 'api',
      status: 409,
      code: 'conflict_version',
      errorClass: 'conflict',
      details: { server_version: 4 },
    });
  });

  it('reads Retry-After for transient errors', async () => {
    const fetchImpl = respond(
      503,
      envelope({ success: false, error: { code: 'unavailable', message: 'x' } }),
      { 'Retry-After': '7' },
    );
    const result = await requestJson('/x', { fetchImpl });
    expect(!result.ok && result.error.kind === 'api' && result.error.retryAfterSeconds).toBe(7);
  });

  it('treats a non-envelope body (captive portal) as a transient malformed response', async () => {
    const fetchImpl = respond(200, '<html>Login to Wi-Fi</html>', { 'Content-Type': 'text/html' });
    const result = await requestJson('/x', { fetchImpl });
    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'malformed_response', errorClass: 'transient' },
    });
  });

  it('treats an unknown error code as malformed rather than guessing', async () => {
    const fetchImpl = respond(
      400,
      envelope({ success: false, error: { code: 'new_thing', message: 'x' } }),
    );
    const result = await requestJson('/x', { fetchImpl });
    expect(result).toMatchObject({ ok: false, error: { kind: 'malformed_response' } });
  });

  it('maps fetch rejection to a network failure', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch'));
    const result = await requestJson('/x', { fetchImpl });
    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'network', errorClass: 'transient' },
    });
  });

  it('times out slow requests', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const result = await requestJson('/x', { fetchImpl, timeoutMs: 20 });
    expect(result).toMatchObject({ ok: false, error: { kind: 'timeout' } });
  });

  it('handles HEAD probes without a body', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    const result = await requestJson('/api/v1/health/live', { method: 'HEAD', fetchImpl });
    expect(result.ok).toBe(true);
  });
});

describe('conditional GET', () => {
  it('reports 304 Not Modified', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 304, headers: { ETag: '"abc"' } }));
    const result = await requestJson('/x', { fetchImpl, headers: { 'If-None-Match': '"abc"' } });
    expect(result).toMatchObject({ ok: true, notModified: true, etag: '"abc"' });
  });
});

describe('parseRetryAfter', () => {
  it('parses seconds and HTTP dates', () => {
    expect(parseRetryAfter('12')).toBe(12);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 0)).toBe(10);
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });
});
