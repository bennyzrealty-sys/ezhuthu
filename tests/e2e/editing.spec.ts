import { expect, test } from '@playwright/test';
import { importCorpus, resetDatabase, SMALL_DOC } from './helpers';

test.beforeEach(async ({ page }) => {
  await resetDatabase(page);
});

test('imports a document and renders it', async ({ page }) => {
  await importCorpus(page, SMALL_DOC);

  await expect(page.locator('.block-row').first()).toContainText('ഒന്നാം');
  await expect(page.locator('.doc-toolbar .stat')).toContainText('blocks');
});

test('only renders a window of blocks, not the whole document', async ({ page }) => {
  // The property virtualisation exists for. Without it a 100k-word document
  // puts ~2,000 paragraphs in the DOM and dies.
  const many = Array.from({ length: 400 }, (_, i) => `ഖണ്ഡിക ${i} — കടൽ ശാന്തമായിരുന്നു.`).join(
    '\n\n',
  );
  await importCorpus(page, many);

  const rendered = await page.locator('.doc-item').count();
  expect(rendered).toBeGreaterThan(0);
  expect(rendered).toBeLessThan(80);
});

test('tapping a block opens an editor in its place', async ({ page }) => {
  await importCorpus(page, SMALL_DOC);

  const first = page.locator('.block-row').first();
  const original = (await first.textContent()) ?? '';
  await first.click();

  const editor = page.locator('.block-editor');
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue(original);
});

test('an edit survives a reload', async ({ page }) => {
  await importCorpus(page, SMALL_DOC);

  await page.locator('.block-row').first().click();
  const editor = page.locator('.block-editor');
  await editor.fill('തിരുത്തിയ ഖണ്ഡിക.');
  // Commit is idle-triggered; blur forces it.
  await editor.blur();
  await expect(page.locator('.block-row').first()).toContainText('തിരുത്തിയ');

  await page.reload();
  await expect(page.locator('.block-row').first()).toContainText('തിരുത്തിയ');
});

test('Enter splits a block and Backspace at the start merges it back', async ({ page }) => {
  await importCorpus(page, 'ഒന്ന് രണ്ട്\n\nമൂന്ന്');

  const before = await page.locator('.block-row').count();

  await page.locator('.block-row').first().click();
  const editor = page.locator('.block-editor');
  await editor.focus();
  // Caret to the middle, then split.
  await page.keyboard.press('Home');
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');

  await expect(page.locator('.doc-item')).toHaveCount(before + 1);

  // The new block is focused with the caret at its start, so Backspace merges.
  await page.keyboard.press('Backspace');
  await expect(page.locator('.doc-item')).toHaveCount(before);
  await page.locator('.block-editor').blur();
  await expect(page.locator('.block-row').first()).toContainText('ഒന്ന് രണ്ട്');
});

test('edits append to the log rather than overwriting the document', async ({ page }) => {
  await importCorpus(page, SMALL_DOC);

  const countEvents = () =>
    page.evaluate(async () => {
      const request = indexedDB.open('ezhuthu');
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const count: number = await new Promise((resolve, reject) => {
        const r = db.transaction('events').objectStore('events').count();
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      db.close();
      return count;
    });

  const before = await countEvents();

  await page.locator('.block-row').first().click();
  await page.locator('.block-editor').fill('ഒന്നാം തിരുത്ത്.');
  await page.locator('.block-editor').blur();
  await expect(page.locator('.block-row').first()).toContainText('തിരുത്ത്');

  expect(await countEvents()).toBe(before + 1);
});
