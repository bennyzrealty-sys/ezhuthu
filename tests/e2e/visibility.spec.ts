import { expect, test, type Page } from '@playwright/test';
import { importCorpus, resetDatabase, SMALL_DOC } from './helpers';

test.beforeEach(async ({ page }) => {
  await resetDatabase(page);
});

/** The lowest block index currently in the DOM — where the viewport is. */
function firstRenderedIndex(page: Page): Promise<number> {
  return page.evaluate(() => {
    const items = [...document.querySelectorAll('.doc-item')].map((e) =>
      Number(e.getAttribute('data-index')),
    );
    return items.length === 0 ? -1 : Math.min(...items);
  });
}

/** Count of non-transparent pixels drawn on the minimap canvas. */
function minimapDrawnPixels(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="minimap"]');
    if (canvas === null) return -1;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return -1;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let painted = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) painted++;
    return painted;
  });
}

const manyBlocks = (n: number) =>
  Array.from({ length: n }, (_, i) => `ഖണ്ഡിക ${i} — കടൽ ശാന്തമായിരുന്നു.`).join('\n\n');

/**
 * Seed `times` scroll-back signals for the block whose text contains `needle`,
 * straight into IndexedDB. The real scroll-back gesture is covered in
 * signals.spec.ts; here what is under test is the consumer, so the signal is
 * planted rather than performed. Returns the block id, or null if not found.
 */
