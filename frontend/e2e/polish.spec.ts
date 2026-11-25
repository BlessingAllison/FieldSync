/**
 * Phase 4 quality gates: localisation coverage, reflow, keyboard-only use, SPA focus
 * management, persisted preferences, and accessibility of the Outdoor theme.
 */
import { type Page, expect, test } from '@playwright/test';

import { expectNoA11yViolations, go, signIn, waitForAnimationsToSettle } from './helpers';

const SCREENS = ['/', '/new', '/sync', '/help', '/settings', '/simulator', '/device-check'];

/**
 * Visible text that legitimately is not UI copy: user/seed data (names, facility names,
 * codes, household IDs), numbers, and Intl-formatted dates/times (formatting, not catalogue
 * strings — a real Kpelle locale would come from Intl, not from the message catalogue).
 */
const NOT_UI_COPY = [
  /^[\d\s.,:;%·•×+()\-–—/#]*$/,
  /\(demo\)|Demo (Health Centre|Clinic|Community Post|District Hospital)|Bong|Nimba/,
  /^(BG|NI|MO|LO)-[A-Z]{2}-\d{3}$|^\(?(BG|NI|MO|LO)-|HH-\d{4}-\d{2}/,
  /^FieldSync$/,
  /\b(ago|now|yesterday|today|tomorrow|in \d+ (seconds?|minutes?|hours?|days?))\b/i,
  /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), /,
  /^chw\.|^supervisor\.|^admin$/,
  /^\d{1,2}:\d{2}(:\d{2})?\s?(AM|PM)?$/,
  /^FS-[0-9A-F]{6}$/,
  /^(Receipt code|Support code)?:?\s*FS-/,
  /^v\d+$/,
];

async function untranslatedText(page: Page): Promise<string[]> {
  const texts = await page.evaluate(() => {
    const out: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (
        !parent ||
        parent.closest('script, style, noscript, [aria-hidden="true"], .sr-only, [translate="no"]')
      )
        continue;
      const style = window.getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const text = node.textContent?.trim();
      if (text) out.push(text);
    }
    return out;
  });
  return texts.filter(
    (text) =>
      /[A-Za-z]/.test(text) && !text.includes('⟦kpe⟧') && !NOT_UI_COPY.some((re) => re.test(text)),
  );
}

async function chooseKpelle(page: Page) {
  await page.goto('/login');
  await page.getByText('Kpelle (placeholder)').click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('⟦kpe⟧');
}

test('every visible UI string goes through the catalogue (Kpelle pseudo-locale)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await chooseKpelle(page);
  expect(await untranslatedText(page), 'login').toEqual([]);
  // Sign in with localised labels (the accessible names are pseudo-localised too).
  await page.getByLabel(/Username/).fill('chw.bong.1');
  await page.getByLabel(/Password/).fill(process.env.E2E_PASSWORD ?? 'e2e-Demo-Password-2026');
  await page.locator('form button[type="submit"]').click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 });
  for (const path of SCREENS) {
    await go(page, path);
    await expect(page.locator('main h1').first()).toBeVisible();
    await waitForAnimationsToSettle(page);
    expect(await untranslatedText(page), path).toEqual([]);
  }
  // A form step with inline validation messages.
  await go(page, '/new');
  // Pseudo-localised strings keep the English inside the markers, so names still match.
  await page.getByRole('button', { name: /Sick child visit/ }).click();
  await expect(page.locator('#field-patient_ref')).toBeVisible();
  await page.locator('#field-patient_ref').focus();
  await page.locator('#field-age_months').focus();
  await page.locator('main h1').click(); // blur → inline error shown
  expect(await untranslatedText(page), 'form').toEqual([]);
});

test('no horizontal scrolling at 320 px, in English and with Kpelle text expansion', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 320, height: 720 });
  const overflow = () =>
    page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
  await signIn(page);
  for (const locale of ['English', 'Kpelle (placeholder)']) {
    if (locale !== 'English') {
      await go(page, '/settings');
      await page.getByText(locale).click();
    }
    for (const path of [...SCREENS, '/supervisor']) {
      if (path === '/supervisor') continue; // CHW has no dashboard; covered in the dashboard spec
      await go(page, path);
      await waitForAnimationsToSettle(page);
      expect(await overflow(), `${locale} ${path}`).toBeLessThanOrEqual(1);
    }
  }
});

test('a form can be completed with the keyboard alone', async ({ page }) => {
  await signIn(page);
  await go(page, '/new');
  await page.getByRole('button', { name: /Sick child visit/ }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Child' })).toBeVisible();
  await page.locator('#field-patient_ref').focus();
  await page.keyboard.type('HH-4321-02');
  await page.keyboard.press('Tab'); // − button
  await page.keyboard.press('Tab'); // age input
  await page.keyboard.type('18');
  await page.keyboard.press('Tab'); // +
  await page.keyboard.press('Tab'); // first radio (Girl)
  await page.keyboard.press('Space');
  await page.keyboard.press('Tab'); // date input
  const yesterday = new Date(Date.now() - 86_400_000);
  const dd = String(yesterday.getDate()).padStart(2, '0');
  const mm = String(yesterday.getMonth() + 1).padStart(2, '0');
  await page.keyboard.type(`${dd}${mm}${yesterday.getFullYear()}`);
  await page.getByRole('button', { name: 'Next' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: /Danger signs/ })).toBeVisible();
  await page.locator('#field-fever input[value="no"]').focus();
  await page.keyboard.press('Space');
  await page.getByRole('button', { name: 'Next' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Save form' }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/saved\//);
});

test('navigation moves focus to the new page heading and updates the title', async ({ page }) => {
  await signIn(page);
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: /Sync/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Sync status' })).toBeFocused();
  await expect(page).toHaveTitle('Sync status · FieldSync');
});

test('theme and language persist across reloads, before sign-in', async ({ page }) => {
  await signIn(page);
  await go(page, '/settings');
  await page.getByText('Dark', { exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByText('Kpelle (placeholder)').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'kpe');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('lang', 'kpe');
});

test('Outdoor theme has no accessibility violations', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  await go(page, '/settings');
  await page.getByText('Outdoor (high contrast)').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'outdoor');
  for (const path of ['/', '/new', '/sync', '/help', '/settings', '/simulator']) {
    await go(page, path);
    await expect(page.locator('main h1').first()).toBeVisible();
    await expectNoA11yViolations(page, `outdoor ${path}`);
  }
});
