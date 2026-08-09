import { defineConfig, devices } from '@playwright/test';

/**
 * Two projects:
 *   - `e2e`  functional tests, desktop + mobile viewports
 *   - `perf` performance budget tests, run separately (`npm run test:perf`)
 *            because they seed an 80k-word corpus and are slow.
 *
 * Chromium is preinstalled in CI images at PLAYWRIGHT_BROWSERS_PATH.
 */
export default defineConfig({
  testDir: 'tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'e2e',
      testDir: 'tests/e2e',
      use: { ...devices['Pixel 7'] },
    },
    {
      name: 'perf',
      testDir: 'tests/perf',
      use: { ...devices['Pixel 7'] },
      timeout: 120_000,
    },
  ],
  webServer: {
    command: 'npm run build && npm run preview -- --port 4173',
    port: 4173,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
