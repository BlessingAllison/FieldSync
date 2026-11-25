import { create } from 'zustand';

/**
 * Service-worker update state with *update holds*.
 *
 * A new SW never activates on its own (registerType: 'prompt'). Screens that must not be
 * interrupted — the form runner while a draft is open — take a hold; "Update now" is
 * deferred until every hold is released (ADD §12.11).
 */
interface UpdateState {
  updateReady: boolean;
  offlineReady: boolean;
  holds: ReadonlySet<string>;
  applyRequested: boolean;
}

export const useUpdateStore = create<UpdateState>(() => ({
  updateReady: false,
  offlineReady: false,
  holds: new Set<string>(),
  applyRequested: false,
}));

type Activator = () => void;
let activator: Activator | null = null;

export function setActivator(fn: Activator): void {
  activator = fn;
}

function maybeActivate(): void {
  const { updateReady, applyRequested, holds } = useUpdateStore.getState();
  if (updateReady && applyRequested && holds.size === 0 && activator) activator();
}

export function markUpdateReady(): void {
  useUpdateStore.setState({ updateReady: true });
  maybeActivate();
}

export function markOfflineReady(): void {
  useUpdateStore.setState({ offlineReady: true });
}

export function requestUpdate(): void {
  useUpdateStore.setState({ applyRequested: true });
  maybeActivate();
}

/** Take an update hold; returns its release function. */
export function holdUpdates(reason: string): () => void {
  const holds = new Set(useUpdateStore.getState().holds);
  holds.add(reason);
  useUpdateStore.setState({ holds });
  return () => {
    const next = new Set(useUpdateStore.getState().holds);
    next.delete(reason);
    useUpdateStore.setState({ holds: next });
    maybeActivate();
  };
}
