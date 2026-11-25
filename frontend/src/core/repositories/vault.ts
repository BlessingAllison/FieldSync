/**
 * Repositories over the per-user database (Repository pattern, ADD §7).
 *
 * A Vault binds an open user database to the unlocked DEK. Screens and the sync engine use
 * these repositories only — encryption is a property of the store, not something each
 * caller must remember. Every PHI-bearing value goes through `seal`/`open` with an AAD
 * naming its store and key.
 */
import { type Sealed, aadFor, open, seal } from '../crypto/aead';
import type {
  DashboardCacheRecord,
  DraftRecord,
  FacilityRecord,
  ReceiptRecord,
  SyncLogEntry,
  TemplateRecord,
  UserDB,
} from '../db/schema';
import { type OutboxEvent, type TransitionResult, transition } from '../sync/states';
import type { ItemSummary, OutboxItem, OutboxState } from '../sync/types';
import type { Payload, TemplateDefinition } from '../validation/types';

export const SYNC_LOG_LIMIT = 1_000;
/** The ring buffer may overshoot by this much before one trim cuts it back to the limit. */
export const SYNC_LOG_SLACK = 100;

export interface DraftData {
  clientUuid: string;
  templateCode: string;
  templateVersion: number;
  facilityId: string;
  values: Payload;
  step: number;
  baseVersion: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface OutboxView {
  item: OutboxItem;
  summary: ItemSummary;
}

export class QuotaExceededError extends Error {
  constructor() {
    super('Device storage is full');
    this.name = 'QuotaExceededError';
  }
}

/** Normalise the several shapes browsers use for "storage full". */
export function isQuotaError(error: unknown): boolean {
  if (error instanceof QuotaExceededError) return true;
  const name = (error as { name?: string } | null)?.name;
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED';
}

async function guard<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (error) {
    if (isQuotaError(error)) throw new QuotaExceededError();
    throw error;
  }
}

/** The patient label shown in lists: the first text field marked `pii` (e.g. household ID). */
export function summarise(definition: TemplateDefinition | null, values: Payload): ItemSummary {
  if (!definition) return { patientLabel: null };
  for (const step of definition.steps) {
    for (const field of step.fields) {
      if (field.pii && field.type === 'text') {
        const value = values[field.id];
        return { patientLabel: typeof value === 'string' && value.trim() ? value.trim() : null };
      }
    }
  }
  return { patientLabel: null };
}

export class Vault {
  constructor(
    readonly db: UserDB,
    private readonly dek: CryptoKey,
    readonly userId: string,
  ) {}

  seal(store: string, key: string, value: unknown): Promise<Sealed> {
    return seal(this.dek, value, aadFor(store, key));
  }

  open<T>(store: string, key: string, sealed: Sealed): Promise<T> {
    return open<T>(this.dek, sealed, aadFor(store, key));
  }

  close(): void {
    this.db.close();
  }

  // ── Meta ────────────────────────────────────────────────────────────────────
  async getMeta<T>(key: string): Promise<T | undefined> {
    return (await this.db.get('meta', key)) as T | undefined;
  }

  setMeta(key: string, value: unknown): Promise<string> {
    return guard(() => this.db.put('meta', value, key));
  }

  // ── Drafts (autosave on every field change) ────────────────────────────────
  async saveDraft(draft: DraftData): Promise<void> {
    const enc = await this.seal('drafts', draft.clientUuid, {
      values: draft.values,
      step: draft.step,
    });
    const record: DraftRecord = {
      clientUuid: draft.clientUuid,
      templateCode: draft.templateCode,
      templateVersion: draft.templateVersion,
      facilityId: draft.facilityId,
      baseVersion: draft.baseVersion,
      createdAt: draft.createdAt,
      updatedAt: draft.updatedAt,
      enc,
    };
    await guard(() => this.db.put('drafts', record));
  }

