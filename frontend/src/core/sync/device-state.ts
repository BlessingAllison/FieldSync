/** Per-facility queue state reported to the server (ADD §12.7, §14). Counts only — no PHI. */
import type { DeviceState } from '../api/client';
import type { Vault } from '../repositories/vault';
import { isStuck } from './types';

/** Meta key: facility ids that always get a (possibly zero) row in device state reports. */
export const REPORT_FACILITIES_KEY = 'reportFacilityIds';

export async function computeDeviceState(vault: Vault, now: number): Promise<DeviceState> {
  const [items, reportIds, lastSuccessAt, lastAttemptAt] = await Promise.all([
    vault.listOutbox(),
    vault.getMeta<string[]>(REPORT_FACILITIES_KEY),
    vault.getMeta<number>('lastSuccessAt'),
    vault.getMeta<number>('lastAttemptAt'),
  ]);
  // Zero rows ("this phone is alive, nothing waiting") only for facilities the user works at
  // as a CHW; otherwise only facilities where this phone actually holds forms.
  type Counts = {
    pending: number;
    failed: number;
    conflicts: number;
    stuck: number;
    oldest: number | null;
  };
  const byFacility = new Map<string, Counts>();
  for (const id of reportIds ?? [])
    byFacility.set(id, { pending: 0, failed: 0, conflicts: 0, stuck: 0, oldest: null });
  for (const item of items) {
    const entry = byFacility.get(item.facilityId) ?? {
      pending: 0,
      failed: 0,
      conflicts: 0,
      stuck: 0,
      oldest: null,
    };
    if (item.state === 'FAILED') entry.failed += 1;
    else if (item.state === 'CONFLICT') entry.conflicts += 1;
    else {
      entry.pending += 1;
      entry.oldest =
        entry.oldest === null ? item.createdAt : Math.min(entry.oldest, item.createdAt);
    }
    if (isStuck(item, now)) entry.stuck += 1;
    byFacility.set(item.facilityId, entry);
  }
  const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);
  return {
    facilities: [...byFacility.entries()].map(([facilityId, e]) => ({
      facility_id: facilityId,
      pending: e.pending,
      failed: e.failed,
      conflicts: e.conflicts,
      stuck: e.stuck,
      oldest_pending_at: iso(e.oldest),
      last_attempt_at: iso(lastAttemptAt),
      last_success_at: iso(lastSuccessAt),
    })),
  };
}
