import { create } from 'zustand';

/**
 * The *device's* view of connectivity (navigator.onLine + events).
 *
 * This only means "a network interface is up" — it says nothing about whether the
 * FieldSync server is reachable (captive Wi-Fi, dead 3G cell). The sync engine's
 * ConnectivityBreaker (Phase 3) owns server reachability; this store only drives the
 * immediate "You are offline" banner.
 */
interface NetworkState {
  online: boolean;
}

export const useNetwork = create<NetworkState>(() => ({
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
}));

export function startNetworkListener(target: Window = window): () => void {
  const update = () => useNetwork.setState({ online: target.navigator.onLine });
  target.addEventListener('online', update);
  target.addEventListener('offline', update);
  update();
  return () => {
    target.removeEventListener('online', update);
    target.removeEventListener('offline', update);
  };
}
