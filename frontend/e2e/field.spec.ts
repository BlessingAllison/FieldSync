/**
 * Field scenarios against the real stack (ADD §2.2, §17): S1 offline capture → reload →
 * reconnect → sync; S2 lost acknowledgement → no duplicate; failed sync → retry; S3 conflict
 * resolution; supervisor dashboard; accessibility of every Phase 3 screen.
 */
import { expect, test } from '@playwright/test';

import {
  captureSickChildForm,
  go,
  expectNoA11yViolations,
  serverSubmission,
  signIn,
  waitForServiceWorkerControl,
} from './helpers';

const household = () =>
  `HH-${String(Math.floor(Math.random() * 9000) + 1000)}-0${Math.floor(Math.random() * 9) + 1}`;

test.describe.configure({ mode: 'serial' });
// Multi-step flows (sign-in with PBKDF2-600k, capture, sync) need more than the 30 s default.
test.setTimeout(60_000);

test('online capture is sent and acknowledged', async ({ page }) => {
  await signIn(page);
  const id = await captureSickChildForm(page, household());
  await expect(page.getByRole('heading', { name: 'Sent to the server' })).toBeVisible({
    timeout: 20_000,
  });
  expect(await serverSubmission(id)).toMatchObject({ version: 1, status: 'accepted' });
});

test('S1: capture offline, reload offline, reconnect, synced exactly once', async ({
  page,
  context,
}) => {
  await signIn(page);
  await waitForServiceWorkerControl(page);
  await context.setOffline(true);
  const id = await captureSickChildForm(page, household(), 30);
  await expect(page.getByRole('heading', { name: 'Saved on this phone' })).toBeVisible();

  // Phone restarts / app reloads while still offline: the session and the queue survive.
  await page.reload();
  await go(page, '/sync');
  await expect(page.getByText('You are offline')).toBeVisible();
  await expect(page.getByText(/1 form waiting to send/).first()).toBeVisible();

  await context.setOffline(false);
  await page.getByRole('button', { name: 'Send now' }).first().click();
  await expect(page.getByText('All forms sent')).toBeVisible({ timeout: 30_000 });
  expect(await serverSubmission(id)).toMatchObject({ version: 1 });
});

test('S2: a lost acknowledgement is replayed, never duplicated', async ({ page }) => {
  await signIn(page);
  let dropped = 0;
  // The request reaches the server (which commits), then the response "vanishes".
  await page.route('**/api/v1/submissions/batch', async (route) => {
    if (dropped === 0) {
      dropped += 1;
      await route.fetch();
      await route.abort('connectionreset');
      return;
    }
    await route.continue();
  });
  const id = await captureSickChildForm(page, household(), 40);
  await expect.poll(() => dropped).toBe(1);
  await go(page, '/sync');
  await page.getByRole('button', { name: 'Send now' }).first().click();
  await expect(page.getByText('All forms sent')).toBeVisible({ timeout: 30_000 });
  // The replayed request created neither a second row nor a second version.
  expect(await serverSubmission(id)).toMatchObject({ version: 1 });
});

test('server trouble: retry with backoff, then recover', async ({ page }) => {
  await signIn(page);
  await go(page, '/simulator');
  await page.getByRole('radio', { name: 'Offline' }).click();
  await captureSickChildForm(page, household(), 12);
  await go(page, '/sync');
  await expect(page.getByText(/waiting to send/).first()).toBeVisible();
  await go(page, '/simulator');
  await page.getByRole('radio', { name: 'Online' }).click();
  await go(page, '/sync');
  await page.getByRole('button', { name: 'Send now' }).first().click();
  await expect(page.getByText('All forms sent')).toBeVisible({ timeout: 30_000 });
});

test('S3: supervisor correction → conflict → combine both', async ({ page }) => {
  await signIn(page);
  const id = await captureSickChildForm(page, household(), 20);
  await expect(page.getByRole('heading', { name: 'Sent to the server' })).toBeVisible({
    timeout: 20_000,
  });

  // CHW opens the sent form for editing: the device fetches v1 and bases the edit on it.
  await go(page, `/sync/${id}`);
  await page.getByRole('button', { name: 'Edit this form' }).click();
  await expect(page).toHaveURL(new RegExp(`/form/${id}`));

  // Meanwhile the supervisor corrects the age on the server (demo endpoint): v2.
  await go(page, '/simulator');
  await page.getByRole('button', { name: 'Supervisor edits the last sent form' }).click();
  await expect(page.getByText(/Supervisor corrected/)).toBeVisible();

  // CHW finishes their edit of the v1 copy and saves.
  await go(page, `/form/${id}`);
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.locator('#field-notes').fill('Follow-up arranged');
  await page.getByRole('button', { name: 'Save form' }).click();
  await expect(page).toHaveURL(/\/saved\//);

  // The server refuses the stale write; the device surfaces it instead of overwriting.
  await go(page, `/sync/${id}`);
  await expect(
    page.getByRole('heading', { name: 'Someone changed this form on the server' }),
  ).toBeVisible({ timeout: 30_000 });
  await expectNoA11yViolations(page, 'conflict');
  await page.getByRole('button', { name: 'Combine both (recommended)' }).click();
  await expect(page).toHaveURL(/\/sync$/);
  await expect(page.getByText('All forms sent')).toBeVisible({ timeout: 30_000 });
  expect(await serverSubmission(id)).toMatchObject({ version: 3 });
});

test('supervisor dashboard explains facility health', async ({ page }) => {
  await signIn(page, 'supervisor.bong');
  await expect(page).toHaveURL(/\/supervisor$/);
  await expect(page.getByRole('heading', { name: 'County sync health' })).toBeVisible();
  // Seeded facilities the E2E suite never writes to (BG-HC-001 is the suite's own facility,
  // so its health legitimately changes as tests add retries and conflicts).
  const card = (code: string) => page.locator('article').filter({ hasText: code });
  await expect(card('BG-CP-003').getByText('Not syncing', { exact: true })).toBeVisible();
  await expect(card('BG-CP-003').getByText('A form has waited 3+ days')).toBeVisible();
  await expect(card('BG-CL-002').getByText('Needs attention', { exact: true })).toBeVisible();
  await expect(card('BG-HO-006').getByText('No data', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Not syncing \(\d+\)$/ }).click(); // filter chip
  await expect(page.locator('article')).toHaveCount(1);
  await expectNoA11yViolations(page, 'dashboard');
});

test('Phase 3 screens have no accessibility violations (light and dark)', async ({ page }) => {
  test.setTimeout(120_000); // 7 screens x 2 themes + a form with errors
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await page.goto('/login');
    await expectNoA11yViolations(page, `${colorScheme} login`);
  }
  await signIn(page);
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    for (const path of ['/', '/new', '/sync', '/help', '/settings', '/simulator']) {
      await page.goto(path);
      await expect(page.locator('main h1').first()).toBeVisible();
      await expectNoA11yViolations(page, `${colorScheme} ${path}`);
    }
    await page.goto('/new');
    await page.getByRole('button', { name: /Sick child visit/ }).click();
    await page.getByRole('button', { name: 'Next' }).click(); // shows inline errors
    await expectNoA11yViolations(page, `${colorScheme} form with errors`);
  }
});
