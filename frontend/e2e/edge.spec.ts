/**
 * Edge cases from the QA brief (ADD §17): empty states, storage quota exceeded during a
 * save, and a session that has expired by the time the phone reconnects.
 */
import { type Page, type Route, expect, test } from '@playwright/test';

import { PASSWORD, go, signIn } from './helpers';

test.setTimeout(60_000);

const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

async function fillSickChildForm(page: Page, householdId: string) {
  await go(page, '/new');
  await page.getByRole('button', { name: /Sick child visit/ }).click();
  await page.locator('#field-patient_ref').fill(householdId);
  await page.locator('#field-age_months').fill('30');
  await page.locator('#field-sex').getByText('Boy').click();
  await page.locator('#field-visit_date').fill(yesterday());
  await page.getByRole('button', { name: 'Next' }).click();
  await page.locator('#field-fever').getByText('No').click();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('button', { name: 'Save form' })).toBeVisible();
}

test('a new device shows explanatory empty states', async ({ page }) => {
  await signIn(page);
  await expect(page.getByText('No forms yet')).toBeVisible();
  await expect(page.getByText('Nothing waiting to send').first()).toBeVisible();
  await go(page, '/sync');
  await expect(page.getByText('Nothing waiting', { exact: true })).toBeVisible();
});

test('storage full during Save: the CHW stays on the form, nothing is lost, retry works', async ({
  page,
}) => {
  // Simulate the phone running out of space for this page's IndexedDB writes.
  await page.addInitScript(() => {
    const flagged = window as unknown as { __fsQuotaFull?: boolean };
    for (const method of ['put', 'add'] as const) {
      const original = IDBObjectStore.prototype[method];
      IDBObjectStore.prototype[method] = function (
        this: IDBObjectStore,
        ...args: Parameters<typeof original>
      ) {
        if (flagged.__fsQuotaFull && this.name !== 'sync_log') {
          throw new DOMException('Quota exceeded (simulated)', 'QuotaExceededError');
        }
        return original.apply(this, args);
      } as typeof original;
    }
  });
  await signIn(page);
  await fillSickChildForm(page, 'HH-7001-01');
  await page.evaluate(() => {
    (window as unknown as { __fsQuotaFull?: boolean }).__fsQuotaFull = true;
  });
  await page.getByRole('button', { name: 'Save form' }).click();
  await expect(page.getByText('Phone storage is full', { exact: false }).first()).toBeVisible();
  await expect(page).toHaveURL(/\/form\//); // never navigated away from unsaved answers

  await page.evaluate(() => {
    (window as unknown as { __fsQuotaFull?: boolean }).__fsQuotaFull = false;
  });
  await page.getByRole('button', { name: 'Save form' }).click();
  await expect(page).toHaveURL(/\/saved\//);
});

test('session expired while offline: forms wait, the CHW signs in again, then they send', async ({
  page,
  context,
}) => {
  await signIn(page);
  const expired = (route: Route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      headers: { 'WWW-Authenticate': 'Bearer realm="fieldsync"' },
      body: JSON.stringify({
        success: false,
        data: null,
        error: { code: 'token_expired', message: 'Your session has expired.' },
        meta: { request_id: null, api_version: '1' },
      }),
    });

  // Away from network long enough for both tokens to expire.
  await context.setOffline(true);
  await fillSickChildForm(page, 'HH-7002-02');
  await page.getByRole('button', { name: 'Save form' }).click();
  await expect(page.getByRole('heading', { name: 'Saved on this phone' })).toBeVisible();

  await page.route('**/api/v1/submissions/batch', expired);
  await page.route('**/api/v1/auth/refresh', expired);
  await context.setOffline(false);
  await go(page, '/sync');
  await page.getByRole('button', { name: 'Send now' }).first().click();

  await expect(
    page.getByText('Sign in again to send your saved forms', { exact: false }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/1 form waiting to send/).first()).toBeVisible();

  // The server would accept a fresh session again.
  await page.unroute('**/api/v1/submissions/batch');
  await page.unroute('**/api/v1/auth/refresh');
  await page.getByRole('button', { name: 'Sign in again' }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 });
  await go(page, '/sync');
  await expect(page.getByText('All forms sent')).toBeVisible({ timeout: 30_000 });
});
