/**
 * Page runtime: the single place that wires core services (session, vault, engine,
 * scheduler, API client) to the UI stores. Screens call these functions; they never touch
 * IndexedDB, crypto or fetch directly.
 */
import { ApiClient, type FormTemplate, type UserProfile } from '@/core/api/client';
import { type NetworkProfile, withConditions } from '@/core/api/conditions';
import { SessionService, type SignInResult } from '@/core/auth/session';
import type { FacilityRecord, TemplateRecord } from '@/core/db/schema';
import type { Sealed } from '@/core/crypto/aead';
import { uuidv7 } from '@/core/ids/uuidv7';
import type { Vault } from '@/core/repositories/vault';
import {
  type DraftData,
  QuotaExceededError,
  isQuotaError,
  summarise,
} from '@/core/repositories/vault';
import { SyncEventBus } from '@/core/sync/bus';
import { REPORT_FACILITIES_KEY } from '@/core/sync/device-state';
import { SyncEngine } from '@/core/sync/engine';
import { isStuck, type ServerCopy } from '@/core/sync/types';
import { iterFields, validate } from '@/core/validation/engine';
import type { Payload, TemplateDefinition } from '@/core/validation/types';
import { APP_VERSION } from '@/core/version';
import { SyncScheduler } from '@/platform/scheduler';
import { useApp } from '@/stores/app';
import { EMPTY_COUNTS, recordSimEvent, simLog, useSim, useSync } from '@/stores/sync';

function deviceLabel(): string {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad/.test(ua)
      ? 'iOS'
      : /Mac/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : 'Linux';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  return `${os} · ${browser}`;
}

const bus = new SyncEventBus('page');
const api = new ApiClient({
  appVersion: APP_VERSION,
  fetchImpl: withConditions(
    (input, init) => fetch(input, init),
    () => useSim.getState().profile,
    { onSimulatedDrop: (kind, path) => bus.emit({ type: 'simulated', kind, path }) },
  ),
});
const sessions = new SessionService({ api, deviceLabel });

let vault: Vault | null = null;
let engine: SyncEngine | null = null;
let scheduler: SyncScheduler | null = null;

export const getVault = (): Vault => {
  if (!vault) throw new Error('Vault is locked');
  return vault;
};
export const hasVault = (): boolean => vault !== null;
export { api, bus, sessions };

// ── Queue projection ─────────────────────────────────────────────────────────

export async function refreshCounts(): Promise<void> {
  if (!vault) return;
  const items = await vault.listOutbox();
  const counts = { ...EMPTY_COUNTS };
  const now = Date.now();
  let stuck = 0;
  for (const item of items) {
    counts[item.state] += 1;
    if (isStuck(item, now)) stuck += 1;
  }
  const lastSuccessAt = (await vault.getMeta<number>('lastSuccessAt')) ?? null;
  useSync.setState((s) => ({ counts, stuck, lastSuccessAt, revision: s.revision + 1 }));
}

/**
 * Coalesce count refreshes triggered by engine events: a 500-item drain emits ~1,000 item
 * events and each refresh re-reads the outbox (~60 ms at 4x CPU with 500 queued). Trailing
 * 150 ms, but never later than 1 s after the first pending event, so progress stays visible.
 */
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshFirstAt = 0;
function scheduleRefreshCounts(): void {
  const now = Date.now();
  if (refreshTimer === null) refreshFirstAt = now;
  else clearTimeout(refreshTimer);
  const wait = Math.max(0, Math.min(150, refreshFirstAt + 1_000 - now));
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshCounts();
  }, wait);
}

bus.on((event) => {
  recordSimEvent(event);
  switch (event.type) {
    case 'engine':
      useSync.setState({ engine: event.state });
      break;
    case 'breaker':
      useSync.setState({ breaker: event.state });
      break;
    case 'item':
    case 'queue_changed':
      scheduleRefreshCounts();
      break;
    case 'drained':
      void refreshCounts();
      break;
    case 'auth_required':
      useApp.setState({ notice: { kind: 'session_expired' } });
      break;
    case 'device_revoked':
      void handleRevoked();
      break;
    case 'batch':
    case 'simulated':
      break; // simulator statistics only (recordSimEvent)
  }
});