  async getDraft(clientUuid: string): Promise<DraftData | null> {
    const record = await this.db.get('drafts', clientUuid);
    if (!record) return null;
    const { values, step } = await this.open<{ values: Payload; step: number }>(
      'drafts',
      clientUuid,
      record.enc,
    );
    return {
      clientUuid,
      templateCode: record.templateCode,
      templateVersion: record.templateVersion,
      facilityId: record.facilityId,
      baseVersion: record.baseVersion,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      values,
      step,
    };
  }

  listDrafts(): Promise<DraftRecord[]> {
    return this.db.getAllFromIndex('drafts', 'updatedAt');
  }

  deleteDraft(clientUuid: string): Promise<void> {
    return this.db.delete('drafts', clientUuid);
  }

  // ── Save: draft → outbox (+ receipt) in ONE transaction (ADD §6.2 property 1) ──
  async enqueue(params: {
    draft: DraftData;
    payload: Payload;
    summary: ItemSummary;
    capturedAt: number;
    now: number;
    base: Payload | null;
  }): Promise<OutboxItem> {
    const { draft, payload, summary, capturedAt, now } = params;
    const key = draft.clientUuid;
    const [enc, encSummary, receiptSummary, base] = await Promise.all([
      this.seal('outbox', key, { payload }),
      this.seal('outbox-summary', key, summary),
      this.seal('receipts', key, summary),
      params.base ? this.seal('outbox-base', key, params.base) : Promise.resolve(null),
    ]);
    return guard(async () => {
      const tx = this.db.transaction(['drafts', 'outbox', 'receipts'], 'readwrite');
      const outbox = tx.objectStore('outbox');
      const existing = await outbox.get(key);
      let item: OutboxItem;
      if (existing) {
        // Re-saving an item that is still queued replaces its payload — never a second entry.
        // A FAILED item re-saved after "Fix & resend" goes back in line via the `fix` transition.
        const event: OutboxEvent =
          existing.state === 'FAILED'
            ? { type: 'fix', now, enc, encSummary }
            : { type: 'edit', now, enc, encSummary };
        const result = transition(existing, event);
        if (result.kind !== 'update') throw new Error('unexpected transition result');
        item = result.item;
      } else {
        item = {
          clientUuid: key,
          op: draft.baseVersion ? 'update' : 'create',
          templateCode: draft.templateCode,
          templateVersion: draft.templateVersion,
          facilityId: draft.facilityId,
          state: 'PENDING',
          attempts: 0,
          nextAttemptAt: 0,
          leaseUntil: null,
          baseVersion: draft.baseVersion,
          resolution: 'none',
          dirtyAfterSync: false,
          serverId: null,
          serverVersion: draft.baseVersion,
          lastError: null,
          capturedAt,
          createdAt: now,
          updatedAt: now,
          enc,
          encSummary,
          conflict: null,
          base,
        };
      }
      await outbox.put(item);
      await tx.objectStore('drafts').delete(key);
      const receipts = tx.objectStore('receipts');
      const receipt = await receipts.get(key);
      const next: ReceiptRecord = {
        clientUuid: key,
        templateCode: draft.templateCode,
        templateVersion: draft.templateVersion,
        facilityId: draft.facilityId,
        capturedAt,
        createdAt: receipt?.createdAt ?? now,
        status: 'queued',
        serverId: receipt?.serverId ?? null,
        serverVersion: receipt?.serverVersion ?? null,
        serverStatus: receipt?.serverStatus ?? null,
        syncedAt: receipt?.syncedAt ?? null,
        encSummary: receiptSummary,
      };
      await receipts.put(next);
      await tx.done;
      return item;
    });
  }

  // ── Outbox ─────────────────────────────────────────────────────────────────
  getOutboxItem(clientUuid: string): Promise<OutboxItem | undefined> {
    return this.db.get('outbox', clientUuid);
  }

  async outboxPayload(item: OutboxItem): Promise<Payload> {
    return (await this.open<{ payload: Payload }>('outbox', item.clientUuid, item.enc)).payload;
  }

