/**
 * Performance measurements for the QA report (ADD §4 budgets). Opt-in:
 *
 *   npx vite --port 5179 --strictPort &            # serves src/ modules for the core benches
 *   PERF=1 PERF_DEV_URL=http://localhost:5179 E2E_BASE_URL=http://localhost:8090 \
 *     PERF_OUT=/tmp/perf.json npx playwright test perf --project=desktop-chromium --workers=1
 *
 * Core benches run the real modules in real Chromium (IndexedDB, Web Crypto) under CDP CPU
 * throttling; page-load benches run the production build (compose) under Slow-3G emulation.
 */
import { writeFileSync } from 'node:fs';

import { type CDPSession, type Page, expect, test } from '@playwright/test';

import { go, signIn, waitForServiceWorkerControl } from './helpers';

import type * as AeadModule from '../src/core/crypto/aead';
import type * as KeyringModule from '../src/core/crypto/keyring';
import type * as SchemaModule from '../src/core/db/schema';
import type * as IdsModule from '../src/core/ids/uuidv7';
import type * as VaultModule from '../src/core/repositories/vault';
import type * as BusModule from '../src/core/sync/bus';
import type * as EngineModule from '../src/core/sync/engine';
import type * as FakeServerModule from '../src/core/testing/fake-server';

const ENABLED = process.env.PERF === '1';
const DEV_URL = process.env.PERF_DEV_URL ?? 'http://localhost:5179';
const results: Record<string, unknown> = {};

test.skip(!ENABLED, 'set PERF=1 to run performance measurements');
test.describe.configure({ mode: 'serial' });
test.setTimeout(600_000);

async function throttle(page: Page, rate: number): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  return cdp;
}

/** Runs inside the page: loads core modules from the dev server and times them. */
async function coreBench(page: Page, rate: number) {
  await page.goto(`${DEV_URL}/device-check`);
  await throttle(page, rate);
  return page.evaluate(async () => {
    const load = (path: string): Promise<unknown> => import(/* @vite-ignore */ path);
    const keyring = (await load('/src/core/crypto/keyring.ts')) as typeof KeyringModule;
    const aead = (await load('/src/core/crypto/aead.ts')) as typeof AeadModule;
    const schema = (await load('/src/core/db/schema.ts')) as typeof SchemaModule;
    const vaultMod = (await load('/src/core/repositories/vault.ts')) as typeof VaultModule;
    const fake = (await load('/src/core/testing/fake-server.ts')) as typeof FakeServerModule;
    const busMod = (await load('/src/core/sync/bus.ts')) as typeof BusModule;
    const engineMod = (await load('/src/core/sync/engine.ts')) as typeof EngineModule;
    const ids = (await load('/src/core/ids/uuidv7.ts')) as typeof IdsModule;

    const stats = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b);
      const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
      return {
        n: s.length,
        p50: +at(0.5).toFixed(2),
        p95: +at(0.95).toFixed(2),
        max: +at(1).toFixed(2),
      };
    };
    const time = async (fn: () => Promise<unknown>) => {
      const t0 = performance.now();
      await fn();
      return performance.now() - t0;
    };
    const out: Record<string, unknown> = {};

    // A. PBKDF2-SHA256 600k: first sign-in (create) and unlocks.
    const escrow = crypto.getRandomValues(new Uint8Array(32));
    let record: KeyringModule.KeyringRecord | undefined;
    out.keyringCreateMs = +(
      await time(async () => {
        record = (await keyring.createKeyring('a-long-test-password', escrow)).record;
      })
    ).toFixed(0);
    if (!record) throw new Error('keyring was not created');
    const created = record;
    const unlocks: number[] = [];
    for (let i = 0; i < 3; i += 1)
      unlocks.push(await time(() => keyring.unlockWithPassword(created, 'a-long-test-password')));
    out.unlockMs = stats(unlocks);

    // B. AES-GCM per record (~1.5 KB payload: a full sick-child visit with notes).
    const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    const payload = {
      patient_ref: 'HH-0042-03',
      age_months: 26,
      sex: 'f',
      visit_date: '2026-11-20',
      fever: true,
      rdt_result: 'positive',
      muac_mm: 118,
      danger_signs: ['chest_indrawing'],
      referred: true,
      followup_on: '2026-11-27',
      caregiver_phone: '+231000012345',
      notes: 'x'.repeat(1200),
    };
    const seals: number[] = [];
    const opens: number[] = [];
    for (let i = 0; i < 300; i += 1) {
      const aad = aead.aadFor('outbox', `k${i}`);
      let sealed: AeadModule.Sealed | undefined;
      seals.push(await time(async () => (sealed = await aead.seal(dek, payload, aad))));
      opens.push(await time(() => aead.open(dek, sealed!, aad)));
    }
    out.sealMs = stats(seals);
    out.openMs = stats(opens);

    // C/D. Encrypted autosave and save (draft → outbox → receipt in one transaction).
    const db = await schema.openUserDb(`perf-${Math.random()}`);
    const vault = new vaultMod.Vault(db, dek, 'perf-user');
    await vault.replaceFacilities([
      {
        id: 'fac-1',
        code: 'BG-1',
        name: 'F',
        countyCode: 'BG',
        countyName: 'Bong',
        district: 'D',
        facilityType: 'clinic',
      },
    ]);
    await vault.setMeta('reportFacilityIds', ['fac-1']);
    const autosaves: number[] = [];
    const saves: number[] = [];
    for (let i = 0; i < 500; i += 1) {
      const draft = {
        clientUuid: ids.uuidv7(),
        templateCode: 'iccm-child-u5',
        templateVersion: 1,
        facilityId: 'fac-1',
        values: payload,
        step: 2,
        baseVersion: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      autosaves.push(await time(() => vault.saveDraft(draft)));
      saves.push(
        await time(() =>
          vault.enqueue({
            draft,
            payload,
            summary: { patientLabel: 'HH-0042-03' },
            capturedAt: Date.now(),
            now: Date.now(),
            base: null,
          }),
        ),
      );
    }
    out.autosaveMs = stats(autosaves);
    out.saveMs = stats(saves);

    // F. Sync screen data with a 500-item queue (decrypts 500 small summaries).
    out.listWithSummaries500Ms = +(await time(() => vault.listOutboxWithSummaries())).toFixed(0);
    // G. What the UI's count refresh costs per call with 500 items queued.
    const lists: number[] = [];
    for (let i = 0; i < 10; i += 1) lists.push(await time(() => vault.listOutbox()));
    out.listOutbox500Ms = stats(lists);

    // E. Drain 500 items: one IDB transaction per batch (current) vs per item (Phase 3 before).
    const drain = async (perItem: boolean) => {
      const dbx = await schema.openUserDb(`perf-drain-${Math.random()}`);
      const vx = new vaultMod.Vault(dbx, dek, 'perf-user');
      await vx.setMeta('reportFacilityIds', ['fac-1']);
      for (let i = 0; i < 500; i += 1) {
        const draft = {
          clientUuid: ids.uuidv7(),
          templateCode: 't',
          templateVersion: 1,
          facilityId: 'fac-1',
          values: { a: i },
          step: 0,
          baseVersion: null,
          createdAt: i,
          updatedAt: i,
        };
        await vx.enqueue({
          draft,
          payload: draft.values,
          summary: { patientLabel: null },
          capturedAt: i,
          now: i,
          base: null,
        });
      }
      if (perItem) {
        const batched = vx.applyMany.bind(vx);
        vx.applyMany = async (entries) => {
          const results: Awaited<ReturnType<VaultModule.Vault['applyMany']>> = [];
          for (const entry of entries) results.push(...(await batched([entry])));
          return results;
        };
      }
      const server = new fake.FakeServer();
      const engine = new engineMod.SyncEngine({
        vault: vx,
        transport: server,
        bus: new busMod.SyncEventBus('perf', false),
        locks: null,
      });
      const ms = await time(() => engine.drain());
      return { ms: +ms.toFixed(0), requests: server.requests, rows: server.rows.size };
    };
    out.drain500Batched = await drain(false);
    out.drain500PerItemTxn = await drain(true);
    return out;
  });
}

