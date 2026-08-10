import { expect, test } from '@playwright/test';
import { importCorpus, resetDatabase, SMALL_DOC } from './helpers';

test.beforeEach(async ({ page }) => {
  await resetDatabase(page);
});

test.describe('margin bar (ADR-0005, ADR-0027)', () => {
  test('a freshly imported document carries no bars', async ({ page }) => {
    // Import is not editing. Lighting the whole document the instant it arrives
    // would say nothing about where the writer worked (ADR-0027).
    await importCorpus(page, SMALL_DOC);
    await expect(page.locator('.block-row').first()).toContainText('ഒന്നാം');
    await expect(page.locator('.block-mark')).toHaveCount(0);
  });

  test('editing a block gives it a bar that survives a reload', async ({ page }) => {
    await importCorpus(page, SMALL_DOC);

    await page.locator('.block-row').first().click();
    const editor = page.locator('.block-editor');
    await editor.fill('തിരുത്തിയ ഖണ്ഡിക.');
    await editor.blur();
    await expect(page.locator('.block-row').first()).toContainText('തിരുത്തിയ');

    // Exactly one edited block, so exactly one bar.
    await expect(page.locator('.block-mark')).toHaveCount(1);

    // The bar is a pure function of the log, so it is back after a reload with
    // nothing stored for it.
    await page.reload();
    await expect(page.locator('.block-row').first()).toContainText('തിരുത്തിയ');
    await expect(page.locator('.block-mark')).toHaveCount(1);
  });

  test('a just-made edit is at full recency opacity', async ({ page }) => {
    await importCorpus(page, SMALL_DOC);

    await page.locator('.block-row').nth(1).click();
    const editor = page.locator('.block-editor');
    await editor.fill('ഇപ്പോൾ തിരുത്തി.');
    await editor.blur();
    await expect(page.locator('.block-row').nth(1)).toContainText('ഇപ്പോൾ');

    const mark = page.locator('.block-mark');
    await expect(mark).toHaveCount(1);
    // < 1 hour old → the freshest band.
    await expect(mark).toHaveCSS('opacity', '1');
  });
});