// ── Session lifecycle ────────────────────────────────────────────────────────

async function onUnlocked(next: Vault, profile: UserProfile): Promise<void> {
  vault = next;
  // CHWs report "alive, nothing waiting" for their assigned facilities; reviewers do not
  // (their scope is the whole county, which would distort per-facility phone counts).
  await next.setMeta(
    REPORT_FACILITIES_KEY,
    profile.role === 'chw' ? profile.facility_ids.map(String) : [],
  );
  const simProfile = (await next.getMeta<NetworkProfile>('simulatorProfile')) ?? 'online';
  useSim.setState({ profile: simProfile });
  engine = new SyncEngine({ vault: next, transport: api, bus });
  scheduler = new SyncScheduler(engine);
  useApp.setState({
    status: 'unlocked',
    profile,
    lockedUser: null,
    uiLocked: false,
    hasPin: await sessions.hasPin(next),
    knownUsers: await sessions.knownUsers(),
  });
  await refreshCounts();
  void next.pruneReceipts(Date.now());
  void refreshReferenceData().finally(() => scheduler?.start());
}

function teardown(): void {
  scheduler?.stop();
  scheduler = null;
  engine = null;
  vault = null;
}

export async function boot(): Promise<void> {
  const restored = await sessions.restore();
  const knownUsers = await sessions.knownUsers();
  if (restored.status === 'unlocked') {
    await onUnlocked(restored.vault, restored.profile);
    // Access token lives in memory only: refresh it in the background (works offline-first).
    void api.refresh().then((outcome) => {
      if (outcome.ok) void sessions.updateProfile(restored.vault, outcome.profile);
      else if (outcome.reason === 'revoked') void handleRevoked();
    });
  } else if (restored.status === 'locked') {
    useApp.setState({ status: 'locked', lockedUser: restored.user, knownUsers });
  } else {
    useApp.setState({ status: 'signed_out', knownUsers });
  }
}

export async function signIn(username: string, password: string): Promise<SignInResult> {
  const result = await sessions.signIn(username, password);
  if (result.ok) {
    await onUnlocked(result.vault, result.profile);
    useApp.setState({ notice: result.online ? null : { kind: 'signed_in_offline' } });
  }
  return result;
}

export async function lock(): Promise<void> {
  if (!vault) return;
  const user = (await sessions.knownUsers()).find((u) => u.userId === vault?.userId) ?? null;
  await sessions.lock(vault);
  teardown();
  useApp.setState({ status: 'locked', lockedUser: user, profile: null, uiLocked: false });
}

export async function switchUser(): Promise<void> {
  if (vault) await sessions.switchUser(vault);
  teardown();
  useApp.setState({
    status: 'signed_out',
    lockedUser: null,
    profile: null,
    knownUsers: await sessions.knownUsers(),
  });
}

export async function signOutAndErase(): Promise<void> {
  if (!vault) return;
  await sessions.signOutAndErase(vault);
  teardown();
  useApp.setState({ status: 'signed_out', profile: null, knownUsers: await sessions.knownUsers() });
}

async function handleRevoked(): Promise<void> {
  const current = vault;
  teardown();
  if (current) await sessions.eraseUser(current.userId, current);
  useApp.setState({
    status: 'signed_out',
    profile: null,
    notice: { kind: 'device_revoked' },
    knownUsers: await sessions.knownUsers(),
  });
}

export function idleLock(): void {
  if (useApp.getState().status === 'unlocked') useApp.setState({ uiLocked: true });
}

