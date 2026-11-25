import 'fake-indexeddb/auto';

import { describe, expect, it } from 'vitest';

import { openUserDb } from '../db/schema';
import { uuidv7 } from '../ids/uuidv7';
import { SYNC_LOG_LIMIT, SYNC_LOG_SLACK, Vault } from './vault';

async function makeVault(): Promise<Vault> {
  const db = await openUserDb(`vault-test-${Math.random()}`);
  const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
  return new Vault(db, dek, 'user-1');
}

async function enqueueAt(vault: Vault, at: number): Promise<string> {
  const draft = {
    clientUuid: uuidv7(),
    templateCode: 't',
    templateVersion: 1,
    facilityId: 'fac-1',
    values: { a: at },
    step: 0,
    baseVersion: null,
    createdAt: at,
    updatedAt: at,
  };
  await vault.enqueue({
    draft,
    payload: draft.values,
    summary: { patientLabel: null },
    capturedAt: at,
    now: at,
    base: null,
  });
  return draft.clientUuid;
}

describe('Vault.listDue (bounded)', () => {
  it('returns the oldest due items first, at most `limit`, skipping not-yet-due ones', async () => {
    const vault = await makeVault();
    const ids: string[] = [];
    for (let i = 0; i < 30; i += 1) ids.push(await enqueueAt(vault, 1_000 + i));
    // Push the third item into RETRY_WAIT, due later than `now`.
    await vault.apply(ids[2]!, { type: 'claim', now: 2_000 });
    await vault.apply(ids[2]!, {
      type: 'transient',
      now: 2_000,
      error: { errorClass: 'transient', code: 'x', http: 503, requestId: null, at: 2_000 },
      delayMs: 60_000,
      countsAsAttempt: true,
    });
    const due = await vault.listDue(3_000, 5);
    expect(due.map((d) => d.clientUuid)).toEqual([ids[0], ids[1], ids[3], ids[4], ids[5]]);
    // Once it is due, the older RETRY_WAIT item goes back to the front of the line.
    const later = await vault.listDue(2_000 + 60_000, 3);
    expect(later.map((d) => d.clientUuid)).toEqual([ids[0], ids[1], ids[2]]);
    expect(await vault.listDue(3_000, 0)).toEqual([]);
  });
});

describe('Vault.applyMany (pipelined)', () => {
  it('applies events in order, including several for the same item in one call', async () => {
    const vault = await makeVault();
    const a = await enqueueAt(vault, 1_000);
    const b = await enqueueAt(vault, 1_001);
    const results = await vault.applyMany([
      { clientUuid: a, event: { type: 'claim', now: 2_000 } },
      { clientUuid: b, event: { type: 'claim', now: 2_000 } },
      { clientUuid: a, event: { type: 'ack', now: 2_001, serverId: 's-a', serverVersion: 1 } },
      { clientUuid: 'missing', event: { type: 'claim', now: 2_000 } },
    ]);
    expect(results.map((r) => r?.kind ?? null)).toEqual(['update', 'update', 'synced', null]);
    // a was acknowledged after its claim (it saw the SYNCING state): gone from the outbox.
    const left = await vault.listOutbox();
    expect(left.map((i) => [i.clientUuid, i.state])).toEqual([[b, 'SYNCING']]);
    expect((await vault.getReceipt(a))?.status).toBe('synced');
    expect((await vault.getReceipt(a))?.serverId).toBe('s-a');
  });
});

describe('Vault sync log', () => {
  it('appends batches in one transaction and trims amortised to the limit', async () => {
    const vault = await makeVault();
    const entry = (i: number) => ({ at: i, kind: 'item_created', code: 'created' });
    await vault.logMany(Array.from({ length: SYNC_LOG_LIMIT }, (_, i) => entry(i)));
    await vault.logMany(Array.from({ length: SYNC_LOG_SLACK }, (_, i) => entry(SYNC_LOG_LIMIT + i)));
    // Within the slack: no trim yet.
    expect(await vault.recentLog(5_000)).toHaveLength(SYNC_LOG_LIMIT + SYNC_LOG_SLACK);
    await vault.log(entry(SYNC_LOG_LIMIT + SYNC_LOG_SLACK));
    const all = await vault.recentLog(5_000);
    expect(all).toHaveLength(SYNC_LOG_LIMIT);
    // Oldest entries were dropped; newest first.
    expect(all[0]?.at).toBe(SYNC_LOG_LIMIT + SYNC_LOG_SLACK);
    expect(all.at(-1)?.at).toBe(SYNC_LOG_SLACK + 1);
    expect((await vault.recentLog(3)).map((e) => e.at)).toEqual([1_100, 1_099, 1_098]);
  });
});
