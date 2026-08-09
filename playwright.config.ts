import { defineConfig, devices } from '@playwright/test';

/**
 * Two projects:
 *   - `e2e`  functional tests, desktop + mobile viewports
 *   - `perf` performance budget tests, run separately (`npm run test:perf`)
 *            because they seed an 80k-word corpus and are slow.
 *
 * Chromium is preinstalled in CI images at PLAYWRIGHT_BROWSERS_PATH.
 */
/**
 * Some sandboxes ship a Chromium whose build number does not match the one
 * this Playwright version downloads. Point at it with PLAYWRIGHT_CHROMIUM_PATH
 * rather than hardcoding a machine-specific path into committed config; CI
 * installs its own browser and leaves this unset.
 */
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
const launchOptions = executablePath ? { launchOptions: { executablePath } } : {};

export default defineConfig({
  testDir: 'tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  // The `github` reporter annotates the PR but writes no files, so on its own
  // the failure-artifact upload has nothing to collect.
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'e2e',
      testDir: 'tests/e2e',
      use: { ...devices['Pixel 7'], ...launchOptions },
    },
    {
      name: 'perf',
      testDir: 'tests/perf',
      use: { ...devices['Pixel 7'], ...launchOptions },
      timeout: 180_000,
      /*
       * Serial. The top-level `fullyParallel` runs these two at a time, so
       * each budget was measured against a machine that was simultaneously
       * running another budget — a scroll test competing with a memory test
       * for the same four cores. That inflates every number by an amount that
       * varies with which pair happened to overlap, which is exactly the
       * unreproducibility this suite is excluded from CI to avoid.
       *
       * Playwright parallelises by file when this is off, and the budgets are
       * one file, so this makes the whole suite serial.
       */
      fullyParallel: false,
    },
  ],
  webServer: {
    command: 'npm run build && npm run preview -- --port 4173',
    port: 4173,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
