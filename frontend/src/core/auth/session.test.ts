import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClient } from '../api/client';
import { knownUsers } from '../db/schema';
import type { Sealed } from '../crypto/aead';
import { toBase64Url } from '../util/bytes';
import { FREE_UNLOCK_ATTEMPTS, SessionService } from './session';

let now = 1_763_500_000_000;
const ESCROW = toBase64Url(new Uint8Array(32).fill(7));

/** Minimal /auth/login: one user whose password can be "reset". */
const reply = (body: unknown, init?: ResponseInit) => Promise.resolve(Response.json(body, init));

function fakeServer() {
  const state = {
    password: 'first-password-1',
    online: true,
    userId: crypto.randomUUID(),
    // A second CHW sharing the phone (username → credentials).
    others: {} as Record<string, { password: string; userId: string }>,
  };
  const fetchImpl = vi.fn<typeof fetch>((input, init) => {
    if (!state.online) return Promise.reject(new TypeError('Failed to fetch'));
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/auth/login')) {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        username: string;
        password: string;
        device: { id: string };
      };
      const other = state.others[body.username];
      const expected = other ? other.password : state.password;
      if (body.password !== expected) {
        return reply(
          {
            success: false,
            data: null,
            error: { code: 'invalid_credentials', message: 'x' },
            meta: { request_id: 'r', api_version: '1' },
          },
          { status: 401 },
        );
      }
      return reply({
        success: true,
        error: null,
        meta: { request_id: 'r', api_version: '1' },
        data: {
          access: 'a.b.c',
          access_expires_at: new Date(now + 600_000).toISOString(),
          user: {
            id: other ? other.userId : state.userId,
            username: other ? body.username : 'chw.bong.1',
            display_name: 'CHW',
            role: 'chw',
            county: null,
            facility_ids: [],
            preferred_locale: 'en',
          },
          device: { id: body.device.id, escrow_secret: ESCROW },
        },
      });
    }
    if (url.endsWith('/auth/logout'))
      return reply({
        success: true,
        data: {},
        error: null,
        meta: { request_id: 'r', api_version: '1' },
      });
    return Promise.reject(new Error(`unexpected ${url}`));
  });
  return { state, fetchImpl };
}

function service(fetchImpl: typeof fetch) {
  const api = new ApiClient({ appVersion: 'test', fetchImpl, locks: null, clock: () => now });
  return new SessionService({
    api,
    deviceLabel: () => 'test',
    clock: () => now,
    pbkdf2Iterations: 1_000,
    pinIterations: 1_000,
  });
}

