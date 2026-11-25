import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { openUserDb } from '../db/schema';
import { uuidv7 } from '../ids/uuidv7';
import { type DraftData, Vault } from '../repositories/vault';
import { FakeLocks, FakeServer } from '../testing/fake-server';
import { SyncEventBus } from './bus';
import { SyncEngine } from './engine';
import type { ServerCopy } from './types';

let now = 1_763_500_000_000;
const clock = () => now;
let dbCounter = 0;

async function makeVault(): Promise<Vault> {
  dbCounter += 1;
  const db = await openUserDb(`engine-test-${dbCounter}-${Math.random()}`);
  const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
  const vault = new Vault(db, dek, 'user-1');
  await vault.replaceFacilities([
    {
      id: 'fac-1',
      code: 'BG-1',
      name: 'Facility',
      countyCode: 'BG',
      countyName: 'Bong',
      district: 'D',
      facilityType: 'clinic',
    },
  ]);
  await vault.setMeta('reportFacilityIds', ['fac-1']);
  return vault;
}

async function enqueue(
  vault: Vault,
  values: Record<string, unknown> = { age_months: 24 },
  clientUuid = uuidv7(),
): Promise<string> {
  const draft: DraftData = {
    clientUuid,
    templateCode: 'iccm-child-u5',
    templateVersion: 1,
    facilityId: 'fac-1',
    values: values as DraftData['values'],
    step: 0,
    baseVersion: null,
    createdAt: now,
    updatedAt: now,
  };
  await vault.saveDraft(draft);
  await vault.enqueue({
    draft,
    payload: draft.values,
    summary: { patientLabel: 'HH-0001-01' },
    capturedAt: now,
    now,
    base: null,
  });
  now += 1;
  return clientUuid;
}

function engineFor(
  vault: Vault,
  server: FakeServer,
  extra: Partial<ConstructorParameters<typeof SyncEngine>[0]> = {},
) {
  return new SyncEngine({
    vault,
    transport: server,
    bus: new SyncEventBus('test', false),
    clock,
    random: () => 0.5,
    locks: null,
    heartbeatIntervalMs: 0,
    ...extra,
  });
}

