/**
 * Attention telemetry end to end (ADR-0017, docs/SIGNALS.md).
 *
 * The unit tests own the model; what these own is the wiring — that real
 * typing, real scrolling and a real `visibilitychange` in a real browser put
 * batched rows in `signals`, and that composition does not.
 */

import { expect, test, type Page } from '@playwright/test';
import { importCorpus, readSignals, resetDatabase, SMALL_DOC } from './helpers';

/** Longer than the 2 s flush, so a missing row means "not captured", not "not yet". */
const PAST_FLUSH_MS = 3_000;

const kinds = async (page: Page): Promise<string[]> =>
  [...new Set((await readSignals(page)).map((r) => r.kind))].sort();

const countOf = async (page: Page, kind: string): Promise<number> =>
  (await readSignals(page)).filter((r) => r.kind === kind).length;

test.beforeEach(async ({ page }) => {
  await resetDatabase(page);
});

test('reading a block accrues dwell, batched rather than written per sample', async ({ page }) => {
  // Enough paragraphs to fill the viewport, so that something is actually at
  // its centre. A three-paragraph document has nothing there and every block
  // scores low — correctly, and uninterestingly.
  await importCorpus(
    page,
    Array.from({ length: 40 }, (_, i) => `ഖണ്ഡിക ${i} — കടൽ ശാന്തമായിരുന്നു.`).join('\n\n'),
  );

  // Settle (1 s) plus a few samples (1 s each), plus a flush window.
  await page.waitForTimeout(5_000);

  const rows = (await readSignals(page)).filter((r) => r.kind === 'dwell');
  expect(rows.length).toBeGreaterThan(0);

  const totals = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const row of rows) {
    totals.set(row.blockId, (totals.get(row.blockId) ?? 0) + row.value);
    counts.set(row.blockId, (counts.get(row.blockId) ?? 0) + 1);
  }

  const [best, banked] = [...totals].sort((a, b) => b[1] - a[1])[0]!;
  expect(banked).toBeGreaterThan(1_000);
  // One row per block per flush window, not one per sample: five seconds of
  // sampling is five samples a block and at most three flushes.
  expect(counts.get(best)!).toBeLessThanOrEqual(3);
});

test('scrolling back to a paragraph and stopping there is recorded', async ({ page }) => {
  await importCorpus(
    page,
    Array.from({ length: 120 }, (_, i) => `ഖണ്ഡിക ${i} — കടൽ ശാന്തമായിരുന്നു.`).join('\n\n'),
  );

  const scrollTo = (top: number) =>
    page.evaluate((y) => {
      const scroller = document.querySelector('.doc-scroll');
      if (scroller !== null) scroller.scrollTop = y;
    }, top);

  // Read forwards, then go back up to check something and stop there.
  await scrollTo(3_000);
  await page.waitForTimeout(2_500);
  await scrollTo(2_200);

  // Settle, plus the 2 s dwell that distinguishes checking a reference from
  // scrolling past it, plus a flush window.
  await expect.poll(() => countOf(page, 'scrollback'), { timeout: 20_000 }).toBeGreaterThan(0);
});

test('typing records hesitation and backspace density', async ({ page }) => {
  await importCorpus(page, SMALL_DOC);

  await page.locator('.block-row').first().click();
  const editor = page.locator('.block-editor');
  await expect(editor).toBeFocused();

  await editor.pressSequentially('കടൽ');
  // A pause past the hesitation floor — the writer stopping to think.
  await page.waitForTimeout(2_500);
  await editor.pressSequentially('ം');
  await editor.press('Backspace');
  await editor.press('Backspace');

  await expect.poll(() => countOf(page, 'backspace'), { timeout: 15_000 }).toBeGreaterThan(0);
  await expect.poll(() => countOf(page, 'hesitation'), { timeout: 15_000 }).toBeGreaterThan(0);

  const rows = await readSignals(page);
  const backspaces = rows.filter((r) => r.kind === 'backspace');
  expect(backspaces.reduce((sum, r) => sum + r.value, 0)).toBe(2);
  // Coalesced: two presses inside one flush window are one row.
  expect(backspaces).toHaveLength(1);

  const hesitation = rows.find((r) => r.kind === 'hesitation')!;
  expect(hesitation.value).toBeGreaterThan(2_000);
  expect(hesitation.value).toBeLessThan(10_000);
});

test('composition is not counted as typing (ADR-0010)', async ({ page }) => {
  /*
   * The trap this phase was warned about. During composition Chrome reports
   * keyCode 229 for everything and fires an input event per candidate
   * keystroke; counting them would spike backspace density wherever an IME
   * rewrote its own buffer, for exactly the input method Malayalam is typed
   * with.
   *
   * `Input.imeSetComposition` opens a genuine composition session, so the
   * Backspace below is genuinely `isComposing`. Removing the guard in
   * signals/typing.ts makes this test fail.
   */
  await importCorpus(page, 'ആദ്യ ഖണ്ഡിക.');

  await page.locator('.block-row').first().click();
  await expect(page.locator('.block-editor')).toBeFocused();

  const cdp = await page.context().newCDPSession(page);
  for (const stage of ['അ', 'അവ', 'അവന']) {
    await cdp.send('Input.imeSetComposition', {
      text: stage,
      selectionStart: stage.length,
      selectionEnd: stage.length,
    });
    // Long enough that a naive collector would also have recorded a pause.
    await page.waitForTimeout(2_500);
  }
  // Deleting inside the composition buffer: the IME editing itself.
  await page.keyboard.press('Backspace');
  await cdp.send('Input.insertText', { text: 'അവൻ' });

  await page.waitForTimeout(PAST_FLUSH_MS);
  expect(await countOf(page, 'backspace')).toBe(0);
  expect(await countOf(page, 'hesitation')).toBe(0);

  // ...and the same keystroke outside a composition is counted, so the test
  // above is not passing because nothing is being captured at all.
  await page.locator('.block-editor').press('Backspace');
  await expect.poll(() => countOf(page, 'backspace'), { timeout: 15_000 }).toBe(1);
});

test('hiding the document flushes what is queued', async ({ page }) => {
  await importCorpus(page, SMALL_DOC);

  await page.locator('.block-row').first().click();
  await page.locator('.block-editor').press('Backspace');

  // Hide immediately, well inside the 2 s flush window: on a phone this is
  // frequently the last code that runs before the app is frozen.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  await expect.poll(() => countOf(page, 'backspace'), { timeout: 5_000 }).toBe(1);
});

test('nothing is captured that docs/SIGNALS.md does not name', async ({ page }) => {
  // The store holds attention telemetry and nothing else. No text, no keys, no
  // offsets — a signal is (block, kind, number) by design.
  await importCorpus(page, SMALL_DOC);
  await page.locator('.block-row').first().click();
  await page.locator('.block-editor').pressSequentially('കടൽ');
  await page.waitForTimeout(5_000);

  for (const kind of await kinds(page)) {
    expect(['dwell', 'hesitation', 'backspace', 'scrollback']).toContain(kind);
  }
  for (const row of await readSignals(page)) {
    expect(Object.keys(row).sort()).toEqual([
      'blockId',
      'docId',
      'id',
      'kind',
      'sessionId',
      'ts',
      'value',
    ]);
    expect(typeof row.value).toBe('number');
  }
});
