import { create } from 'zustand';

import type { UserProfile } from '@/core/api/client';
import type { KnownUser } from '@/core/db/schema';

export type AppStatus = 'booting' | 'signed_out' | 'locked' | 'unlocked';

export type Notice =
  | { kind: 'device_revoked' }
  | { kind: 'session_expired' }
  | { kind: 'storage_full' }
  | { kind: 'signed_in_offline' }
  | null;

interface AppState {
  status: AppStatus;
  profile: UserProfile | null;
  knownUsers: KnownUser[];
  lockedUser: KnownUser | null;
  /** UI-only idle lock: session handle still valid, PIN or password re-opens the app. */
  uiLocked: boolean;
  hasPin: boolean;
  notice: Notice;
}

export const useApp = create<AppState>(() => ({
  status: 'booting',
  profile: null,
  knownUsers: [],
  lockedUser: null,
  uiLocked: false,
  hasPin: false,
  notice: null,
}));
