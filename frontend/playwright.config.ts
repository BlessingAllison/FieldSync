import { defineConfig, devices } from '@playwright/test';

/**
 * E2E runs against the real compose stack (nginx + Django + Postgres), because the
 * behaviours under test — SW precaching, same-origin /api, CSP, offline reload — only
 * exist in the production build. Start it with `make up`.
 */
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:8090';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    serviceWorkers: 'allow',
  },
  projects: [
    { name: 'mobile-chromium', use: { ...devices['Pixel 5'] } },
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
