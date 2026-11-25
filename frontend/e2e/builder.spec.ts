/**
 * Admin form builder end to end: an administrator designs and publishes a new form, and a
 * community health worker on another phone receives it and fills it in. Also the header
 * network meter.
 */
import { type Page, expect, test } from '@playwright/test';

import { expectNoA11yViolations, go, signIn, waitForAnimationsToSettle } from './helpers';

test.setTimeout(120_000);

async function editQuestion(page: Page, label: string, type?: string) {
  await page.getByLabel('Question', { exact: true }).fill(label);
  if (type) await page.getByLabel('Answer type').selectOption({ label: type });
}

test('an admin builds and publishes a form; a field worker receives it and fills it in', async ({
  page,
  browser,
  isMobile,
}) => {
  const name = `Malaria case report ${Date.now().toString(36)}`;
  await signIn(page, 'admin');
  await go(page, '/admin/forms');
  await expect(page.getByRole('heading', { name: 'Form templates' })).toBeVisible();

  // 1. Create the form.
  await page.getByRole('button', { name: 'New form', exact: true }).click();
  await page.getByLabel('Form name').fill(name);
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page).toHaveURL(/\/admin\/forms\/[0-9a-f-]{36}$/, { timeout: 20_000 });

  // 2. Questions: an ID, a yes/no, and a choice shown only when the answer is yes.
  await editQuestion(page, 'Household ID');
  await page.getByRole('checkbox', { name: 'Answer is required' }).check();
  await page.getByRole('button', { name: 'Add question' }).click();
  await editQuestion(page, 'Fever in the last 2 days', 'Yes / No');
  await page.getByRole('button', { name: 'Add question' }).click();
  await editQuestion(page, 'RDT result', 'One choice');
  await page.getByLabel('Choice 1').fill('Positive');
  await page.getByLabel('Choice 2').fill('Negative');
  await page
    .getByRole('combobox', { name: 'Show this question only when…' })
    .first()
    .selectOption({ label: 'Fever in the last 2 days' });
  await expect(page.getByText('All changes saved')).toBeVisible({ timeout: 20_000 });
  await expectNoA11yViolations(page, 'form builder');

  // 3. The live preview uses the field widgets and honours the condition.
  if (isMobile) await page.getByRole('tab', { name: 'Preview' }).click();
  const preview = page.getByRole('tabpanel');
  await expect(preview.getByText('Fever in the last 2 days')).toBeVisible();
  await expect(preview.getByText('RDT result')).toBeHidden();
  await preview.getByText('Yes', { exact: true }).click();
  await expect(preview.getByText('RDT result')).toBeVisible();

  // 4. Publish.
  await page.getByRole('link', { name: 'All forms' }).click();
  const card = page.locator('article').filter({ hasText: name });
  await card.getByRole('button', { name: 'Publish' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Publish' }).click();
  await expect(card.getByText('Published', { exact: true })).toBeVisible({ timeout: 20_000 });

  // 5. A field worker's phone downloads it at sign-in and can use it.
  const phone = await browser.newContext(isMobile ? { viewport: { width: 412, height: 915 } } : {});
  const chw = await phone.newPage();
  await signIn(chw, 'chw.bong.1');
  await go(chw, '/new');
  await chw.getByRole('button', { name: new RegExp(name) }).click();
  await chw.getByLabel('Household ID').fill('HH-1234-01');
  await chw
    .locator('fieldset')
    .filter({ hasText: 'Fever in the last 2 days' })
    .getByText('Yes')
    .click();
  await chw.locator('fieldset').filter({ hasText: 'RDT result' }).getByText('Positive').click();
  await chw.getByRole('button', { name: 'Save form' }).click();
  await expect(
    chw.getByRole('heading', { name: /Saved on this phone|Sent to the server/ }),
  ).toBeVisible();
  await phone.close();
});

test('the header meter shows connection strength, and Offline without network', async ({
  page,
  context,
}) => {
  await signIn(page);
  const meter = page.getByRole('button', { name: /^Connection: / });
  await meter.click();
  const dialog = page.getByRole('dialog', { name: 'Connection' });
  await dialog.getByRole('button', { name: 'Check now' }).click();
  await expect(dialog.getByText(/\d+ ms/)).toBeVisible({ timeout: 15_000 });
  await expect(meter).toHaveAttribute('data-link-status', /^(poor|fair|good|excellent)$/);
  await expectNoA11yViolations(page, 'connection details');
  await dialog.getByRole('button', { name: 'Close' }).click();

  await context.setOffline(true);
  await expect(meter).toHaveAccessibleName('Connection: Offline. Show details');
  await meter.click();
  await expect(dialog.getByText(/No network\. Keep working/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await context.setOffline(false);
  await expect(meter).not.toHaveAttribute('data-link-status', 'offline', { timeout: 15_000 });
});

test('form builder screens never scroll sideways at 320 px, in English and Kpelle', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 720 });
  const overflow = () =>
    page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
  await signIn(page, 'admin');
  for (const locale of ['English', 'Kpelle (placeholder)']) {
    if (locale !== 'English') {
      await go(page, '/settings');
      await page.getByText(locale).click();
    }
    await go(page, '/admin/forms');
    await expect(page.locator('article').first()).toBeVisible();
    await waitForAnimationsToSettle(page);
    expect(await overflow(), `${locale} list`).toBeLessThanOrEqual(1);
    await page.locator('article').first().getByRole('button').first().click();
    await expect(page).toHaveURL(/\/admin\/forms\/[0-9a-f-]{36}$/);
    await page.locator('[aria-controls$="-panel"]').first().click(); // expand a question
    await waitForAnimationsToSettle(page);
    expect(await overflow(), `${locale} editor`).toBeLessThanOrEqual(1);
    await page.getByRole('tab').nth(1).click(); // preview tab
    expect(await overflow(), `${locale} preview`).toBeLessThanOrEqual(1);
  }
});
