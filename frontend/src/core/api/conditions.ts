/**
 * Simulated network conditions for the offline sync simulator (ADD §16.7).
 *
 * A decorator around `fetch`: the server is REAL — it really commits, replays and reports
 * conflicts — only the network between device and server is simulated. "Ack lost" sends the
 * request, lets the server commit, then throws as if the response never arrived: the exact
 * failure that idempotency keys exist for.
 */
export type NetworkProfile = 'online' | 'offline' | '3g' | 'flaky' | 'server_trouble';

export const NETWORK_PROFILES: readonly NetworkProfile[] = [
  'online',
  'offline',
  '3g',
  'flaky',
  'server_trouble',
];

export const PROFILE_PARAMS = {
  rttMs: 400,
  bytesPerSecond: 50_000, // ≈ 400 kbps
  dropBeforeSend: 0.3,
  ackLost: 0.2,
  serverErrorRate: 0.6,
} as const;

const SYNC_PATHS = ['/api/v1/submissions', '/api/v1/sync/'];

export interface ConditionsHooks {
  onSimulatedDrop?: (kind: 'offline' | 'drop' | 'ack_lost' | 'server_error', path: string) => void;
}

export class SimulatedNetworkError extends TypeError {
  constructor(readonly kind: 'offline' | 'drop' | 'ack_lost') {
    super(`Failed to fetch (simulated: ${kind})`);
  }
}

const pathOf = (input: RequestInfo | URL): string => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return url.startsWith('http') ? new URL(url).pathname : url;
};

const sizeOf = (body: BodyInit | null | undefined): number => {
  if (!body) return 0;
  if (typeof body === 'string') return body.length;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  return 0;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function withConditions(
  base: typeof fetch,
  profile: () => NetworkProfile,
  hooks: ConditionsHooks = {},
  random: () => number = Math.random,
): typeof fetch {
  return async (input, init) => {
    const current = profile();
    const path = pathOf(input);
    if (current === 'online') return base(input, init);
    if (current === 'offline') {
      hooks.onSimulatedDrop?.('offline', path);
      throw new SimulatedNetworkError('offline');
    }
    const isSync = SYNC_PATHS.some((prefix) => path.startsWith(prefix));
    if (current === '3g' || current === 'flaky') {
      await sleep(
        PROFILE_PARAMS.rttMs / 2 + (sizeOf(init?.body) / PROFILE_PARAMS.bytesPerSecond) * 1000,
      );
    }
    if (current === 'flaky' && isSync && random() < PROFILE_PARAMS.dropBeforeSend) {
      hooks.onSimulatedDrop?.('drop', path);
      throw new SimulatedNetworkError('drop');
    }
    let nextInit = init;
    if (current === 'server_trouble' && isSync && random() < PROFILE_PARAMS.serverErrorRate) {
      hooks.onSimulatedDrop?.('server_error', path);
      nextInit = {
        ...init,
        headers: { ...(init?.headers as Record<string, string>), 'X-FS-Simulate': '503' },
      };
    }
    const response = await base(input, nextInit);
    if (current === '3g' || current === 'flaky') await sleep(PROFILE_PARAMS.rttMs / 2);
    if (current === 'flaky' && isSync && random() < PROFILE_PARAMS.ackLost) {
      await response.arrayBuffer().catch(() => undefined); // server has committed; response vanishes
      hooks.onSimulatedDrop?.('ack_lost', path);
      throw new SimulatedNetworkError('ack_lost');
    }
    return response;
  };
}
