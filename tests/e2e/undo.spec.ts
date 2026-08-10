/**
 * Undo (ADR-0033), through the real button.
 *
 * The unit tests own the rules; these own the wiring — that the button knows
 * when it has something to do, that the document on screen actually changes
 * back, and that it survives a reload, which is the difference between undo and
 * a UI trick.
 */

import { expect, test } from '@playwright/test';
import { countEvents, importCorpus, resetDatabase, SMALL_DOC } from './helpers';

test.beforeEach(async ({ page }) => {
  await resetDatabase(page);
});

async function revise(page: import('@playwright/test').Page, text: string): Promise<void> {
  await page.locator('.block-row').first().click();
  const editor = page.locator('.block-editor');
  await editor.fill(text);
  await editor.blur();
  await expect(page.locator('.block-row').first()).toContainText(text.slice(0, 8));
}

test('is offered only once there is something to undo', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('undo')).toBeDisabled();

  await importCorpus(page, SMALL_DOC);
  await revise(page, 'തിരുത്തിയ ഒന്നാം ഖണ്ഡിക.');

  await expect(page.getByTestId('undo')).toBeEnabled();
});

test('puts an edited paragraph back, and it stays back', async ({ page }) => {
  await importCorpus(page, SMALL_DOC);
  await revise(page, 'തിരുത്തിയ ഒന്നാം ഖണ്ഡിക.');

  await page.getByTestId('undo').click();

  const first = page.locator('.block-row').first();
  await expect(first).toContainText('ഒന്നാം ഖണ്ഡിക. കടൽ');
  await expect(first).not.toContainText('തിരുത്തിയ');

  // Stored, not merely re-rendered.
  await page.reload();
  await expect(page.locator('.block-row').first()).not.toContainText('തിരുത്തിയ');
});

test('steps back through several edits, one press each', async ({ page }) => {
  await importCorpus(page, SMALL_DOC);
  await revise(page, 'ആദ്യ തിരുത്ത് ഇവിടെ.');
  await revise(page, 'രണ്ടാം തിരുത്ത് ഇവിടെ.');

  const first = page.locator('.block-row').first();
  await page.getByTestId('undo').click();
  await expect(first).toContainText('ആദ്യ തിരുത്ത്');

  await page.getByTestId('undo').click();
  await expect(first).toContainText('ഒന്നാം ഖണ്ഡിക');
});

test('appends rather than erasing — the log grows', async ({ page }) => {
  await importCorpus(page, SMALL_DOC);
  await revise(page, 'തിരുത്തിയ ഒന്നാം ഖണ്ഡിക.');
  const before = await countEvents(page);

  await page.getByTestId('undo').click();
  await expect(page.locator('.block-row').first()).not.toContainText('തിരുത്തിയ');

  // Rule 1: history keeps both the change and the taking of it back.
  await expect.poll(() => countEvents(page)).toBe(before + 1);
});

test('takes a whole split back in one press', async ({ page }) => {
  await importCorpus(page, 'ഒന്ന് രണ്ട് മൂന്ന്\n\nനാല്');
  const before = await page.locator('.doc-item').count();

  await page.locator('.block-row').first().click();
  await page.keyboard.press('Home');
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(page.locator('.doc-item')).toHaveCount(before + 1);
  await page.locator('.block-editor').blur();

  await page.getByTestId('undo').click();

  // One action, one press — not "undo the insert, then undo the update".
  await expect(page.locator('.doc-item')).toHaveCount(before);
  await expect(page.locator('.block-row').first()).toContainText('ഒന്ന് രണ്ട് മൂന്ന്');
});

test('brings back a deleted paragraph', async ({ page }) => {
  await importCorpus(page, SMALL_DOC);
  await page.locator('.block-row').nth(1).click();
  await page.getByTestId('block-delete').click();
  await expect(page.locator('.block-row')).toHaveCount(2);

  await page.getByTestId('undo').click();

  await expect(page.locator('.block-row')).toHaveCount(3);
  await expect(page.locator('.block-row').nth(1)).toContainText('രണ്ടാം');
});

test('stops at the start of the session rather than rewriting older work', async ({ page }) => {
  await importCorpus(page, SMALL_DOC);
  await revise(page, 'തിരുത്തിയ ഒന്നാം ഖണ്ഡിക.');

  // A reload is a new session (ADR-0033): the edit above is now history, not
  // something this launch can take back.
  await page.reload();
  await expect(page.locator('.block-row').first()).toContainText('തിരുത്തിയ');
  await expect(page.getByTestId('undo')).toBeDisabled();
});
