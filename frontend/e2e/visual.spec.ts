/**
 * Visual review harness (ADD §21 Phase 4 exit: 360 / 768 / 1280 px). Runs only when
 * VISUAL_DIR is set; writes full-page screenshots for a human to inspect.
 *   VISUAL_DIR=/tmp/shots npx playwright test visual --project=desktop-chromium
 */
import { type Page, expect, test } from '@playwright/test';

import { captureSickChildForm, go, signIn, waitForAnimationsToSettle } from './helpers';

const DIR = process.env.VISUAL_DIR;
const THEMES = (process.env.VISUAL_THEMES ?? 'light').split(',') as Array<
  'light' | 'dark' | 'outdoor'
>;
const WIDTHS = (process.env.VISUAL_WIDTHS ?? '360,768,1280').split(',').map(Number);

test.skip(!DIR, 'set VISUAL_DIR to capture screenshots');
test.setTimeout(240_000);

async function shot(page: Page, name: string, width: number, theme: string) {
  await waitForAnimationsToSettle(page);
  await page.screenshot({ path: `${DIR}/${theme}-${width}-${name}.png`, fullPage: true });
}

for (const theme of THEMES) {
  for (const width of WIDTHS) {
    test(`screens ${theme} ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width < 700 ? 780 : 900 });
      await page.emulateMedia({ colorScheme: theme === 'dark' ? 'dark' : 'light' });
      await page.goto('/login');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await shot(page, '01-login', width, theme);
      await signIn(page);
      if (theme === 'outdoor') {
        await go(page, '/settings');
        await page.getByText('Outdoor (high contrast)').click();
        await go(page, '/');
      }
      await shot(page, '02-home', width, theme);
      await go(page, '/new');
      await expect(page.getByRole('button', { name: /Sick child visit/ })).toBeVisible();
      await shot(page, '03-new', width, theme);
      await page.getByRole('button', { name: /Sick child visit/ }).click();
      await page.getByRole('button', { name: 'Next' }).click();
      await shot(page, '04-form-errors', width, theme);
      await captureSickChildForm(page, 'HH-2026-11', 24);
      await shot(page, '05-saved', width, theme);
      await go(page, '/sync');
      await shot(page, '06-sync', width, theme);
      await go(page, '/simulator');
      await shot(page, '07-simulator', width, theme);
      await go(page, '/help');
      await shot(page, '08-help', width, theme);
      await go(page, '/settings');
      await shot(page, '09-settings', width, theme);
      await go(page, '/device-check');
      await expect(page.locator('[data-check="server"]')).not.toHaveAttribute(
        'data-status',
        'checking',
      );
      await shot(page, '10-device-check', width, theme);
    });

    test(`dashboard ${theme} ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width < 700 ? 780 : 900 });
      await page.emulateMedia({ colorScheme: theme === 'dark' ? 'dark' : 'light' });
      await signIn(page, 'supervisor.bong');
      if (theme === 'outdoor') {
        await go(page, '/settings');
        await page.getByText('Outdoor (high contrast)').click();
        await go(page, '/supervisor');
      }
      await expect(page.getByRole('heading', { name: 'County sync health' })).toBeVisible();
      await shot(page, '11-dashboard', width, theme);
    });
  }
}
