import { useCallback, useEffect, useState } from 'react';

import type { ProbeStatus, StorageInfo } from '@/platform/capabilities';
import {
  probeBackgroundSync,
  probeCrypto,
  probeIndexedDb,
  probePersistence,
  probeServer,
  probeServiceWorker,
  probeStorage,
  requestPersistence,
} from '@/platform/capabilities';

export type CheckId =
  | 'serviceWorker'
  | 'indexedDb'
  | 'crypto'
  | 'persistence'
  | 'storage'
  | 'backgroundSync'
  | 'server';

export const CHECK_ORDER: readonly CheckId[] = [
  'serviceWorker',
  'indexedDb',
  'crypto',
  'persistence',
  'storage',
  'backgroundSync',
  'server',
];

export type CheckResults = Record<CheckId, ProbeStatus | 'checking'>;

const initial = (): CheckResults =>
  Object.fromEntries(CHECK_ORDER.map((id) => [id, 'checking'])) as CheckResults;

export function useDeviceCheck() {
  const [results, setResults] = useState<CheckResults>(initial);
  const [storage, setStorage] = useState<StorageInfo | null>(null);

  const run = useCallback(async () => {
    setResults(initial());
    const set = (id: CheckId, status: ProbeStatus) =>
      setResults((prev) => ({ ...prev, [id]: status }));
    await Promise.all([
      Promise.resolve(probeServiceWorker()).then((s) => set('serviceWorker', s)),
      probeIndexedDb().then((s) => set('indexedDb', s)),
      probeCrypto().then((s) => set('crypto', s)),
      probePersistence().then((s) => set('persistence', s)),
      probeStorage().then(({ status, info }) => {
        setStorage(info);
        set('storage', status);
      }),
      Promise.resolve(probeBackgroundSync()).then((s) => set('backgroundSync', s)),
      probeServer().then((s) => set('server', s)),
    ]);
  }, []);

  useEffect(() => {
    void run();
  }, [run]);

  const protectStorage = useCallback(async () => {
    await requestPersistence();
    setResults((prev) => ({ ...prev, persistence: 'checking' }));
    const status = await probePersistence();
    setResults((prev) => ({ ...prev, persistence: status }));
  }, []);

  return { results, storage, rerun: run, protectStorage };
}