  outboxSummary(item: OutboxItem): Promise<ItemSummary> {
    return this.open<ItemSummary>('outbox-summary', item.clientUuid, item.encSummary);
  }

  async outboxBase(item: OutboxItem): Promise<Payload | null> {
    return item.base ? this.open<Payload>('outbox-base', item.clientUuid, item.base) : null;
  }

  listOutbox(): Promise<OutboxItem[]> {
    return this.db.getAllFromIndex('outbox', 'createdAt');
  }

  async listOutboxWithSummaries(): Promise<OutboxView[]> {
    const items = await this.listOutbox();
    return Promise.all(
      items.map(async (item) => ({ item, summary: await this.outboxSummary(item) })),
    );
  }

  async countByState(): Promise<Record<OutboxState, number>> {
    const counts: Record<OutboxState, number> = {
      PENDING: 0,
      SYNCING: 0,
      RETRY_WAIT: 0,
      FAILED: 0,
      CONFLICT: 0,
    };
    for (const state of Object.keys(counts) as OutboxState[]) {
      counts[state] = await this.db.countFromIndex(
        'outbox',
        'stateNext',
        IDBKeyRange.bound([state, -Infinity], [state, Infinity]),
      );
    }
    return counts;
  }

  /**
   * Due items, oldest first (FIFO, no head-of-line blocking: FAILED/CONFLICT are skipped).
   * Bounded: reads at most `limit` records per state from the [state, nextAttemptAt] index
   * instead of every due record (a 500-item backlog was re-read and re-sorted every round).
   * Within a state the index orders by due time; for PENDING that is enqueue time, and
   * UUIDv7 keys break ties in creation order.
   */
  async listDue(now: number, limit: number): Promise<OutboxItem[]> {
    if (limit <= 0) return [];
    const tx = this.db.transaction('outbox', 'readonly');
    const index = tx.store.index('stateNext');
    const [pending, retrying] = await Promise.all(
      (['PENDING', 'RETRY_WAIT'] as const).map((state) =>
        index.getAll(IDBKeyRange.bound([state, -Infinity], [state, now]), limit),
      ),
    );
    await tx.done;
    return [...(pending ?? []), ...(retrying ?? [])]
      .sort((a, b) => a.createdAt - b.createdAt || (a.clientUuid < b.clientUuid ? -1 : 1))
      .slice(0, limit);
  }

  /** Earliest time any queued item becomes due (PENDING items may be staggered slightly ahead). */
  async nextDueAt(): Promise<number | null> {
    let earliest: number | null = null;
    for (const state of ['PENDING', 'RETRY_WAIT'] as const) {
      const range = IDBKeyRange.bound([state, -Infinity], [state, Infinity]);
      const first = await this.db.getAllFromIndex('outbox', 'stateNext', range, 1);
      const at = first[0]?.nextAttemptAt;
      if (at !== undefined && (earliest === null || at < earliest)) earliest = at;
    }
    return earliest;
  }

  /**
   * Apply a state-machine event to the CURRENT stored record inside a readwrite transaction,
   * so concurrent edits (UI) and results (engine) never overwrite each other.
   */
  async apply(clientUuid: string, event: OutboxEvent): Promise<TransitionResult | null> {
    const [result] = await this.applyMany([{ clientUuid, event }]);
    return result ?? null;
  }