export async function unlockWithPin(pin: string): Promise<'ok' | 'wrong' | 'locked_out'> {
  const result = await sessions.verifyPin(getVault(), pin);
  if (result === 'ok') useApp.setState({ uiLocked: false });
  if (result === 'locked_out') await lock();
  return result;
}

export async function unlockUiWithPassword(password: string): Promise<boolean> {
  const profile = useApp.getState().profile;
  if (!profile) return false;
  const result = await sessions.unlockOffline(profile.username, password);
  if (!result.ok) return false;
  vault?.close();
  await onUnlocked(result.vault, result.profile);
  return true;
}

export async function setPin(pin: string | null): Promise<void> {
  if (pin) await sessions.setPin(getVault(), pin);
  else await sessions.clearPin(getVault());
  useApp.setState({ hasPin: Boolean(pin) });
}

// ── Reference data (conditional GETs: ~200-byte 304s on 3G) ─────────────────

const toTemplateRecord = (t: FormTemplate): TemplateRecord => ({
  code: t.code,
  version: t.version,
  id: String(t.id),
  subject: t.subject,
  status: t.status,
  acceptUntil: t.accept_until ?? null,
  definition: t.definition,
  definitionHash: t.definition_hash,
});

export async function refreshReferenceData(): Promise<void> {
  const v = vault;
  if (!v) return;
  const [templates, facilities] = await Promise.all([
    api.templates(await v.getMeta<string>('templatesEtag')),
    api.facilities(await v.getMeta<string>('facilitiesEtag')),
  ]);
  if (templates.ok && !templates.notModified) {
    await v.replaceTemplates(templates.data.map(toTemplateRecord));
    await v.setMeta('templatesEtag', templates.etag);
  }
  if (facilities.ok && !facilities.notModified) {
    await v.replaceFacilities(
      facilities.data.map(
        (f): FacilityRecord => ({
          id: String(f.id),
          code: f.code,
          name: f.name,
          countyCode: f.county.code,
          countyName: f.county.name,
          district: f.district,
          facilityType: f.facility_type,
        }),
      ),
    );
    await v.setMeta('facilitiesEtag', facilities.etag);
  }
  useSync.setState((s) => ({ revision: s.revision + 1 }));
}

export async function templateDefinition(
  code: string,
  version: number,
): Promise<TemplateDefinition | null> {
  const record = await getVault().getTemplate(code, version);
  return record ? (record.definition as TemplateDefinition) : null;
}

// ── Capture ──────────────────────────────────────────────────────────────────

export async function newDraft(
  templateCode: string,
  templateVersion: number,
  facilityId: string,
): Promise<string> {
  const now = Date.now();
  const clientUuid = uuidv7(); // the idempotency key is born with the draft (ADD §12.4)
  await getVault().saveDraft({
    clientUuid,
    templateCode,
    templateVersion,
    facilityId,
    values: {},
    step: 0,
    baseVersion: null,
    createdAt: now,
    updatedAt: now,
  });
  return clientUuid;
}

export async function saveDraft(draft: DraftData): Promise<'ok' | 'storage_full'> {
  try {
    await getVault().saveDraft({ ...draft, updatedAt: Date.now() });
    return 'ok';
  } catch (error) {
    if (isQuotaError(error)) {
      useApp.setState({ notice: { kind: 'storage_full' } });
      return 'storage_full';
    }
    throw error;
  }
}

export type SaveOutcome =
  | { ok: true }
  | { ok: false; reason: 'invalid'; errors: Record<string, string[]> }
  | { ok: false; reason: 'storage_full' };

