import { defineConfig, devices } from '@playwright/test';

/**
 * E2E tests run against the real stack: `npm run dev` (API on :4000, web on :5173) with a seeded
 * database and ENABLE_DEV_ROUTES=true. Set PLAYWRIGHT_CHROMIUM_EXECUTABLE to use a specific
 * Chromium binary instead of Playwright's downloaded one.
 */
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: executablePath ? { executablePath, args: (process.env.PLAYWRIGHT_CHROMIUM_ARGS ?? '').split(' ').filter(Boolean) } : {},
      },
    },
  ],
});
