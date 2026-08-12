/**
 * The paragraph being typed, when something else happens (ADR-0036, ADR-0037).
 *
 * `BlockEditor` holds the focused paragraph in a ref and commits after 400ms of
 * quiet, so a keystroke costs no render. That window is where a long-form
 * writer's work goes missing, and the app was relying on the field's own `blur`
 * to close it — which is a platform behaviour, not a guarantee. A focused
 * element REMOVED from the document gets no blur event in Chromium or WebKit,
 * and this field is an ordinary virtualised row.
 *
 * Every test here failed before the fix. They were found by auditing for the
 * shape of the download bug rather than by reading the feature list, which is
 * the only reason they exist: none of them is about downloading.
 */

import { expect, test, type Page } from '@playwright/test';
import { importCorpus, resetDatabase } from './helpers';

const LONG_DOC = Array.from(
  { length: 400 },
  (_, i) => `ഖണ്ഡിക ${i}. കടൽ ശാന്തമായിരുന്നു എന്ന് അവൻ പറഞ്ഞു.`,
);

test.beforeEach(async ({ page }) => {
  await resetDatabase(page);
});

/**
 * Wait until the store actually holds the text.
 *
 * The unmount commit is fire-and-forget by nature — nothing can await a
 * component that is being torn down — so reloading on the next line races the
 * append and fails while the app is behaving correctly. Read from a second
 * IndexedDB connection rather than from the UI, because the point of these
 * tests is what survives, not what is on screen.
 */
async function expectStored(page: Page, substring: string) {
  await expect
    .poll(
      () =>
        page.evaluate(async (needle) => {
          const database = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open('ezhuthu');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          return new Promise<boolean>((resolve) => {
            const all = database.transaction('blocks', 'readonly').objectStore('blocks').getAll();
            all.onsuccess = () =>
              resolve((all.result as { text: string }[]).some((b) => b.text.includes(needle)));
          });
        }, substring),
      { timeout: 10_000 },
    )
    .toBe(true);
}

/** Activate a control without letting focus leave the editor (ADR-0036). */
async function tapWithoutBlurring(page: Page, testId: string) {
  await page.evaluate((id) => {
    (document.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement).click();
  }, testId);
}

test('typing survives scrolling the paragraph out of the window', async ({ page }) => {
  /*
   * The one most likely to have eaten real work. The editor is a virtualised
   * row; scroll far enough within the commit window and it is recycled, and
   * nothing fired blur on the way out. A writer who types a line and flicks up
   * the page to check something lost the line.
   */
  await importCorpus(page, LONG_DOC.join('\n\n'));
  await page.locator('.block-row').first().click();
  await page.locator('.block-editor').fill('ഈ വാചകം നഷ്ടപ്പെടരുത്.');

  await page.locator('.doc-scroll').evaluate((element) => {
    element.scrollTop = 40_000;
  });

  await expectStored(page, 'നഷ്ടപ്പെടരുത്');
  await page.reload();
  await expect(page.locator('.block-row').first()).toContainText('നഷ്ടപ്പെടരുത്');
});

test('typing survives an import remounting the document', async ({ page }) => {
  await page.getByTestId('start-writing').click();
  await page.locator('.block-editor').fill('ആദ്യം എഴുതിയത്.');

  // Import remounts DocumentView by changing its key, unmounting the editor.
  await importCorpus(page, 'ഇറക്കുമതി ചെയ്ത ഖണ്ഡിക.');

  await expectStored(page, 'ആദ്യം എഴുതിയത്.');
  await page.reload();
  await expect(page.locator('.doc-viewport')).toContainText('ആദ്യം എഴുതിയത്.');
});