function seedScrollback(page: Page, needle: string, times: number): Promise<string | null> {
  return page.evaluate(
    async ({ needle, times }) => {
      const open = (): Promise<IDBDatabase> =>
        new Promise((resolve, reject) => {
          const r = indexedDB.open('ezhuthu');
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
      const db = await open();
      const blocks: Array<{ blockId: string; docId: string; text: string; deletedAt?: number }> =
        await new Promise((resolve, reject) => {
          const r = db.transaction('blocks').objectStore('blocks').getAll();
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
      const block = blocks.find((b) => b.text.includes(needle) && b.deletedAt === undefined);
      if (block === undefined) {
        db.close();
        return null;
      }
      const tx = db.transaction('signals', 'readwrite');
      const store = tx.objectStore('signals');
      for (let i = 0; i < times; i++) {
        store.add({
          docId: block.docId,
          blockId: block.blockId,
          ts: Date.now(),
          sessionId: 'seed',
          kind: 'scrollback',
          value: 3000,
        });
      }
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      return block.blockId;
    },
    { needle, times },
  );
}

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

test.describe('minimap (ADR-0021)', () => {
  test('paints nothing for an unedited document and something for an edit', async ({ page }) => {
    await importCorpus(page, manyBlocks(120));
    await expect(page.locator('[data-testid="minimap"]')).toBeVisible();
    // Nothing has been edited, so the column is empty — same reasoning as the
    // margin bar (ADR-0027).
    expect(await minimapDrawnPixels(page)).toBe(0);

    await page.locator('.block-row').first().click();
    const editor = page.locator('.block-editor');
    await editor.fill('തിരുത്തി.');
    await editor.blur();
    await expect(page.locator('.block-row').first()).toContainText('തിരുത്തി');

    await expect.poll(() => minimapDrawnPixels(page)).toBeGreaterThan(0);
  });

  test('tapping the column jumps the document to that position', async ({ page }) => {
    await importCorpus(page, manyBlocks(400));
    const before = await firstRenderedIndex(page);
    expect(before).toBeLessThan(10);

    const minimap = page.locator('[data-testid="minimap"]');
    const box = await minimap.boundingBox();
    expect(box).not.toBeNull();
    // Tap near the bottom of the column → jump toward the end of the document.
    await minimap.click({ position: { x: 5, y: box!.height - 8 } });

    await expect.poll(() => firstRenderedIndex(page)).toBeGreaterThan(before + 50);
  });
});

test.describe('ghost markers (ADR-0018, ADR-0028)', () => {
  test('deleting a paragraph leaves a seam that reveals and restores it', async ({ page }) => {
    await importCorpus(page, SMALL_DOC);
    await expect(page.locator('.block-row')).toHaveCount(3);

    // Delete the middle paragraph deliberately.
    await page.locator('.block-row').nth(1).click();
    await expect(page.locator('.block-editor')).toBeFocused();
    await page.locator('[data-testid="block-delete"]').click();

    await expect(page.locator('.block-row')).toHaveCount(2);
    const seam = page.locator('[data-testid="seam"]');
    await expect(seam).toHaveCount(1);

    // Tapping the seam reveals the deleted text — recoverable from the log
    // though it is gone from the document.
    await page.locator('[data-testid="seam-rule"]').click();
    await expect(page.locator('.seam-text')).toContainText('രണ്ടാം');

    // Restore puts it back where it was.
    await page.locator('[data-testid="seam-restore"]').click();
    await expect(page.locator('.block-row')).toHaveCount(3);
    await expect(page.locator('[data-testid="seam"]')).toHaveCount(0);
    await expect(page.locator('.block-row').nth(1)).toContainText('രണ്ടാം');
  });

  test('a deleted paragraph and its seam survive a reload', async ({ page }) => {
    await importCorpus(page, SMALL_DOC);
    await page.locator('.block-row').nth(1).click();
    await page.locator('[data-testid="block-delete"]').click();
    await expect(page.locator('[data-testid="seam"]')).toHaveCount(1);

    await page.reload();
    await expect(page.locator('.block-row')).toHaveCount(2);
    await expect(page.locator('[data-testid="seam"]')).toHaveCount(1);
  });

  test('a merge is not a deletion and leaves no seam (ADR-0028)', async ({ page }) => {
    await importCorpus(page, 'ഒന്ന്\n\nരണ്ട്');
    await expect(page.locator('.block-row')).toHaveCount(2);

    await page.locator('.block-row').nth(1).click();
    await page.keyboard.press('Home');
    await page.keyboard.press('Backspace'); // merge into the previous block
    // Wait for the merge to settle before blurring, or blur races the async
    // merge and acts on the block that is about to unmount.
    await expect(page.locator('.doc-item')).toHaveCount(1);
    await page.locator('.block-editor').blur();

    await expect(page.locator('.block-row')).toHaveCount(1);
    // The text survives in the neighbour, so a ghost would only duplicate it.
    await expect(page.locator('[data-testid="seam"]')).toHaveCount(0);
    await expect(page.locator('.block-row').first()).toContainText('ഒന്ന്രണ്ട്');
  });
});

test.describe('scroll-back auto-bookmarks (docs/SIGNALS.md)', () => {
  test('says so plainly when nothing has been returned to', async ({ page }) => {
    await importCorpus(page, SMALL_DOC);
    await page.locator('[data-testid="bookmarks-toggle"]').click();
    await expect(page.locator('[data-testid="bookmarks-empty"]')).toBeVisible();
    await expect(page.locator('[data-testid="bookmark"]')).toHaveCount(0);
  });

  test('lists a returned-to paragraph and jumps to it', async ({ page }) => {
    await importCorpus(page, manyBlocks(400));
    const id = await seedScrollback(page, 'ഖണ്ഡിക 300 —', 3);
    expect(id).not.toBeNull();

    await page.locator('[data-testid="bookmarks-toggle"]').click();
    const marks = page.locator('[data-testid="bookmark"]');
    await expect(marks).toHaveCount(1);
    await expect(marks.first()).toContainText('ഖണ്ഡിക 300');
    await expect(marks.first()).toContainText('returned to 3 times');

    // Tapping a bookmark jumps the document to that paragraph, far from the top.
    await marks.first().click();
    await expect.poll(() => firstRenderedIndex(page)).toBeGreaterThan(250);
  });
});
