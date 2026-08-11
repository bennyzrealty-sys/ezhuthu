/**
 * Starting to write, in a document that has nothing in it yet.
 *
 * This is the path a fresh install actually takes, and until it was reported
 * from a phone it did not exist: the editor opens by tapping an existing
 * paragraph, an empty document has none, and the empty state said "Import a
 * file to begin". Importing is how you bring a manuscript in; it is not how
 * you write a sentence.
 *
 * Every test here goes through the affordances a thumb can reach. None of them
 * calls into the store to arrange a first block, because having no first block
 * is the whole condition under test.
 */

import { expect, test } from '@playwright/test';
import { countEvents, importCorpus, resetDatabase, SMALL_DOC } from './helpers';

test.beforeEach(async ({ page }) => {
  await resetDatabase(page);
});

test('an empty document offers a way in, and it works', async ({ page }) => {
  await expect(page.getByTestId('start-writing')).toBeVisible();

  await page.getByTestId('start-writing').click();

  // The editor is open and focused: what the writer types goes in without a
  // second tap. On a phone that is also what raises the keyboard.
  const editor = page.locator('.block-editor');
  await expect(editor).toBeVisible();
  await expect(editor).toBeFocused();

  await editor.fill('ആദ്യത്തെ വാചകം.');
  await editor.blur();

  await expect(page.locator('.block-row').first()).toContainText('ആദ്യത്തെ വാചകം.');
  await expect(page.getByText('words ·')).toContainText('2 words · 1 blocks');
});

test('what was written survives a reload', async ({ page }) => {
  await page.getByTestId('start-writing').click();
  await page.locator('.block-editor').fill('ഇത് നിലനിൽക്കണം.');
  await page.locator('.block-editor').blur();
  await expect(page.locator('.block-row').first()).toContainText('നിലനിൽക്കണം');

  await page.reload();

  await expect(page.locator('.block-row').first()).toContainText('ഇത് നിലനിൽക്കണം.');
});

test('Enter carries on from the first paragraph', async ({ page }) => {
  // The way in has to hand over to the ordinary writing gesture, or it is a
  // dead end one paragraph further along.
  await page.getByTestId('start-writing').click();
  const editor = page.locator('.block-editor');
  await editor.fill('ഒന്ന്.');
  await editor.press('Enter');

  /*
   * Wait for the second paragraph to exist, then type through the keyboard
   * rather than filling `.block-editor` again. The locator would re-resolve to
   * whichever editor is mounted at that instant, and for a moment after Enter
   * that is still the first one — which is how this test first "failed":
   * `fill` overwrote paragraph one and left paragraph two empty. Same family
   * as the asynchronous-read trap in HANDOFF.md.
   */
  await expect(page.locator('.doc-item')).toHaveCount(2);
  await page.keyboard.type('രണ്ട്.');
  await page.locator('.block-editor').blur();

  await expect(page.locator('.block-row')).toHaveCount(2);
  await expect(page.locator('.block-row').nth(0)).toContainText('ഒന്ന്.');
  await expect(page.locator('.block-row').nth(1)).toContainText('രണ്ട്.');
});

test('a paragraph can be added at the end of an existing document', async ({ page }) => {
  await importCorpus(page, SMALL_DOC);

  await page.getByTestId('append-paragraph').click();

  const editor = page.locator('.block-editor');
  await expect(editor).toBeFocused();
  await editor.fill('നാലാം ഖണ്ഡിക.');
  await editor.blur();

  const rows = page.locator('.block-row');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(3)).toContainText('നാലാം ഖണ്ഡിക.');
});

test('the affordance does not litter the log with paragraphs nobody typed', async ({ page }) => {
  await importCorpus(page, SMALL_DOC);
  const before = await countEvents(page);

  // Three taps, one intention. The first makes an empty paragraph; the rest
  // find it already there and just put the caret back in it. The log is
  // permanent (CLAUDE.md rule 1), so this is about what history says happened.
  await page.getByTestId('append-paragraph').click();
  await expect(page.locator('.block-editor')).toBeFocused();
  await page.getByTestId('append-paragraph').click();
  await page.getByTestId('append-paragraph').click();
  await expect(page.locator('.block-editor')).toBeFocused();

  expect(await countEvents(page)).toBe(before + 1);
});

test('an empty paragraph is committed as nothing, not as a revision', async ({ page }) => {
  // Tapping in and tapping away again should leave the document as it was
  // apart from the one empty paragraph — no `update` event carrying ''.
  await importCorpus(page, SMALL_DOC);
  await page.getByTestId('append-paragraph').click();
  const after = await countEvents(page);

  await page.locator('.block-editor').blur();
  await expect(page.locator('.block-editor')).toHaveCount(0);

  expect(await countEvents(page)).toBe(after);
});