describe('SyncEngine', () => {
  let vault: Vault;
  let server: FakeServer;
  beforeEach(async () => {
    vault = await makeVault();
    server = new FakeServer();
  });

  it('S1: captures offline, syncs everything once online, purges payloads', async () => {
    server.online = false;
    for (let i = 0; i < 12; i += 1) await enqueue(vault, { age_months: 10 + i });
    const engine = engineFor(vault, server);
    for (let i = 0; i < 3; i += 1) {
      const report = await engine.drain();
      expect(report.state).toBe('PAUSED_OFFLINE');
      now += 10 * 60_000;
    }
    expect(engine.breaker.state).toBe('OPEN');
    expect(server.rows.size).toBe(0);
    const requestsWhileOffline = server.requests;

    // Hours offline: the breaker probes cheaply but sends no submissions; attempts stop growing.
    for (let i = 0; i < 6; i += 1) {
      await engine.drain();
      now += 30 * 60_000;
    }
    expect(server.requests).toBe(requestsWhileOffline);
    expect(Math.max(...(await vault.listOutbox()).map((i) => i.attempts))).toBeLessThanOrEqual(3);

    server.online = true;
    engine.breaker.nudge(); // 'online' event
    const probed = await engine.drain(); // probe succeeds; network-failed items become due after a 0-3 s stagger
    expect(probed.nextDueAt).not.toBeNull();
    now = probed.nextDueAt! + 3_000;
    const report = await engine.drain();
    expect(report.state).toBe('IDLE');
    expect(server.rows.size).toBe(12);
    expect(await vault.listOutbox()).toEqual([]);
    const receipts = await vault.listReceipts();
    expect(receipts.every((r) => r.status === 'synced' && r.serverId)).toBe(true);
  });

  it('S2: a lost acknowledgement is replayed, never duplicated', async () => {
    for (let i = 0; i < 5; i += 1) await enqueue(vault, { age_months: 20 + i });
    server.faults = ['ack_lost'];
    const engine = engineFor(vault, server);
    await engine.drain();
    expect(server.rows.size).toBe(5); // committed server-side
    expect(
      (await vault.listOutbox()).every((i) => i.state === 'RETRY_WAIT' && i.attempts === 1),
    ).toBe(true);
    now += 60_000;
    const report = await engine.drain();
    expect(report.replayed).toBe(5);
    expect(server.rows.size).toBe(5);
    expect(await vault.listOutbox()).toEqual([]);
  });

  it('drains a 500-item backlog in AIMD-sized batches', { timeout: 60_000 }, async () => {
    for (let i = 0; i < 500; i += 1) await enqueue(vault, { age_months: (i % 50) + 2 });
    const report = await engineFor(vault, server).drain();
    expect(report.sent).toBe(500);
    expect(server.rows.size).toBe(500);
    expect(server.requests).toBeLessThan(30);
  });

  it('S3: a stale edit becomes a CONFLICT carrying the encrypted server copy', async () => {
    const id = await enqueue(vault, { age_months: 24 });
    const engine = engineFor(vault, server);
    await engine.drain();
    server.supervisorEdit(id, { age_months: 25 });
    // CHW edits the synced record (base v1) while the supervisor already wrote v2.
    const draft: DraftData = {
      clientUuid: id,
      templateCode: 'iccm-child-u5',
      templateVersion: 1,
      facilityId: 'fac-1',
      values: { age_months: 24, notes: 'x' },
      step: 0,
      baseVersion: 1,
      createdAt: now,
      updatedAt: now,
    };
    await vault.enqueue({
      draft,
      payload: draft.values,
      summary: { patientLabel: null },
      capturedAt: now,
      now,
      base: { age_months: 24 },
    });
    const report = await engine.drain();
    expect(report.conflicts).toBe(1);
    const item = await vault.getOutboxItem(id);
    expect(item?.state).toBe('CONFLICT');
    const copy = await vault.open<ServerCopy>('outbox-conflict', id, item!.conflict!);
    expect(copy).toMatchObject({ version: 2, payload: { age_months: 25 } });

    // Resolve by merging on top of v2 → accepted as v3.
    const enc = await vault.seal('outbox', id, { payload: { age_months: 25, notes: 'x' } });
    await vault.apply(id, {
      type: 'resolve',
      now,
      resolution: 'merge',
      baseVersion: 2,
      enc,
      encSummary: item!.encSummary,
    });
    await engine.drain();
    expect(server.rows.get(id)?.version).toBe(3);
    expect(await vault.getOutboxItem(id)).toBeUndefined();
  });

  it('server-side validation failure → FAILED with field codes; other items unaffected', async () => {
    const bad = await enqueue(vault, { age_months: 70 });
    const good = await enqueue(vault, { age_months: 30 });
    await engineFor(vault, server).drain();
    const item = await vault.getOutboxItem(bad);
    expect(item?.state).toBe('FAILED');
    expect(item?.lastError).toMatchObject({
      code: 'validation_failed',
      fields: { age_months: ['max'] },
    });
    expect(await vault.getOutboxItem(good)).toBeUndefined(); // no head-of-line blocking
  });

  it('honours Retry-After on 503 and counts the attempt', async () => {
    const id = await enqueue(vault);
    server.faults = ['unavailable'];
    const engine = engineFor(vault, server);
    await engine.drain();
    const item = await vault.getOutboxItem(id);
    expect(item).toMatchObject({ state: 'RETRY_WAIT', attempts: 1 });
    expect(item!.nextAttemptAt - now).toBeGreaterThanOrEqual(3_000);
    expect(engine.breaker.state).toBe('CLOSED'); // server answered: network is fine
  });

  it('expired session pauses without counting attempts; revocation stops the engine', async () => {
    const id = await enqueue(vault);
    server.faults = ['auth'];
    const engine = engineFor(vault, server);
    const paused = await engine.drain();
    expect(paused.state).toBe('PAUSED_AUTH');
    expect(await vault.getOutboxItem(id)).toMatchObject({ state: 'PENDING', attempts: 0 });

    server.faults = ['revoked'];
    const revoked = await engine.drain();
    expect(revoked.state).toBe('PAUSED_REVOKED');
  });

  it('recovers items orphaned in SYNCING by a killed tab', async () => {
    const id = await enqueue(vault);
    await vault.apply(id, { type: 'claim', now });
    now += 2 * 60_000; // lease expired
    await engineFor(vault, server).drain();
    expect(server.rows.has(id)).toBe(true);
  });

  it('an edit made while the item is in flight is sent right after the ack', async () => {
    const id = await enqueue(vault, { age_months: 24 });
    let edited = false;
    const transport = {
      ...server,
      submitBatch: async (...args: Parameters<FakeServer['submitBatch']>) => {
        if (!edited) {
          edited = true;
          const enc = await vault.seal('outbox', id, { payload: { age_months: 30 } });
          const item = await vault.getOutboxItem(id);
          await vault.apply(id, { type: 'edit', now, enc, encSummary: item!.encSummary });
        }
        return server.submitBatch(...args);
      },
      heartbeat: server.heartbeat.bind(server),
      probe: server.probe.bind(server),
    };
    await engineFor(vault, server, { transport }).drain();
    expect(server.rows.get(id)).toMatchObject({ version: 2, payload: { age_months: 30 } });
    expect(await vault.getOutboxItem(id)).toBeUndefined();
  });

  it('with the sync lock held, orphaned SYNCING items are recovered without waiting for the lease', async () => {
    const id = await enqueue(vault);
    await vault.apply(id, { type: 'claim', now }); // a tab claimed it, then was killed
    await engineFor(vault, server, { locks: new FakeLocks() }).drain();
    expect(server.rows.has(id)).toBe(true);
  });

  it('only one consumer drains at a time across contexts', async () => {
    for (let i = 0; i < 3; i += 1) await enqueue(vault);
    const locks = new FakeLocks();
    const a = engineFor(vault, server, { locks });
    const b = engineFor(vault, server, { locks });
    const [ra, rb] = await Promise.all([a.drain(), b.drain()]);
    expect([ra.skipped, rb.skipped].sort()).toEqual([false, true]);
    expect(server.rows.size).toBe(3);
  });

  it('reports per-facility queue state, and heartbeats when the queue is empty', async () => {
    server.online = false;
    await enqueue(vault);
    const engine = engineFor(vault, server);
    await engine.drain();
    server.online = true;
    engine.breaker.nudge();
    now += 60 * 60_000;
    await engine.drain();
    const last = server.heartbeats.at(-1);
    expect(last?.facilities[0]).toMatchObject({ facility_id: 'fac-1', pending: 0, failed: 0 });
  });

  it('device state rides on the first batch only, then a post-drain heartbeat reports the truth', {
    timeout: 30_000,
  }, async () => {
    for (let i = 0; i < 40; i += 1) await enqueue(vault, { age_months: (i % 50) + 2 });
    // A large heartbeat interval: the final report must not depend on the interval elapsing.
    const report = await engineFor(vault, server, { heartbeatIntervalMs: 60 * 60_000 }).drain();
    expect(report.sent).toBe(40);
    expect(server.requests).toBeGreaterThan(1); // several batches…
    expect(server.heartbeats).toHaveLength(2); // …but one piggybacked report plus one final
    expect(server.heartbeats[0]?.facilities[0]).toMatchObject({ pending: 40 }); // pre-ack view
    expect(server.heartbeats[1]?.facilities[0]).toMatchObject({ pending: 0, failed: 0 });
  });

  it('a drain with nothing acknowledged sends no extra heartbeat', async () => {
    const engine = engineFor(vault, server, { heartbeatIntervalMs: 60 * 60_000 });
    await engine.drain(); // first ever: interval elapsed since 0 → one heartbeat
    await engine.drain(); // nothing new to report
    expect(server.heartbeats).toHaveLength(1);
  });

  it('writes one sync-log entry per item in a single transaction per batch', async () => {
    for (let i = 0; i < 12; i += 1) await enqueue(vault);
    await engineFor(vault, server).drain();
    const log = await vault.recentLog(100);
    expect(log.filter((e) => e.kind === 'item_created')).toHaveLength(12);
  });
});
