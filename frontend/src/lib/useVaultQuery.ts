import { useEffect, useState } from 'react';

import { hasVault } from '@/app/runtime';
import { useSync } from '@/stores/sync';

/** Load data from the vault; reloads whenever the queue changes (sync revision). */
export function useVaultQuery<T>(
  load: () => Promise<T>,
  deps: unknown[] = [],
): { data: T | undefined; loading: boolean } {
  const revision = useSync((s) => s.revision);
  const [state, setState] = useState<{ data: T | undefined; loading: boolean }>({
    data: undefined,
    loading: true,
  });
  useEffect(() => {
    if (!hasVault()) return;
    let alive = true;
    void load().then((data) => {
      if (alive) setState({ data, loading: false });
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, ...deps]);
  return state;
}
