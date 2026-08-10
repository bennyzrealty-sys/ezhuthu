/**
 * The time-lapse scrub (ADR-0009).
 *
 * Driven through the real panel and the real Worker. A test that called
 * `replayTo` directly would pass while the feature was broken in every way that
 * matters — the Worker not loading, the slider not reaching the earliest stop,
 * the window arriving for a moment the panel had left.
 */

import { expect, test } from '@playwright/test';
import { importCorpus, resetDatabase, SMALL_DOC } from './helpers';

test.beforeEach(async ({ page }) => {
  await resetDatabase(page);
});

/** Import, then revise the first paragraph so there is a history to scrub. */
async function importAndRevise(page: import('@playwright/test').Page): Promise<void> {
  await importCorpus(page, SMALL_DOC);

  const first = page.locator('.block-row').first();
  await expect(first).toContainText('ഒന്നാം');
  await first.click();

  const editor = page.locator('.block-editor');
  await editor.fill('തിരുത്തിയ ഒന്നാം ഖണ്ഡിക.');
  await editor.blur();
  await expect(page.locator('.block-row').first()).toContainText('തിരുത്തിയ');
}

test('opens showing the document as it is now', async ({ page }) => {
  await importAndRevise(page);
  await page.getByTestId('timelapse-toggle').click();

  const panel = page.getByTestId('timelapse-panel');
  await expect(panel).toBeVisible();
  // Opening at the present makes the first drag visibly a move backwards.
  await expect(page.getByTestId('timelapse-doc')).toContainText('തിരുത്തിയ');
  await expect(page.getByTestId('timelapse-label')).toContainText('paragraphs');
});

test('scrubbing back shows the paragraph as it was written', async ({ page }) => {
  await importAndRevise(page);
  await page.getByTestId('timelapse-toggle').click();

  const doc = page.getByTestId('timelapse-doc');
  await expect(doc).toContainText('തിരുത്തിയ');

  // All the way back: the import, before the revision.
  await page.getByTestId('timelapse-slider').fill('0');

  await expect(doc).toContainText('ഒന്നാം ഖണ്ഡിക');
  await expect(doc).not.toContainText('തിരുത്തിയ');

  // ...and forward again.
  const stops = await page.getByTestId('timelapse-slider').getAttribute('max');
  await page.getByTestId('timelapse-slider').fill(stops!);
  await expect(doc).toContainText('തിരുത്തിയ');
});

test('a paragraph that has since been deleted comes back', async ({ page }) => {
  await importCorpus(page, 'ഒന്നാം ഖണ്ഡിക.\n\nരണ്ടാം ഖണ്ഡിക.');
  await expect(page.locator('.block-row')).toHaveCount(2);

  // Merge the second into the first — a delete under the covers.
  await page.locator('.block-row').nth(1).click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Backspace');
  // The surviving block is focused, so it is an editor rather than a row —
  // count rendered items, as editing.spec.ts does for the same reason.
  await expect(page.locator('.doc-item')).toHaveCount(1);
  await page.locator('.block-editor').blur();

  await page.getByTestId('timelapse-toggle').click();
  await page.getByTestId('timelapse-slider').fill('0');

  // Two paragraphs again, as they stood.
  await expect(page.getByTestId('timelapse-doc').locator('.past-row')).toHaveCount(2);
});

test('does not touch the document behind it', async ({ page }) => {
  await importAndRevise(page);

  const eventsBefore = await page.evaluate(async () => {
    const request = indexedDB.open('ezhuthu');
    const db: IDBDatabase = await new Promise((resolve) => {
      request.onsuccess = () => resolve(request.result);
    });
    const count: number = await new Promise((resolve) => {
      const r = db.transaction('events').objectStore('events').count();
      r.onsuccess = () => resolve(r.result);
    });
    db.close();
    return count;
  });

  await page.getByTestId('timelapse-toggle').click();
  await page.getByTestId('timelapse-slider').fill('0');
  await expect(page.getByTestId('timelapse-doc')).toContainText('ഒന്നാം');
  await page.getByRole('button', { name: 'Close time-lapse' }).click();

  await expect(page.getByTestId('timelapse-panel')).toHaveCount(0);
  // Reading history appends nothing, and the present is unchanged.
  await expect(page.locator('.block-row').first()).toContainText('തിരുത്തിയ');
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const request = indexedDB.open('ezhuthu');
        const db: IDBDatabase = await new Promise((resolve) => {
          request.onsuccess = () => resolve(request.result);
        });
        const count: number = await new Promise((resolve) => {
          const r = db.transaction('events').objectStore('events').count();
          r.onsuccess = () => resolve(r.result);
        });
        db.close();
        return count;
      }),
    )
    .toBe(eventsBefore);
});

test('offers no slider until there is somewhere to drag to', async ({ page }) => {
  // An import is one instant, so a freshly imported document has exactly one
  // stop. A range input with min === max looks draggable and is not.
  await importCorpus(page, SMALL_DOC);
  await page.getByTestId('timelapse-toggle').click();

  await expect(page.getByTestId('timelapse-single')).toBeVisible();
  await expect(page.getByTestId('timelapse-slider')).toHaveCount(0);
  // ...and the document at that one moment is still shown.
  await expect(page.getByTestId('timelapse-doc')).toContainText('ഒന്നാം');
});

test('says so when there is no history to show', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('timelapse-toggle').click();

  await expect(page.getByTestId('timelapse-panel')).toContainText('no history yet');
  await expect(page.getByTestId('timelapse-slider')).toHaveCount(0);
});

test('closes on Escape', async ({ page }) => {
  await importAndRevise(page);
  await page.getByTestId('timelapse-toggle').click();
  await expect(page.getByTestId('timelapse-panel')).toBeVisible();

  await page.getByTestId('timelapse-slider').press('Escape');
  await expect(page.getByTestId('timelapse-panel')).toHaveCount(0);
});
