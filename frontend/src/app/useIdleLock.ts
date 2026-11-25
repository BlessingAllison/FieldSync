import { useEffect } from 'react';

import { idleLock } from '@/app/runtime';
import { useApp } from '@/stores/app';

export const IDLE_LOCK_MS = 5 * 60_000;

/** Lock the UI after 5 minutes without interaction (ADD §11.4.5). */
export function useIdleLock(timeoutMs = IDLE_LOCK_MS): void {
  const status = useApp((s) => s.status);
  useEffect(() => {
    if (status !== 'unlocked') return;
    let timer = setTimeout(idleLock, timeoutMs);
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(idleLock, timeoutMs);
    };
    const events = ['pointerdown', 'keydown', 'touchstart', 'wheel'] as const;
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    return () => {
      clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [status, timeoutMs]);
}