/** Validate and move the draft into the outbox atomically, then try to send. */
export async function submitDraft(clientUuid: string): Promise<SaveOutcome> {
  const v = getVault();
  const draft = await v.getDraft(clientUuid);
  if (!draft) throw new Error('Draft not found');
  const definition = await templateDefinition(draft.templateCode, draft.templateVersion);
  if (!definition) throw new Error('Template not available on this device');
  const result = validate(definition, draft.values, new Date());
  if (!result.valid) return { ok: false, reason: 'invalid', errors: result.errors };
  const sealedBase = draft.baseVersion ? await v.getMeta<Sealed>(`base:${clientUuid}`) : undefined;
  const base = sealedBase ? await v.open<Payload>('meta', `base:${clientUuid}`, sealedBase) : null;
  try {
    await v.enqueue({
      draft,
      payload: result.normalized,
      summary: summarise(definition, result.normalized),
      capturedAt: draft.createdAt,
      now: Date.now(),
      base,
    });
  } catch (error) {
    if (error instanceof QuotaExceededError || isQuotaError(error)) {
      useApp.setState({ notice: { kind: 'storage_full' } });
      return { ok: false, reason: 'storage_full' };
    }
    throw error;
  }
  if (draft.baseVersion) await v.db.delete('meta', `base:${clientUuid}`);
  await refreshCounts();
  scheduler?.requestSync();
  return { ok: true };
}

