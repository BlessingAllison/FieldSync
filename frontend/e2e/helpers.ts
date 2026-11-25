import AxeBuilder from '@axe-core/playwright';
import { type APIRequestContext, type Page, expect, request } from '@playwright/test';

export const PASSWORD = process.env.E2E_PASSWORD ?? 'e2e-Demo-Password-2026';
export const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:8090';

export async function signIn(page: Page, username = 'chw.bong.1'): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // PBKDF2-600k key derivation runs here (once per session).
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 });
}

/** Polls with page.evaluate (waitForFunction would need 'unsafe-eval', which our CSP forbids). */
export async function waitForServiceWorkerControl(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(async () => {
        await navigator.serviceWorker.ready;
        return navigator.serviceWorker.controller !== null;
      }),
    )
    .toBe(true);
}

/** Axe must judge the settled UI, not a frame from the middle of a fade. */
export async function waitForAnimationsToSettle(page: Page): Promise<void> {
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

export async function expectNoA11yViolations(page: Page, label: string): Promise<void> {
  // The first SW install shows a transient toast; scan after it has had its chance to appear.
  await waitForServiceWorkerControl(page);
  await waitForAnimationsToSettle(page);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(results.violations, `${label}: ${JSON.stringify(results.violations, null, 2)}`).toEqual(
    [],
  );
}

/** In-app navigation (no reload): keeps the runtime, its in-flight requests and timers alive. */
export async function go(page: Page, path: string): Promise<void> {
  await page.evaluate((target) => {
    window.history.pushState({}, '', target);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
  await expect(page).toHaveURL(new RegExp(`${path.replace(/[/]/g, '\\/')}$`));
}

const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

/** Fill the illustrative sick-child form (3 steps) and save. Returns the receipt URL id. */
export async function captureSickChildForm(
  page: Page,
  householdId: string,
  ageMonths = 24,
): Promise<string> {
  await go(page, '/new');
  await page.getByRole('button', { name: /Sick child visit/ }).click();
  await expect(page.getByRole('heading', { name: 'Child' })).toBeVisible();
  await page.locator('#field-patient_ref').fill(householdId);
  await page.locator('#field-age_months').fill(String(ageMonths));
  await page.locator('#field-sex').getByText('Girl').click();
  await page.locator('#field-visit_date').fill(yesterday());
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: /Danger signs/ })).toBeVisible();
  await page.locator('#field-fever').getByText('No').click();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: /Treatment/ })).toBeVisible();
  await page.getByRole('button', { name: 'Save form' }).click();
  await expect(page).toHaveURL(/\/saved\//);
  return page.url().split('/saved/')[1] ?? '';
}

const tokens = new Map<string, string>();

async function apiToken(api: APIRequestContext, username: string): Promise<string> {
  const cached = tokens.get(username);
  if (cached) return cached;
  const login = await api.post('/api/v1/auth/login', {
    data: {
      username,
      password: PASSWORD,
      device: { id: crypto.randomUUID(), label: 'e2e-probe', app_version: 'e2e' },
    },
  });
  expect(login.ok(), `probe login for ${username}: HTTP ${login.status()}`).toBe(true);
  const { access } = ((await login.json()) as { data: { access: string } }).data;
  tokens.set(username, access);
  return access;
}

/**
 * Server-side truth for one submission (the API is the authority). `client_uuid` is unique in
 * the database, so "exactly once" means: it exists, and replays added no extra versions.
 */
export async function serverSubmission(
  clientUuid: string,
  username = 'chw.bong.1',
): Promise<{ version: number; status: string } | null> {
  const api = await request.newContext({ baseURL: BASE_URL });
  try {
    const access = await apiToken(api, username);
    const response = await api.get(`/api/v1/submissions/by-client/${clientUuid}`, {
      headers: { Authorization: `Bearer ${access}` },
    });
    if (response.status() === 404) return null;
    expect(response.ok(), `by-client lookup: HTTP ${response.status()}`).toBe(true);
    return ((await response.json()) as { data: { version: number; status: string } }).data;
  } finally {
    await api.dispose();
  }
}
