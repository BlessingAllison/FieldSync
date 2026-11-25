import 'fake-indexeddb/auto';

import { describe, expect, it } from 'vitest';

import { openUserDb } from '../db/schema';
import { uuidv7 } from '../ids/uuidv7';
import { SyncEventBus } from '../sync/bus';
import { SyncEngine } from '../sync/engine';
import { FakeServer } from '../testing/fake-server';
import { type DraftData, QuotaExceededError, Vault, isQuotaError } from './vault';

async function vault(): Promise<Vault> {
  const db = await openUserDb(`quota-${Math.random()}`);
  const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
  return new Vault(db, dek, 'user');
}

const quotaError = () => new DOMException('Quota exceeded (simulated)', 'QuotaExceededError');

function draft(): DraftData {
  return {
    clientUuid: uuidv7(),
    templateCode: 't',
    templateVersion: 1,
    facilityId: 'f',
    values: { age_months: 2 },
    step: 0,
    baseVersion: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('storage quota exceeded (ADD §12.10)', () => {
  it('recognises the browser-specific error shapes', () => {
    expect(isQuotaError(quotaError())).toBe(true);
    expect(isQuotaError({ name: 'NS_ERROR_DOM_QUOTA_REACHED' })).toBe(true);
    expect(isQuotaError(new Error('other'))).toBe(false);
  });

  it('autosave surfaces QuotaExceededError instead of failing silently', async () => {
    const v = await vault();
    const put = v.db.put.bind(v.db);
    v.db.put = (() => Promise.reject(quotaError())) as typeof v.db.put;
    await expect(v.saveDraft(draft())).rejects.toBeInstanceOf(QuotaExceededError);
    v.db.put = put;
    await expect(v.saveDraft(draft())).resolves.toBeUndefined();
  });

  it('a full disk while recording results pauses the engine; nothing is lost', async () => {
    const v = await vault();
    const d = draft();
    await v.enqueue({
      draft: d,
      payload: d.values,
      summary: { patientLabel: null },
      capturedAt: 1,
      now: 1,
      base: null,
    });
    const server = new FakeServer();
    const engine = new SyncEngine({
      vault: v,
      transport: server,
      bus: new SyncEventBus('t', false),
      locks: null,
      clock: () => 10,
    });
    const applyMany = v.applyMany.bind(v);
    let calls = 0;
    v.applyMany = (async (entries) => {
      if (entries.length > 0) calls += 1; // lease recovery calls with [] first
      if (calls === 2) throw new QuotaExceededError(); // claim succeeds, writing the ack does not
      return applyMany(entries);
    }) as typeof v.applyMany;
    const report = await engine.drain();
    expect(report.state).toBe('PAUSED_QUOTA');
    expect(server.rows.has(d.clientUuid)).toBe(true); // the server has it (idempotent resend later)
    v.applyMany = applyMany;
    // Space freed: the orphaned SYNCING item is recovered and acknowledged as a replay.
    const retry = await new SyncEngine({
      vault: v,
      transport: server,
      bus: new SyncEventBus('t', false),
      locks: null,
      clock: () => 10 + 120_000,
    }).drain();
    expect(retry.replayed).toBe(1);
    expect(await v.listOutbox()).toEqual([]);
  });
});
