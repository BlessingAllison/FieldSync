import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test } from '@playwright/test';

// Helpers poll with page.evaluate rather than page.waitForFunction: the latter needs
// 'unsafe-eval', which our production CSP (correctly) forbids, and we do not want
// bypassCSP — the suite must run under the real policy.

async function waitForServiceWorkerControl(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(async () => {
        await navigator.serviceWorker.ready;
        return navigator.serviceWorker.controller !== null;
      }),
    )
    .toBe(true);
}

/**
 * Axe must judge the settled UI, not a frame from the middle of a fade. CSS/WAAPI
 * animations show up in getAnimations(); Motion's JS-driven frames show up as an
 * intermediate inline opacity.
 */
async function waitForAnimationsToSettle(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const cssSettled = document.getAnimations().every((a) => a.playState !== 'running');
        const motionSettled = Array.from(document.querySelectorAll<HTMLElement>('[style]')).every(
          (el) => ['', '0', '1'].includes(el.style.opacity),
        );
        return cssSettled && motionSettled;
      }),
    )
    .toBe(true);
}

test('app shell loads and the device check reaches the API', async ({ page }) => {
  await page.goto('/device-check');
  await expect(page.getByRole('heading', { name: 'Device check' })).toBeVisible();
  const server = page.locator('[data-check="server"]');
  await expect(server).toHaveAttribute('data-status', 'ok');
  await expect(page.locator('[data-check="crypto"]')).toHaveAttribute('data-status', 'ok');
  await expect(page.locator('[data-check="indexedDb"]')).toHaveAttribute('data-status', 'ok');
});

test('the shell cold-starts offline after the first visit', async ({ page, context }) => {
  await page.goto('/device-check');
  await waitForServiceWorkerControl(page);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Device check' })).toBeVisible();
  await expect(page.getByText('You are offline')).toBeVisible();
  await expect(page.locator('[data-check="serviceWorker"]')).toHaveAttribute('data-status', 'ok');
  // Server unreachable is reported calmly, and data-safety checks still pass offline.
  await expect(page.locator('[data-check="server"]')).toHaveAttribute('data-status', 'fail');
  await expect(page.locator('[data-check="crypto"]')).toHaveAttribute('data-status', 'ok');

  // Deep links resolve offline through the SW navigation route (and lazy chunks are precached).
  await page.goto('/help').catch(() => undefined);
  await expect(page.getByRole('heading', { name: 'Help', level: 1 })).toBeVisible();

  await context.setOffline(false);
  await expect(page.getByText('You are offline')).toBeHidden();
});

test('API responses are never cached and carry security headers', async ({ request }) => {
  const api = await request.get('/api/v1/health/live');
  expect(api.ok()).toBe(true);
  expect(api.headers()['cache-control']).toBe('no-store');
  expect(api.headers()['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  const body = (await api.json()) as { success: boolean; data: unknown };
  expect(body).toMatchObject({ success: true, data: { status: 'ok' } });

  const shell = await request.get('/');
  const csp = shell.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("script-src 'self'");
  expect(csp).not.toContain('unsafe-inline');
  expect(shell.headers()['cache-control']).toBe('no-cache');
});

test('manifest makes the app installable', async ({ request }) => {
  const res = await request.get('/manifest.webmanifest');
  expect(res.ok()).toBe(true);
  const manifest = (await res.json()) as {
    display: string;
    icons: Array<{ sizes: string; purpose?: string }>;
  };
  expect(manifest.display).toBe('standalone');
  const sizes = manifest.icons.map((i) => i.sizes);
  expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
  expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);
});

test('device check has no accessibility violations (light and dark)', async ({ page }) => {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await page.goto('/device-check');
    await expect(page.locator('[data-check="server"]')).not.toHaveAttribute(
      'data-status',
      'checking',
    );
    await waitForServiceWorkerControl(page);
    await waitForAnimationsToSettle(page);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
      .analyze();
    expect(
      results.violations,
      `${colorScheme}: ${JSON.stringify(results.violations, null, 2)}`,
    ).toEqual([]);
  }
});