test('Undo takes back what was just typed, not an older unrelated change', async ({ page }) => {
  /*
   * `undoLast` reads the tail of the event log, which cannot contain the
   * paragraph being typed. Pressed inside the commit window it reversed the
   * PREVIOUS committed action — a different paragraph — and the reload that
   * follows discarded the current sentence. Both silently, under a success
   * message.
   */
  await importCorpus(page, ['ഖണ്ഡിക 0. ഒന്ന്.', 'ഖണ്ഡിക 1. രണ്ട്.'].join('\n\n'));

  await page.locator('.block-row').first().click();
  await page.locator('.block-editor').fill('ആദ്യ തിരുത്ത്.');
  await page.locator('.block-editor').blur();
  await expect(page.locator('.block-row').first()).toContainText('ആദ്യ തിരുത്ത്.');

  await page.locator('.block-row').nth(1).click();
  await page.locator('.block-editor').fill('രണ്ടാമത്തെ തിരുത്ത്.');
  await tapWithoutBlurring(page, 'undo');

  // The older edit is untouched — that is the bug this replaces.
  await expect(page.locator('.doc-viewport')).toContainText('ആദ്യ തിരുത്ത്.');
  // And the undo landed on the paragraph that was actually being typed in.
  await expect(page.locator('.doc-viewport')).toContainText('ഖണ്ഡിക 1. രണ്ട്.');
});

test('+ New paragraph adds one after the first paragraph is typed', async ({ page }) => {
  /*
   * The first thing anyone does on a fresh install: Start writing, type,
   * + New paragraph. `appendParagraph` read the committed length from the
   * index, saw the paragraph as still empty, took the "focus it instead"
   * branch — and because it was already the focused block, nothing happened at
   * all. The button was dead exactly once per new document.
   */
  await page.getByTestId('start-writing').click();
  await page.locator('.block-editor').fill('ഒന്നാമത്തെ വരി.');

  await tapWithoutBlurring(page, 'append-paragraph');

  await expect(page.locator('.block-row')).toHaveCount(1);
  await expect(page.locator('.block-row').first()).toContainText('ഒന്നാമത്തെ വരി.');
  await expect(page.locator('.block-editor')).toHaveCount(1);
  expect(await page.locator('.block-editor').inputValue()).toBe('');
});

test('repeated + New paragraph taps still do not litter the log', async ({ page }) => {
  // The property the affordance was built with (writing.spec.ts): two taps are
  // one intention, and the log is permanent. Flushing first must not cost it.
  await page.getByTestId('start-writing').click();
  await page.locator('.block-editor').fill('വരി.');

  // Fired back to back, deliberately: the guard is against a double tap, and a
  // human's second tap lands well inside the append it is racing.
  for (let i = 0; i < 3; i++) await tapWithoutBlurring(page, 'append-paragraph');

  await expect(page.locator('.block-row')).toHaveCount(1);
  await expect(page.locator('.block-editor')).toHaveCount(1);
});

test('a paragraph jumped to from search opens with its text, not blank', async ({ page }) => {
  /*
   * Text for a row arrives one IndexedDB round trip after the row renders, and
   * `undefined` there is not the same as empty. Opening the editor on `''`
   * mounts a blank field over real prose — the mount effect is keyed on the
   * block id, so the text arriving afterwards never reaches it — and leaving
   * that field would commit the blank over the writer's paragraph.
   *
   * Not reproduced as an actual wipe: in a headless Chromium the text always
   * won the race. The window is real and the consequence is a destroyed
   * paragraph, so the editor now refuses to open on text it has not got.
   */
  await importCorpus(page, LONG_DOC.join('\n\n'));

  await page.getByTestId('search-toggle').click();
  await page.getByTestId('search-input').fill('ഖണ്ഡിക 380');
  await expect(page.getByTestId('search-summary')).toContainText(/\d/);
  await page.getByTestId('search-results').locator('li').first().click();

  const row = page.locator('.block-row').nth(2);
  await row.click();
  expect(await page.locator('.block-editor').inputValue()).not.toBe('');
});

test('nothing in the store is left blank by tapping around after jumps', async ({ page }) => {
  await importCorpus(page, LONG_DOC.join('\n\n'));

  for (let i = 0; i < 10; i++) {
    await page.getByTestId('minimap').click({ position: { x: 4, y: 40 + i * 30 } });
    const row = page.locator('.block-row').nth(1);
    if ((await row.count()) === 0) continue;
    await row.click();
    await page.locator('.block-editor').blur();
  }

  const blanks = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('ezhuthu');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return new Promise<number>((resolve) => {
      const all = database.transaction('blocks', 'readonly').objectStore('blocks').getAll();
      all.onsuccess = () =>
        resolve(
          (all.result as { text: string; deletedAt?: number }[]).filter(
            (block) => block.deletedAt === undefined && block.text === '',
          ).length,
        );
    });
  });

  expect(blanks).toBe(0);
});
