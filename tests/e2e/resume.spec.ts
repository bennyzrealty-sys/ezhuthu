/**
 * The resume strip (ADR-0023) — requirement 1 of the project, end to end.
 *
 * The unit tests own which block each destination resolves to. What these own
 * is that a real launch offers it, that picking one moves the document, and
 * that the preference the strip learns is expressed as the default rather than
 * as the order.
 */

import { expect, test, type Page } from '@playwright/test';
import { countEvents, importCorpus, resetDatabase, SMALL_DOC } from './helpers';

const MARKER = 'അടയാളം ഇവിടെ';

const LONG_DOC = Array.from(
  { length: 120 },
  (_, i) => `ഖണ്ഡിക ${i} — കടൽ ശാന്തമായിരുന്നു.`,
).join('\n\n');

const strip = (page: Page) => page.getByTestId('resume-strip');

/** Scroll the virtualiser without a fling, so rows settle where we put them. */
async function scrollTo(page: Page, top: number): Promise<void> {
  await page.evaluate((y) => {
    const scroller = document.querySelector('.doc-scroll');
    if (scroller !== null) scroller.scrollTop = y;
  }, top);
}

/** Edit a paragraph well down the document, so resuming to it has to move. */
async function editDeepBlock(page: Page): Promise<void> {
  await scrollTo(page, 4_000);
  const row = page.locator('.block-row').first();
  await expect(row).toContainText('ഖണ്ഡിക');

  const before = await countEvents(page);
  await row.click();

  const editor = page.locator('.block-editor');
  await expect(editor).toBeFocused();
  await editor.fill(MARKER);
  await editor.blur();

  /*
   * Confirm the edit in the log, not in the DOM. Two things move the rendered
   * window here — Playwright scrolls the row into view before clicking it, and
   * replacing a long paragraph with a short one changes its height, which the
   * virtualiser compensates for — so the paragraph that was edited is not
   * reliably still on screen, or still the row it was. The commit is what this
   * helper is actually waiting for.
   */
  await expect.poll(() => countEvents(page), { timeout: 10_000 }).toBe(before + 1);
}

test.beforeEach(async ({ page }) => {
  await resetDatabase(page);
});

test('a fresh import offers nothing to resume to', async ({ page }) => {
  // Nothing has been edited and there is no previous session, so every
  // destination is empty — and four dead buttons are worse than no strip.
  await importCorpus(page, SMALL_DOC);
  await page.waitForTimeout(1_500);
  await expect(strip(page)).toHaveCount(0);
});

test('after an edit and a relaunch, the strip offers where you were', async ({ page }) => {
  await importCorpus(page, LONG_DOC);
  await editDeepBlock(page);

  await page.reload();
  await expect(strip(page)).toBeVisible();

  const lastEdited = page.getByTestId('resume-lastEdited');
  await expect(lastEdited).toContainText(MARKER);
  await expect(lastEdited).toContainText('edited');

  // The document opens at the top, so the paragraph is nowhere near the screen.
  await expect(page.locator('.block-row').first()).not.toContainText(MARKER);

  await lastEdited.click();

  await expect(page.locator(`.block-row:has-text("${MARKER}")`)).toBeVisible();
  await expect(strip(page)).toHaveCount(0);
});

test('slots with no answer are present and disabled, not removed', async ({ page }) => {
  /*
   * The whole of ADR-0023 is that positions do not move. If an absent
   * destination closed the gap, the other three would shift between launches
   * and the strip could no longer be operated without reading it.
   */
  await importCorpus(page, LONG_DOC);
  await editDeepBlock(page);
  await page.reload();

  await expect(strip(page)).toBeVisible();
  for (const kind of ['lastEdited', 'lastRead', 'longestDwelled', 'mostRewritten']) {
    await expect(page.getByTestId(`resume-${kind}`)).toBeVisible();
  }
  // No previous session had signals, so both dwell destinations are empty.
  await expect(page.getByTestId('resume-lastRead')).toBeDisabled();
  await expect(page.getByTestId('resume-longestDwelled')).toBeDisabled();
  await expect(page.getByTestId('resume-lastEdited')).toBeEnabled();
});

test('a session spent reading produces the dwell destinations', async ({ page }) => {
  await importCorpus(page, LONG_DOC);
  await editDeepBlock(page);

  // Settle, then accrue: 1 s to settle, a few samples, and a flush window.
  await scrollTo(page, 2_000);
  await page.waitForTimeout(5_000);

  await page.reload();
  await expect(strip(page)).toBeVisible();
  await expect(page.getByTestId('resume-longestDwelled')).toBeEnabled();
  await expect(page.getByTestId('resume-longestDwelled')).toContainText('of attention');
  await expect(page.getByTestId('resume-lastRead')).toBeEnabled();
});

test('dismissing the strip leaves it dismissed for the launch', async ({ page }) => {
  await importCorpus(page, LONG_DOC);
  await editDeepBlock(page);
  await page.reload();

  await expect(strip(page)).toBeVisible();
  await page.getByTestId('resume-dismiss').click();
  await expect(strip(page)).toHaveCount(0);

  // Still gone after using the app; it is an opening offer, not a panel.
  await page.getByTestId('search-toggle').click();
  await expect(strip(page)).toHaveCount(0);
});

test('the favourite becomes the default only after five picks', async ({ page }) => {
  await importCorpus(page, LONG_DOC);
  await editDeepBlock(page);

  /*
   * The strip closes only once the pick has been written — `ResumeStrip.go`
   * awaits `recordPick` before navigating — so waiting for it to go is waiting
   * for the count to be durable. Reloading straight after the click would race
   * the write and lose picks, which is the same race a writer runs by resuming
   * and immediately closing the app.
   */
  const pick = async () => {
    await page.reload();
    await expect(strip(page)).toBeVisible();
    await page.getByTestId('resume-lastEdited').click();
    await expect(strip(page)).toHaveCount(0);
  };

  for (let i = 0; i < 4; i++) {
    await pick();
    await page.reload();
    await expect(page.getByTestId('resume-lastEdited')).not.toHaveAttribute('data-default', 'true');
  }

  await pick();
  await page.reload();
  await expect(page.getByTestId('resume-lastEdited')).toHaveAttribute('data-default', 'true');
  await expect(page.getByTestId('resume-lastEdited')).toContainText('default');

  // Emphasis, not position — the fixed order is unchanged by the learning.
  const order = await page
    .getByTestId('resume-strip')
    .locator('.resume-slot')
    .evaluateAll((slots) => slots.map((s) => s.getAttribute('data-testid')));
  expect(order).toEqual([
    'resume-lastEdited',
    'resume-lastRead',
    'resume-longestDwelled',
    'resume-mostRewritten',
  ]);
});

test('Enter on the strip activates the default', async ({ page }) => {
  await importCorpus(page, LONG_DOC);
  await editDeepBlock(page);

  for (let i = 0; i < 5; i++) {
    await page.reload();
    await expect(strip(page)).toBeVisible();
    await page.getByTestId('resume-lastEdited').click();
    // Closing is the signal that the pick was written; see the note above.
    await expect(strip(page)).toHaveCount(0);
  }

  await page.reload();
  await expect(page.getByTestId('resume-lastEdited')).toHaveAttribute('data-default', 'true');

  // The strip focuses itself, so Enter needs no tab press — and Tab still walks
  // the four slots in their fixed order.
  await page.keyboard.press('Enter');
  await expect(page.locator(`.block-row:has-text("${MARKER}")`)).toBeVisible();
  await expect(strip(page)).toHaveCount(0);
});