/** Edit an already-synced submission: needs the server copy (payloads are purged on ack). */
export async function editSynced(clientUuid: string): Promise<'ok' | 'offline' | 'not_found'> {
  const v = getVault();
  const receipt = await v.getReceipt(clientUuid);
  if (!receipt) return 'not_found';
  const detail = await api.submissionByClient(clientUuid);
  if (!detail.ok) return detail.error.kind === 'api' ? 'not_found' : 'offline';
  const payload = detail.data.payload as Payload;
  await v.setMeta(`base:${clientUuid}`, await v.seal('meta', `base:${clientUuid}`, payload));
  await v.saveDraft({
    clientUuid,
    templateCode: receipt.templateCode,
    templateVersion: detail.data.template.version,
    facilityId: receipt.facilityId,
    values: payload,
    step: 0,
    baseVersion: detail.data.version,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  return 'ok';
}

/** Codes for which resending on the same template version can never succeed. */
const TEMPLATE_GONE = new Set(['template_retired', 'template_unknown']);

/**
 * "Fix & resend": reopen a FAILED item's payload in the form runner. When the server no
 * longer accepts the item's template version, the answers move to the newest published
 * version of the same form held on this phone (the runner then validates them against it;
 * the client UUID is kept, as the server never stored the refused form).
 */
export async function reopenFailed(clientUuid: string): Promise<void> {
  const v = getVault();
  const item = await v.getOutboxItem(clientUuid);
  if (!item || item.state !== 'FAILED') return;
  let payload = await v.outboxPayload(item);
  let templateVersion = item.templateVersion;
  if (item.lastError && TEMPLATE_GONE.has(item.lastError.code)) {
    const newest = (await v.listTemplates())
      .filter((tpl) => tpl.code === item.templateCode && tpl.status === 'published')
      .sort((a, b) => b.version - a.version)[0];
    if (newest && newest.version !== item.templateVersion) {
      templateVersion = newest.version;
      // Answers to questions the new version no longer asks would block saving ('unknown').
      const known = new Set(
        iterFields(newest.definition as TemplateDefinition).map((field) => field.id),
      );
      payload = Object.fromEntries(Object.entries(payload).filter(([id]) => known.has(id)));
    }
  }
  await v.saveDraft({
    clientUuid,
    templateCode: item.templateCode,
    templateVersion,
    facilityId: item.facilityId,
    values: payload,
    step: 0,
    baseVersion: item.baseVersion,
    createdAt: item.capturedAt,
    updatedAt: Date.now(),
  });
}

// ── Sync actions ─────────────────────────────────────────────────────────────

/** "Send now": everything waiting in backoff becomes due immediately, then drain. */
export async function syncNow(): Promise<void> {
  const v = vault;
  if (!v) return;
  const now = Date.now();
  const waiting = (await v.listOutbox()).filter((i) => i.state === 'RETRY_WAIT');
  await v.applyMany(
    waiting.map((i) => ({
      clientUuid: i.clientUuid,
      event: { type: 'manual_retry', now } as const,
    })),
  );
  await scheduler?.syncNow();
}

export async function retryItem(clientUuid: string): Promise<void> {
  await getVault().apply(clientUuid, { type: 'manual_retry', now: Date.now() });
  await refreshCounts();
  void scheduler?.syncNow();
}

export async function discardItem(clientUuid: string): Promise<void> {
  await getVault().apply(clientUuid, { type: 'discard', now: Date.now() });
  await refreshCounts();
}

export interface ConflictView {
  mine: Payload;
  server: ServerCopy;
  base: Payload | null;
}

export async function conflictView(clientUuid: string): Promise<ConflictView | null> {
  const v = getVault();
  const item = await v.getOutboxItem(clientUuid);
  if (!item || item.state !== 'CONFLICT' || !item.conflict) return null;
  return {
    mine: await v.outboxPayload(item),
    server: await v.open<ServerCopy>('outbox-conflict', clientUuid, item.conflict),
    base: await v.outboxBase(item),
  };
}

export async function resolveConflict(
  clientUuid: string,
  choice: { kind: 'server' } | { kind: 'mine' } | { kind: 'merge'; payload: Payload },
): Promise<void> {
  const v = getVault();
  const now = Date.now();
  if (choice.kind === 'server') {
    await v.apply(clientUuid, { type: 'accept_server', now });
  } else {
    const view = await conflictView(clientUuid);
    const item = await v.getOutboxItem(clientUuid);
    if (!view || !item) return;
    const payload = choice.kind === 'mine' ? view.mine : choice.payload;
    const enc = await v.seal('outbox', clientUuid, { payload });
    await v.apply(clientUuid, {
      type: 'resolve',
      now,
      resolution: choice.kind === 'mine' ? 'override' : 'merge',
      baseVersion: view.server.version,
      enc,
      encSummary: item.encSummary,
    });
  }
  await refreshCounts();
  void scheduler?.syncNow();
}

// ── Simulator ────────────────────────────────────────────────────────────────

export async function setSimProfile(profile: NetworkProfile): Promise<void> {
  useSim.setState({ profile });
  await vault?.setMeta('simulatorProfile', profile); // the SW honours it too
  simLog(`Network profile: ${profile}`);
  if (profile !== 'offline') {
    engine?.breaker.nudge();
    void scheduler?.drainNow();
  }
}

export async function simulateSupervisorEdit(clientUuid: string): Promise<boolean> {
  const result = await api.supervisorEdit(clientUuid);
  if (result.ok)
    simLog(
      `Supervisor corrected “${result.data.field}” on the server (now v${result.data.version})`,
      'warn',
    );
  return result.ok;
}

/** Burst generator: N obviously-synthetic, valid forms (simulator / training only). */
export async function addSyntheticForms(count: number): Promise<number> {
  const v = getVault();
  const [facility] = await v.listFacilities();
  const template = (await v.listTemplates()).find((t) => t.subject === 'patient');
  if (!facility || !template) return 0;
  const definition = template.definition as TemplateDefinition;
  const { syntheticPayload } = await import('@/features/simulator/synthetic');
  for (let i = 0; i < count; i += 1) {
    const now = Date.now();
    const values = syntheticPayload(definition, new Date(now));
    const draft: DraftData = {
      clientUuid: uuidv7(),
      templateCode: template.code,
      templateVersion: template.version,
      facilityId: facility.id,
      values,
      step: 0,
      baseVersion: null,
      createdAt: now,
      updatedAt: now,
    };
    await v.enqueue({
      draft,
      payload: values,
      summary: summarise(definition, values),
      capturedAt: now,
      now,
      base: null,
    });
  }
  simLog(`Added ${count} synthetic form${count === 1 ? '' : 's'} to the queue`, 'info');
  await refreshCounts();
  scheduler?.requestSync();
  return count;
}