  /**
   * Apply many events in ONE readwrite transaction (one per batch instead of one per item —
   * the dominant IndexedDB cost on low-end devices). Events must be fully prepared (any
   * encryption done) before calling: a transaction auto-commits if it awaits non-IDB work.
   *
   * Pipelined (Phase 5, measured): all reads are issued at once, then all writes, and only
   * the transaction's completion is awaited. Requests within one transaction execute in
   * issue order, so this is equivalent to the sequential loop, minus ~3 event-loop round
   * trips per item (applyMany was 2/3 of a 500-item drain at 4x CPU). Repeated clientUuids
   * in one call see each other's effects through `latest`.
   */
  async applyMany(
    entries: Array<{
      clientUuid: string;
      event: OutboxEvent;
      receiptPatch?: Partial<ReceiptRecord>;
    }>,
  ): Promise<Array<TransitionResult | null>> {
    if (entries.length === 0) return [];
    return guard(async () => {
      const tx = this.db.transaction(['outbox', 'receipts'], 'readwrite');
      const outbox = tx.objectStore('outbox');
      const receipts = tx.objectStore('receipts');
      const uuids = [...new Set(entries.map((e) => e.clientUuid))];
      const [items, receiptRows] = await Promise.all([
        Promise.all(uuids.map((uuid) => outbox.get(uuid))),
        Promise.all(uuids.map((uuid) => receipts.get(uuid))),
      ]);
      const latest = new Map<string, { item?: OutboxItem; receipt?: ReceiptRecord }>(
        uuids.map((uuid, i) => [uuid, { item: items[i], receipt: receiptRows[i] }]),
      );
      const writes: Array<Promise<unknown>> = [];
      const results: Array<TransitionResult | null> = [];
      for (const { clientUuid, event, receiptPatch } of entries) {
        const row = latest.get(clientUuid)!;
        const current = row.item;
        if (!current) {
          results.push(null);
          continue;
        }
        const result = transition(current, event);
        const receipt = row.receipt;
        let nextReceipt = receipt && receiptPatch ? { ...receipt, ...receiptPatch } : receipt;
        if (result.kind === 'update') {
          writes.push(outbox.put(result.item));
          row.item = result.item;
        } else if (result.kind === 'synced') {
          if (result.requeue) writes.push(outbox.put(result.requeue));
          else writes.push(outbox.delete(clientUuid));
          row.item = result.requeue ?? undefined;
          if (nextReceipt) {
            nextReceipt = {
              ...nextReceipt,
              status: result.requeue ? 'queued' : 'synced',
              serverId: result.serverId || nextReceipt.serverId,
              serverVersion: result.serverVersion,
              syncedAt: event.now,
            };
          }
        } else {
          writes.push(outbox.delete(clientUuid));
          row.item = undefined;
          if (nextReceipt) nextReceipt = { ...nextReceipt, status: 'discarded' };
        }
        if (nextReceipt && nextReceipt !== receipt) {
          writes.push(receipts.put(nextReceipt));
          row.receipt = nextReceipt;
        }
        results.push(result);
      }
      await Promise.all([...writes, tx.done]);
      return results;
    });
  }

  /**
   * Crash recovery: SYNCING items whose lease expired go back in line (ADD §12.7).
   * Pass +Infinity when the caller holds the sync lock (every SYNCING item is orphaned).
   */
  async recoverLeases(now: number): Promise<number> {
    const syncing = await this.db.getAllFromIndex(
      'outbox',
      'stateNext',
      IDBKeyRange.bound(['SYNCING', -Infinity], ['SYNCING', Infinity]),
    );
    const expired = syncing.filter((item) => (item.leaseUntil ?? 0) <= now);
    const at = Number.isFinite(now) ? now : Date.now();
    await this.applyMany(
      expired.map((item) => ({
        clientUuid: item.clientUuid,
        event: { type: 'lease_expired', now: at } as const,
      })),
    );
    return expired.length;
  }

  // ── Receipts ────────────────────────────────────────────────────────────────
  listReceipts(): Promise<ReceiptRecord[]> {
    return this.db.getAllFromIndex('receipts', 'createdAt');
  }

  getReceipt(clientUuid: string): Promise<ReceiptRecord | undefined> {
    return this.db.get('receipts', clientUuid);
  }

  receiptSummary(receipt: ReceiptRecord): Promise<ItemSummary> {
    return this.open<ItemSummary>('receipts', receipt.clientUuid, receipt.encSummary);
  }

