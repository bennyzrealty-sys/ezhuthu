import { expect, type Page } from '@playwright/test';

export const SMALL_DOC = [
  'ഒന്നാം ഖണ്ഡിക. കടൽ ശാന്തമായിരുന്നു.',
  'രണ്ടാം ഖണ്ഡിക. അവൻ ഒരു software engineer ആണ്.',
  'മൂന്നാം ഖണ്ഡിക. വർഷം തോറും മഴ പെയ്യുന്നു.',
].join('\n\n');

/**
 * Wipe IndexedDB before each test. Tests share an origin, so without this one
 * test's document leaks into the next.
 */
export async function resetDatabase(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate(async () => {
    const databases = (await indexedDB.databases?.()) ?? [{ name: 'ezhuthu' }];
    await Promise.all(
      databases.map(
        (d) =>
          new Promise<void>((resolve) => {
            if (d.name === undefined) return resolve();
            const request = indexedDB.deleteDatabase(d.name);
            request.onsuccess = () => resolve();
            request.onerror = () => resolve();
            request.onblocked = () => resolve();
          }),
      ),
    );
  });
  await page.reload();
}

/**
 * Import text through the real file input rather than a test-only seam, so
 * what the tests exercise is the path a user actually takes.
 */
export async function importCorpus(page: Page, text: string): Promise<void> {
  await page.setInputFiles('[data-testid="import-input"]', {
    name: 'corpus.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(text, 'utf8'),
  });
  await expect(page.locator('.block-row, .block-editor').first()).toBeVisible({ timeout: 60_000 });
}

/** Import a file already on disk — used by the perf suite for the 80k corpus. */
export async function importCorpusFile(page: Page, path: string): Promise<void> {
  await page.setInputFiles('[data-testid="import-input"]', path);
  await expect(page.locator('.block-row, .block-editor').first()).toBeVisible({ timeout: 120_000 });
}
