/**
 * Copying the whole manuscript (ADR-0037).
 *
 * The second way out of the app, and the one that cannot be silently blocked.
 * Driven through the real button and the real clipboard, read back with
 * `navigator.clipboard.readText`, because every interesting failure is in the
 * last inch: a permission refused, a gesture spent on an `await` before the
 * write was attempted, a large document truncated by a route that only handles
 * short strings.
 *
 * What these CANNOT cover, and what has to be checked by hand on the device:
 * whether iOS Safari accepts the asynchronous `ClipboardItem` form after our
 * IndexedDB read. Chromium keeps user activation across an `await` and iOS does
 * not, so the ordering these tests exercise is the ordering that already worked;
 * the test named "…without letting focus leave the editor" is as close as
 * headless Chromium gets. See docs/MALAYALAM.md's manual checklist.
 */

import { expect, test, type Page } from '@playwright/test';
import { importCorpus, resetDatabase, SMALL_DOC } from './helpers';

test.beforeEach(async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await resetDatabase(page);
});

const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());

/** Activate a control without letting focus leave the editor (ADR-0036). */
async function tapWithoutBlurring(page: Page, testId: string) {
  await page.evaluate((id) => {
    (document.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement).click();
  }, testId);
}

test('the whole document goes to the clipboard', async ({ page }) => {
  await importCorpus(page, SMALL_DOC);

  await page.getByTestId('copy-document').click();

  await expect(page.getByTestId('message')).toContainText('Copied the whole document');
  expect(await clipboard(page)).toBe(`${SMALL_DOC}\n`);
});

test('the paragraph still being typed is on the clipboard', async ({ page }) => {
  // The bug that started this: a command that reads committed state cannot see
  // the paragraph under the caret for 400ms.
  await page.getByTestId('start-writing').click();
  await page.locator('.block-editor').fill('ക്ലിപ്പ്ബോർഡിലേക്ക് പോകേണ്ട വാചകം.');

  await tapWithoutBlurring(page, 'copy-document');

  await expect(page.getByTestId('message')).toContainText('Copied');
  expect(await clipboard(page)).toBe('ക്ലിപ്പ്ബോർഡിലേക്ക് പോകേണ്ട വാചകം.\n');
});

test('an edit still in the field beats the stored paragraph', async ({ page }) => {
  await importCorpus(page, SMALL_DOC);
  await page.locator('.block-row').first().click();
  await page.locator('.block-editor').fill('തിരുത്തിയ ഒന്നാം ഖണ്ഡിക.');

  await tapWithoutBlurring(page, 'copy-document');

  /*
   * Wait for the message before reading the clipboard. The asynchronous
   * ClipboardItem form hands the browser a PROMISE of the text, so the write
   * is registered immediately and the contents land when the read of the
   * document finishes — a clipboard read taken on the next line sees whatever
   * was there before. Same trap as the three in HANDOFF: do not read something
   * asynchronous once and assert on it.
   */
  await expect(page.getByTestId('message')).toContainText('Copied');

  const text = await clipboard(page);
  expect(text.startsWith('തിരുത്തിയ ഒന്നാം ഖണ്ഡിക.\n\n')).toBe(true);
  expect(text).not.toContain('കടൽ ശാന്തമായിരുന്നു');
});

test('the button at the end of the document copies too', async ({ page }) => {
  await importCorpus(page, SMALL_DOC);
  await page.getByTestId('copy-document-end').click();
  await expect(page.getByTestId('message')).toContainText('Copied');
  expect(await clipboard(page)).toBe(`${SMALL_DOC}\n`);
});

test('a long document arrives whole, not truncated', async ({ page }) => {
  /*
   * The claim is "not a single letter". A route that handles a sentence and
   * silently drops the tail of a manuscript would pass every other test here.
   * 400 paragraphs of Malayalam is ~40KB — small against a real script, large
   * against anything a truncating implementation would survive.
   */
  const paragraphs = Array.from(
    { length: 400 },
    (_, i) => `ഖണ്ഡിക ${i}. അവൻ ഒരു software engineer ആണ്. വർഷം തോറും മഴ പെയ്യുന്നു.`,
  );
  const document_ = paragraphs.join('\n\n');
  await importCorpus(page, document_);

  await page.getByTestId('copy-document').click();
  await expect(page.getByTestId('message')).toContainText('Copied');

  const text = await clipboard(page);
  expect(text).toBe(`${document_}\n`);
  // Stated separately: the equality above would also fail on a one-character
  // difference, and this says which failure happened.
  expect(text.length).toBe(document_.length + 1);
  expect(text.endsWith(`${paragraphs[399]!}\n`)).toBe(true);
});