  async updateReceipt(clientUuid: string, patch: Partial<ReceiptRecord>): Promise<void> {
    const receipt = await this.db.get('receipts', clientUuid);
    if (receipt) await guard(() => this.db.put('receipts', { ...receipt, ...patch }));
  }

  /** Receipts are kept 30 days after sync, then pruned (ADD §12.8). */
  async pruneReceipts(now: number, maxAgeMs = 30 * 24 * 60 * 60 * 1000): Promise<number> {
    let pruned = 0;
    for (const receipt of await this.listReceipts()) {
      if (receipt.status !== 'queued' && receipt.syncedAt && now - receipt.syncedAt > maxAgeMs) {
        await this.db.delete('receipts', receipt.clientUuid);
        pruned += 1;
      }
    }
    return pruned;
  }

  // ── Reference data (not PHI) ───────────────────────────────────────────────
  async replaceTemplates(templates: TemplateRecord[]): Promise<void> {
    await guard(async () => {
      const tx = this.db.transaction('templates', 'readwrite');
      await tx.store.clear();
      for (const template of templates) await tx.store.put(template);
      await tx.done;
    });
  }

  listTemplates(): Promise<TemplateRecord[]> {
    return this.db.getAll('templates');
  }

  getTemplate(code: string, version: number): Promise<TemplateRecord | undefined> {
    return this.db.get('templates', [code, version]);
  }

  async replaceFacilities(facilities: FacilityRecord[]): Promise<void> {
    await guard(async () => {
      const tx = this.db.transaction('facilities', 'readwrite');
      await tx.store.clear();
      for (const facility of facilities) await tx.store.put(facility);
      await tx.done;
    });
  }

  listFacilities(): Promise<FacilityRecord[]> {
    return this.db.getAll('facilities');
  }

  // ── Sync log (PII-free ring buffer) ────────────────────────────────────────
  log(entry: SyncLogEntry): Promise<void> {
    return this.logMany([entry]);
  }

  /**
   * Append entries in ONE transaction and trim the ring buffer once (a 25-item batch used
   * to cost 25 transactions and 25 counts). Trimming is amortised: it runs only once the
   * buffer exceeds the limit by SYNC_LOG_SLACK, then cuts back to the limit.
   */
  async logMany(entries: SyncLogEntry[]): Promise<void> {
    if (entries.length === 0) return;
    try {
      const tx = this.db.transaction('sync_log', 'readwrite');
      // Pipelined: the count is issued after the adds, so it includes them.
      const adds = entries.map((entry) => tx.store.add(entry));
      const [count] = await Promise.all([tx.store.count(), ...adds]);
      if (count > SYNC_LOG_LIMIT + SYNC_LOG_SLACK) {
        let cursor = await tx.store.openCursor();
        let toDelete = count - SYNC_LOG_LIMIT;
        while (cursor && toDelete > 0) {
          await cursor.delete();
          toDelete -= 1;
          cursor = await cursor.continue();
        }
      }
      await tx.done;
    } catch {
      // Logging must never break syncing (e.g. when storage is full).
    }
  }

  /** Newest first; walks the 'at' index backwards instead of loading the whole buffer. */
  async recentLog(limit = 50): Promise<SyncLogEntry[]> {
    const out: SyncLogEntry[] = [];
    let cursor = await this.db.transaction('sync_log').store.index('at').openCursor(null, 'prev');
    while (cursor && out.length < limit) {
      out.push(cursor.value);
      cursor = await cursor.continue();
    }
    return out;
  }

  // ── Supervisor dashboard snapshot ──────────────────────────────────────────
  cacheDashboard(record: DashboardCacheRecord): Promise<string> {
    return guard(() => this.db.put('dashboard_cache', record));
  }

  getDashboard(scope: string): Promise<DashboardCacheRecord | undefined> {
    return this.db.get('dashboard_cache', scope);
  }
}
