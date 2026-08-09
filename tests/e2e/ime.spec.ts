/**
 * ADR-0010 — never commit during IME composition.
 *
 * Malayalam is typed through input methods, and committing to storage or
 * re-rendering the field mid-composition resets the IME buffer: half-formed
 * conjuncts commit as separate characters, the caret jumps to the start, vowel
 * signs duplicate. This has been the project's largest untested correctness
 * claim, on the grounds that composition cannot be driven synthetically.
 *
 * That was wrong. `Input.imeSetComposition` over CDP drives a REAL composition
 * session in Chromium — the browser fires genuine compositionstart /
 * compositionupdate / compositionend, and the field passes through an actual
 * composition buffer. So the guard is testable after all.
 *
 * What this still does NOT cover, and why docs/MALAYALAM.md keeps its manual
 * checklist: a real Gboard or iOS Malayalam keyboard, transliteration
 * keyboards that resolve Latin keystrokes into Malayalam, swipe typing, and
 * autocorrect. Those exercise platform behaviour Chromium's CDP path does not
 * reproduce. This covers the logic — that our commit never fires inside a
 * composition window — which is the part we can be wrong about in code.
 */

import { expect, test, type Page } from '@playwright/test';
import { countEvents, importCorpus, resetDatabase } from './helpers';

/** Longer than the editor's 400ms idle commit, so a bug has time to fire. */
const PAST_IDLE_MS = 900;

async function focusFirstBlock(page: Page) {
  await page.locator('.block-row').first().click();
  await expect(page.locator('.block-editor')).toBeFocused();
}

test.beforeEach(async ({ page }) => {
  await resetDatabase(page);
  await importCorpus(page, 'ആദ്യ ഖണ്ഡിക.');
});

test('no commit lands while a composition is open', async ({ page }) => {
  await focusFirstBlock(page);
  const before = await countEvents(page);

  const cdp = await page.context().newCDPSession(page);

  // Type a Malayalam word through the composition buffer, pausing past the
  // idle-commit threshold between keystrokes — which is exactly what happens
  // when someone stops to think mid-sentence.
  for (const stage of ['അ', 'അവ', 'അവന']) {
    await cdp.send('Input.imeSetComposition', {
      text: stage,
      selectionStart: stage.length,
      selectionEnd: stage.length,
    });
    await page.waitForTimeout(PAST_IDLE_MS);
    // The idle timer must not have fired: composition is still open.
    expect(await countEvents(page)).toBe(before);
  }

  // Finish the composition the way an IME resolves to atomic chillu.
  await cdp.send('Input.insertText', { text: 'അവൻ' });

  await expect
    .poll(() => countEvents(page), { timeout: 5_000 })
    .toBe(before + 1);
});

test('the composed text is committed intact', async ({ page }) => {
  await focusFirstBlock(page);
  const before = await countEvents(page);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', {
    text: 'അവന',
    selectionStart: 3,
    selectionEnd: 3,
  });
  await cdp.send('Input.insertText', { text: 'അവൻ' });

  // Wait for the commit the idle timer schedules, rather than forcing one with
  // blur(). Blurring here races the composition: compositionend and the blur
  // handler can interleave, and the test then measures its own timing rather
  // than the editor's behaviour.
  await expect.poll(() => countEvents(page), { timeout: 5_000 }).toBe(before + 1);

  // Still correct after a reload — so what landed in storage is the resolved
  // text, not a half-formed composition buffer.
  await page.reload();

  /*
   * toContainText, not textContent(): a row mounts before its text arrives
   * (DocumentView fetches text by window, after the index) and renders blank
   * until it does. A one-shot read wins on an idle machine and loses on a busy
   * one, which is a test that reports flakiness as breakage.
   */
  const first = page.locator('.block-row').first();
  await expect(first).toContainText('അവൻ');
  // The atomic chillu survived; it was not split back into ന + virama + ZWJ.
  expect(await first.textContent()).not.toContain('‍');
});

test('composition does not corrupt text already in the block', async ({ page }) => {
  await focusFirstBlock(page);
  const original = await page.locator('.block-editor').inputValue();

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', {
    text: 'ക്ക',
    selectionStart: 3,
    selectionEnd: 3,
  });
  await page.waitForTimeout(PAST_IDLE_MS);
  await cdp.send('Input.insertText', { text: 'ക്ക' });

  await page.locator('.block-editor').blur();

  // The existing paragraph is intact and the conjunct is appended whole —
  // no duplicated vowel signs, no caret jump to the start.
  await expect(page.locator('.block-row').first()).toHaveText(`${original}ക്ക`);
});

test('a commit still happens once composition ends and typing stops', async ({ page }) => {
  // The complement of the first test: the guard must not be so eager that it
  // suppresses the commit entirely.
  await focusFirstBlock(page);
  const before = await countEvents(page);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', {
    text: 'മഴ',
    selectionStart: 2,
    selectionEnd: 2,
  });
  await cdp.send('Input.insertText', { text: 'മഴ' });

  // No blur — the idle timer alone must commit it, restarted by compositionend.
  await expect
    .poll(() => countEvents(page), { timeout: 5_000 })
    .toBe(before + 1);
  await expect(page.locator('.block-editor')).toBeFocused();
});