test('chillu, ZWNJ and mixed scripts survive the clipboard byte for byte', async ({ page }) => {
  // The two chillu spellings look identical and are different manuscripts
  // (ADR-0014). Whichever was typed is what has to come back.
  const document_ = [
    'അവൻ ഒരു എഴുത്തുകാരൻ ആണ്.',
    'അവന്‍ ഒരു എഴുത്തുകാരന്‍ ആണ്.',
    'കൂട്‌ടം എന്ന വാക്ക്.',
    'അവൻ ഒരു software engineer ആണ് — 2026.',
  ].join('\n\n');
  await importCorpus(page, document_);

  await page.getByTestId('copy-document').click();
  await expect(page.getByTestId('message')).toContainText('Copied');
  expect(await clipboard(page)).toBe(`${document_}\n`);
});

test('the character count reported is the one that was copied', async ({ page }) => {
  await importCorpus(page, SMALL_DOC);
  await page.getByTestId('copy-document').click();
  await expect(page.getByTestId('message')).toContainText('Copied');

  const text = await clipboard(page);
  const expected = [...text].length.toLocaleString('en-US');
  await expect(page.getByTestId('message')).toContainText(`${expected} characters`);
});

test('an empty document says so instead of copying nothing', async ({ page }) => {
  await page.getByTestId('copy-document').click();
  await expect(page.getByTestId('message')).toContainText('Nothing to copy yet');
  await expect(page.getByTestId('copy-escape')).toHaveCount(0);
});

test('a browser that refuses every clipboard route hands the text over instead', async ({
  page,
}) => {
  /*
   * Some in-app browser views refuse the async Clipboard API outright and have
   * `execCommand` disabled. The answer is not an error message: the app puts
   * the writing in a field, selected, so it can be copied by hand. This is the
   * floor under the whole feature.
   */
  await importCorpus(page, SMALL_DOC);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    Object.defineProperty(window, 'ClipboardItem', { value: undefined, configurable: true });
    document.execCommand = () => false;
  });

  await page.getByTestId('copy-document').click();

  await expect(page.getByTestId('copy-escape')).toBeVisible();
  const field = page.getByTestId('copy-escape-field');
  expect(await field.inputValue()).toBe(`${SMALL_DOC}\n`);
  // Already selected, so the writer's only remaining step is Copy.
  expect(await field.evaluate((f: HTMLTextAreaElement) => f.selectionEnd - f.selectionStart)).toBe(
    `${SMALL_DOC}\n`.length,
  );
});

test('the legacy execCommand route is used when the modern API is missing', async ({ page }) => {
  // The pre-2018 route needs no permission, which is why it is the last one
  // tried rather than dropped. Asserted by watching it be called.
  await importCorpus(page, SMALL_DOC);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    Object.defineProperty(window, 'ClipboardItem', { value: undefined, configurable: true });
    const w = window as unknown as { __copied?: string };
    document.execCommand = (command: string) => {
      if (command !== 'copy') return false;
      w.__copied = (document.activeElement as HTMLTextAreaElement | null)?.value;
      return true;
    };
  });

  await page.getByTestId('copy-document').click();

  await expect(page.getByTestId('message')).toContainText('Copied the whole document');
  await expect(page.getByTestId('copy-escape')).toHaveCount(0);
  const copied = await page.evaluate(() => (window as unknown as { __copied?: string }).__copied);
  expect(copied).toBe(`${SMALL_DOC}\n`);
});

test('the clipboard write is issued inside the tap, before the document is read', async ({
  page,
}) => {
  /*
   * The property that makes this work on a phone, and the one thing here that
   * headless Chromium can genuinely prove.
   *
   * A clipboard write is permitted only while the browser still considers the
   * user's gesture live. Chromium keeps that across an `await`; WebKit does
   * not. So the obvious shape — read the document, then copy — works on every
   * machine this is developed and tested on and fails on iOS. The fix is the
   * asynchronous ClipboardItem form: `write` is called synchronously inside the
   * handler and handed a promise of the text.
   *
   * Asserted without timing. A flag is flipped from a `setTimeout`, so it is
   * still false for anything running in the same task as the click, and true
   * for anything running after an IndexedDB read — which always completes in a
   * later task. If someone "simplifies" clipboard.ts to await the read first,
   * `tick` is 1 here and this fails.
   */
  await importCorpus(page, SMALL_DOC);

  await page.evaluate(() => {
    const w = window as unknown as { __tick: number; __writeTick?: number };
    const write = navigator.clipboard.write.bind(navigator.clipboard);
    navigator.clipboard.write = (items) => {
      w.__writeTick = w.__tick;
      return write(items);
    };
    document.addEventListener(
      'click',
      () => {
        w.__tick = 0;
        setTimeout(() => {
          w.__tick = 1;
        }, 0);
      },
      { capture: true },
    );
  });

  await page.getByTestId('copy-document').click();
  await expect(page.getByTestId('message')).toContainText('Copied');

  const writeTick = await page.evaluate(
    () => (window as unknown as { __writeTick?: number }).__writeTick,
  );
  expect(writeTick).toBe(0);
  expect(await clipboard(page)).toBe(`${SMALL_DOC}\n`);
});