test('core: crypto, storage and sync engine (1x and 4x CPU)', async ({ page }) => {
  results.core1x = await coreBench(page, 1);
  results.core4x = await coreBench(page, 4);
});

async function timeToLogin(page: Page): Promise<number> {
  const t0 = Date.now();
  await page.goto('/login', { waitUntil: 'commit' });
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 120_000 });
  return Date.now() - t0;
}

test('page load: Slow 3G (400 kbps, 400 ms RTT) + 4x CPU, cold and repeat', async ({ page }) => {
  const cdp = await throttle(page, 4);
  await cdp.send('Network.enable');
  let bytes = 0;
  cdp.on('Network.loadingFinished', (event: { encodedDataLength: number }) => {
    bytes += event.encodedDataLength;
  });
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 400,
    downloadThroughput: (400 * 1024) / 8,
    uploadThroughput: (400 * 1024) / 8,
  });
  const cold = await timeToLogin(page);
  const coldBytes = bytes;
  await expect
    .poll(() => page.evaluate(async () => (await navigator.serviceWorker.ready).active !== null))
    .toBe(true);
  bytes = 0;
  const repeat = await timeToLogin(page);
  results.pageLoad = {
    coldMs: cold,
    coldTransferKB: Math.round(coldBytes / 1024),
    repeatMs: repeat,
    repeatTransferKB: Math.round(bytes / 1024),
  };
});

test('drain 500 forms through the real API on Slow 3G + 4x CPU (budget: 2 min)', async ({
  page,
  context,
}) => {
  await signIn(page);
  // Like a CHW (checklist 1.4): wait until the app is installed for offline use, then queue
  // 500 synthetic forms while offline, so nothing leaves before the clock starts.
  await waitForServiceWorkerControl(page);
  await context.setOffline(true);
  await go(page, '/simulator');
  await page.getByRole('button', { name: 'Add 500 forms' }).click();
  await expect(page.getByRole('button', { name: 'Add 500 forms' })).toBeEnabled({
    timeout: 120_000,
  });
  await go(page, '/sync');
  await expect(page.getByText(/500 forms waiting to send/).first()).toBeVisible({
    timeout: 120_000,
  });
  const cdp = await throttle(page, 4);
  await cdp.send('Network.enable');
  let uploaded = 0;
  cdp.on('Network.requestWillBeSent', (event: { request: { url: string } }) => {
    if (event.request.url.includes('/submissions/batch')) uploaded += 1;
  });
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 400,
    downloadThroughput: (400 * 1024) / 8,
    uploadThroughput: (400 * 1024) / 8,
  });
  await context.setOffline(false);
  const t0 = Date.now();
  await page.getByRole('button', { name: 'Send now' }).first().click();
  await expect(page.getByText('All forms sent').first()).toBeVisible({ timeout: 300_000 });
  results.drain500Slow3G = { ms: Date.now() - t0, batchRequests: uploaded };
});

test.afterAll(() => {
  const out = process.env.PERF_OUT;
  if (out) writeFileSync(out, JSON.stringify(results, null, 2));
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
});
