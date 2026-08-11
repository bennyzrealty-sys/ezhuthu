/**
 * Offline verification (Phase 8).
 *
 * "Offline-first" was a claim backed by one hand-written list of five paths and
 * nobody checking. These tests are the check, and they are written against the
 * built preview rather than the dev server because the worker does not exist in
 * dev at all (src/pwa/register.ts returns early).
 *
 * The document itself never needs the network — it lives in IndexedDB — so what
 * is under test here is only ever the shell: whether the app can *start* with
 * the network off, and whether everything it lazily reaches for afterwards was
 * cached before it was needed.
 */

import { expect, test, type Page } from '@playwright/test';
import { importCorpus, resetDatabase, SMALL_DOC } from './helpers';

/**
 * Registration is deferred to `load` and precaching happens after that, so
 * "now switch the network off" means nothing until both are done. Controlled
 * is not the same as cached, either: install precaches with
 * `Promise.allSettled`, which degrades per-file rather than failing the whole
 * install (public/sw.js) — so the load-bearing entries are awaited by name.
 * A wait on "the cache is non-empty" left this suite's offline reload racing
 * a cache without index.html in it, which is a blank page and a 30 s timeout.
 */
async function waitForServiceWorker(page: Page): Promise<void> {
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
    timeout: 45_000,
  });
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const names = await caches.keys();
          if (names.length === 0) return [];
          const cache = await caches.open(names[0]!);
          return (await cache.keys()).map((r) => new URL(r.url).pathname);
        }),
      { timeout: 45_000 },
    )
    .toEqual(
      expect.arrayContaining([
        expect.stringMatching(/index\.html$/),
        expect.stringMatching(/assets\/index-.+\.js$/),
        expect.stringMatching(/replay\.worker-.+\.js$/),
        expect.stringMatching(/manjari-regular\.woff2$/),
      ]),
    );
}

test.beforeEach(async ({ page }) => {
  // These tests chain import → worker install → offline reload → edit →
  // reload, each step with its own generous wait; the default 30 s cap is
  // what a single slow step already spends on a busy machine.
  test.setTimeout(120_000);
  await resetDatabase(page);
});

test('the shell is precached from the build, not from a hand-written list', async ({ page }) => {
  await page.goto('/');
  await waitForServiceWorker(page);

  const cached = await page.evaluate(async () => {
    const names = await caches.keys();
    const cache = await caches.open(names[0]!);
    return { names, urls: (await cache.keys()).map((r) => new URL(r.url).pathname) };
  });

  // The development fallback would leave two entries and a cache called
  // `ezhuthu-shell-dev`. Either means the build-time injection did not run.
  expect(cached.names[0]).not.toBe('ezhuthu-shell-dev');
  expect(cached.urls.length).toBeGreaterThan(5);

  // A worker that cached itself would serve the stale copy forever.
  expect(cached.urls.some((u) => u.endsWith('/sw.js'))).toBe(false);
});

test('the app opens with the network off', async ({ page, context }) => {
  await page.goto('/');
  await importCorpus(page, SMALL_DOC);
  await waitForServiceWorker(page);

  await context.setOffline(true);
  await page.reload();

  // The shell came from the cache and the document from IndexedDB.
  await expect(page.locator('.block-row').first()).toContainText('ഒന്നാം', { timeout: 30_000 });
  await expect(page.getByText('words ·')).toBeVisible();
});

test('a paragraph written offline is still there after an offline reload', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await importCorpus(page, SMALL_DOC);
  await waitForServiceWorker(page);

  await context.setOffline(true);
  await page.reload();

  const first = page.locator('.block-row').first();
  await expect(first).toContainText('ഒന്നാം', { timeout: 30_000 });
  await first.click();
  await page.locator('.block-editor').fill('വിമാനത്തിൽ എഴുതിയത്.');
  await page.locator('.block-editor').blur();
  await expect(page.locator('.block-row').first()).toContainText('വിമാനത്തിൽ');

  await page.reload();
  await expect(page.locator('.block-row').first()).toContainText('വിമാനത്തിൽ', {
    timeout: 30_000,
  });
});

test('time-lapse starts on a FIRST offline open', async ({ page, context }) => {
  /*
   * The regression that made the generated manifest necessary. The replay
   * Worker is a separate chunk, fetched only when the panel opens: with a
   * hand-written shell list it was never precached, so it was in the cache
   * only if the writer had happened to open time-lapse while online. Opening
   * it for the first time offline could not start it.
   *
   * Nothing here opens the panel before going offline — that is the point.
   */
  await page.goto('/');
  await importCorpus(page, SMALL_DOC);
  await waitForServiceWorker(page);

  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.block-row').first()).toContainText('ഒന്നാം', { timeout: 30_000 });

  await page.getByTestId('timelapse-toggle').click();
  await expect(page.getByTestId('timelapse-panel')).toBeVisible();
  // The Worker materialised a state and answered: this is the assertion that
  // fails when the chunk is missing, because nothing ever fills the panel.
  await expect(page.getByTestId('timelapse-doc')).toContainText('ഒന്നാം', { timeout: 30_000 });
});

test('the install button is there, and honest, when the browser will not prompt', async ({
  page,
}) => {
  // Headless Chromium fires no `beforeinstallprompt`, so this is the `manual`
  // path — the one iOS Safari and every in-app browser view are permanently
  // on. One tap cannot install here; the button owns up and shows the steps
  // instead of not existing.
  await page.goto('/');

  await page.getByTestId('install').click();
  const help = page.getByTestId('install-help');
  await expect(help).toBeVisible();
  await expect(help).toContainText('Add to Home Screen');
  await expect(help).toContainText('Open in Chrome');

  await help.getByRole('button', { name: 'Close' }).click();
  await expect(help).toHaveCount(0);

  await page.getByRole('button', { name: 'Status', exact: true }).click();
  await expect(page.getByTestId('install-state')).toHaveText('running in a browser tab');
  await expect(page.getByTestId('install-hint')).toContainText('Add to Home Screen');
});