describe('SessionService', () => {
  beforeEach(async () => {
    for (const user of await knownUsers())
      await service(fakeServer().fetchImpl).eraseUser(user.userId, null);
  });

  it('first online sign-in creates an encrypted vault that survives app restarts', async () => {
    const { fetchImpl } = fakeServer();
    const sessions = service(fetchImpl);
    const result = await sessions.signIn('CHW.Bong.1', 'first-password-1');
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    await result.vault.setMeta(
      'probe',
      await result.vault.seal('meta', 'probe', { secret: 'HH-0001-01' }),
    );
    result.vault.close();

    const restored = await sessions.restore();
    expect(restored.status).toBe('unlocked');
    if (restored.status !== 'unlocked') return;
    expect(restored.profile.username).toBe('chw.bong.1');
    const sealed = (await restored.vault.getMeta<Sealed>('probe'))!;
    expect(await restored.vault.open('meta', 'probe', sealed)).toEqual({ secret: 'HH-0001-01' });
  });

  it('lock drops the session handle; offline unlock needs the password', async () => {
    const server = fakeServer();
    const sessions = service(server.fetchImpl);
    const result = await sessions.signIn('chw.bong.1', 'first-password-1');
    if (!result.ok) throw new Error();
    await sessions.lock(result.vault);
    expect((await sessions.restore()).status).toBe('locked');

    server.state.online = false;
    const wrong = await sessions.signIn('chw.bong.1', 'nope');
    expect(wrong).toEqual({ ok: false, error: { kind: 'wrong_password' } });
    const offline = await sessions.signIn('chw.bong.1', 'first-password-1');
    expect(offline.ok && offline.online).toBe(false);
    expect(offline.ok).toBe(true);
  });

  it('rate-limits offline password guessing', async () => {
    const server = fakeServer();
    const sessions = service(server.fetchImpl);
    const result = await sessions.signIn('chw.bong.1', 'first-password-1');
    if (!result.ok) throw new Error();
    await sessions.lock(result.vault);
    server.state.online = false;
    for (let i = 0; i < FREE_UNLOCK_ATTEMPTS; i += 1)
      await sessions.unlockOffline('chw.bong.1', 'guess');
    const blocked = await sessions.unlockOffline('chw.bong.1', 'first-password-1');
    expect(blocked).toMatchObject({ ok: false, error: { kind: 'too_many_attempts' } });
    now += 31_000;
    expect((await sessions.unlockOffline('chw.bong.1', 'first-password-1')).ok).toBe(true);
  });

  it('a supervisor password reset keeps unsynced data via escrow re-wrap', async () => {
    const server = fakeServer();
    const sessions = service(server.fetchImpl);
    const first = await sessions.signIn('chw.bong.1', 'first-password-1');
    if (!first.ok) throw new Error();
    await first.vault.setMeta('unsynced', await first.vault.seal('meta', 'unsynced', 'form-1'));
    await sessions.lock(first.vault);

    server.state.password = 'reset-password-2';
    const second = await sessions.signIn('chw.bong.1', 'reset-password-2');
    if (!second.ok) throw new Error(JSON.stringify(second.error));
    expect(
      await second.vault.open(
        'meta',
        'unsynced',
        (await second.vault.getMeta<Sealed>('unsynced'))!,
      ),
    ).toBe('form-1');
    await sessions.lock(second.vault);
    server.state.online = false;
    expect((await sessions.unlockOffline('chw.bong.1', 'first-password-1')).ok).toBe(false);
    expect((await sessions.unlockOffline('chw.bong.1', 'reset-password-2')).ok).toBe(true);
  });

  it('PIN reopens the UI; five wrong PINs force the password', async () => {
    const sessions = service(fakeServer().fetchImpl);
    const result = await sessions.signIn('chw.bong.1', 'first-password-1');
    if (!result.ok) throw new Error();
    await sessions.setPin(result.vault, '482913');
    expect(await sessions.verifyPin(result.vault, '482913')).toBe('ok');
    for (let i = 0; i < 4; i += 1)
      expect(await sessions.verifyPin(result.vault, '000000')).toBe('wrong');
    expect(await sessions.verifyPin(result.vault, '000000')).toBe('locked_out');
    result.vault.close();
    expect((await sessions.restore()).status).toBe('locked');
  });

  it('sessions expire after 12 hours', async () => {
    const sessions = service(fakeServer().fetchImpl);
    const result = await sessions.signIn('chw.bong.1', 'first-password-1');
    if (!result.ok) throw new Error();
    result.vault.close();
    now += 12 * 60 * 60 * 1000 + 1;
    expect((await sessions.restore()).status).toBe('locked');
  });

  it('sign out & erase crypto-shreds and forgets the account', async () => {
    const sessions = service(fakeServer().fetchImpl);
    const result = await sessions.signIn('chw.bong.1', 'first-password-1');
    if (!result.ok) throw new Error();
    await sessions.signOutAndErase(result.vault);
    expect(await knownUsers()).toEqual([]);
    expect((await sessions.restore()).status).toBe('signed_out');
  });

  it('wrong password online is reported without touching local data', async () => {
    const sessions = service(fakeServer().fetchImpl);
    expect(await sessions.signIn('chw.bong.1', 'bad')).toEqual({
      ok: false,
      error: { kind: 'invalid_credentials' },
    });
    expect(await knownUsers()).toEqual([]);
  });

  it('shared phone: switching user keeps the first CHW\'s unsent forms sealed and intact', async () => {
    const server = fakeServer();
    server.state.others['chw.bong.2'] = { password: 'second-password-2', userId: crypto.randomUUID() };
    const sessions = service(server.fetchImpl);
    const a = await sessions.signIn('chw.bong.1', 'first-password-1');
    if (!a.ok) throw new Error();
    const draft = {
      clientUuid: crypto.randomUUID(),
      templateCode: 'iccm-child-u5',
      templateVersion: 1,
      facilityId: 'fac-1',
      values: { patient_ref: 'HH-0001-01' },
      step: 0,
      baseVersion: null,
      createdAt: now,
      updatedAt: now,
    };
    await a.vault.enqueue({
      draft,
      payload: draft.values,
      summary: { patientLabel: 'HH-0001-01' },
      capturedAt: now,
      now,
      base: null,
    });
    await sessions.switchUser(a.vault);

    // The second CHW gets a separate, empty database; the first CHW's password is not theirs.
    const b = await sessions.signIn('chw.bong.2', 'second-password-2');
    if (!b.ok) throw new Error(JSON.stringify(b));
    expect(b.vault.db.name).not.toBe(a.vault.db.name);
    expect(await b.vault.listOutbox()).toEqual([]);
    await sessions.switchUser(b.vault);
    server.state.online = false;
    expect(await sessions.signIn('chw.bong.1', 'second-password-2')).toEqual({
      ok: false,
      error: { kind: 'wrong_password' },
    });

    // Back to the first CHW, offline: the unsent form is still there and decrypts.
    const again = await sessions.signIn('chw.bong.1', 'first-password-1');
    if (!again.ok) throw new Error();
    const [item] = await again.vault.listOutbox();
    expect(item?.clientUuid).toBe(draft.clientUuid);
    expect(await again.vault.outboxPayload(item!)).toEqual({ patient_ref: 'HH-0001-01' });
  });
});
