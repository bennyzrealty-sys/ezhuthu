/**
 * Downloading the document.
 *
 * Driven through the real button and the real download, because every failure
 * this feature can have lives in the last inch: a `download` attribute the
 * browser discards (ADR-0031), an object URL revoked before the fetch it
 * started has finished (src/ui/download.ts), a file that arrives with the
 * paragraphs in log order instead of document order.
 *
 * "I can't download an edited work" is the report that produced this file. The
 * app had a backup (the event log, as JSON) and a corpus export (revision
 * pairs, empty by design for a document that has only been written) — and no
 * way at all to get the writing out.
 */

import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { importCorpus, resetDatabase, SMALL_DOC } from './helpers';

test.beforeEach(async ({ page }) => {
  await resetDatabase(page);
});

test('an edited document downloads as the text that is on screen', async ({ page }) => {
  await importCorpus(page, SMALL_DOC);

  // Edit it, because the report was about edited work: the file has to carry
  // the current text, not the imported text.
  const first = page.locator('.block-row').first();
  await first.click();
  await page.locator('.block-editor').fill('തിരുത്തിയ ഒന്നാം ഖണ്ഡിക.');
  await page.locator('.block-editor').blur();
  await expect(page.locator('.block-row').first()).toContainText('തിരുത്തിയ');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('download-document').click(),
  ]);

  expect(download.suggestedFilename()).toMatch(/^ezhuthu-.+\.txt$/);

  const text = await readFile(await download.path(), 'utf8');
  expect(text).toBe(
    'തിരുത്തിയ ഒന്നാം ഖണ്ഡിക.\n\n' +
      'രണ്ടാം ഖണ്ഡിക. അവൻ ഒരു software engineer ആണ്.\n\n' +
      'മൂന്നാം ഖണ്ഡിക. വർഷം തോറും മഴ പെയ്യുന്നു.\n',
  );
  await expect(page.getByTestId('message')).toContainText('Downloaded 3 paragraphs');
});

test('a paragraph typed from scratch is in the file', async ({ page }) => {
  // The path the corpus export deliberately produces nothing for (ADR-0030):
  // new prose is not a revision. It is still the writer's work.
  await page.getByTestId('start-writing').click();
  await page.locator('.block-editor').fill('പുതിയ വാചകം.');
  await page.locator('.block-editor').blur();
  await expect(page.locator('.block-row').first()).toContainText('പുതിയ');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('download-document').click(),
  ]);

  expect(await readFile(await download.path(), 'utf8')).toBe('പുതിയ വാചകം.\n');
});

test('the file re-imports as the same document', async ({ page }) => {
  await importCorpus(page, SMALL_DOC);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('download-document').click(),
  ]);
  const exported = await readFile(await download.path(), 'utf8');

  // A fresh database, then the downloaded bytes back in through the real file
  // input. Byte-faithful in and out is what makes the download a backup a
  // person can actually read (ADR-0014).
  await resetDatabase(page);
  await importCorpus(page, exported);

  await expect(page.locator('.block-row')).toHaveCount(3);
  const [again] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('download-document').click(),
  ]);
  expect(await readFile(await again.path(), 'utf8')).toBe(exported);
});

test('a deleted paragraph is not in the file', async ({ page }) => {
  await importCorpus(page, SMALL_DOC);
  await page.locator('.block-row').first().click();
  await page.getByTestId('block-delete').click();
  await expect(page.locator('.block-row')).toHaveCount(2);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('download-document').click(),
  ]);

  const text = await readFile(await download.path(), 'utf8');
  expect(text).not.toContain('ഒന്നാം');
  expect(text).toContain('രണ്ടാം');
});

test('an empty document says so instead of handing over an empty file', async ({ page }) => {
  await page.getByTestId('download-document').click();
  await expect(page.getByTestId('message')).toContainText('Nothing to download yet');
});

/*
 * The report that reopened this file: the button existed, the writer used it,
 * and the file did not have his edit in it.
 *
 * The tests above all blur the editor first and then wait for the text to
 * appear in the read-only row — which is to say they wait for the commit, and
 * so they could never see this. A person does not do that. He types and taps
 * Download, and on a browser that does not move focus to a button on tap
 * (Safari and iOS do not) nothing blurs the editor, nothing commits, and the
 * export reads a `blocks` projection that is up to 400ms behind — or, for a
 * paragraph begun in the same breath, that holds an empty string. ADR-0036.
 *
 * These activate the button WITHOUT letting focus leave the field, which is
 * the only way to reproduce it in Chromium.
 */
async function tapWithoutBlurring(page: import('@playwright/test').Page, testId: string) {
  await page.evaluate((id) => {
    const button = document.querySelector(`[data-testid="${id}"]`);
    (button as HTMLButtonElement).click();
  }, testId);
}

test('a paragraph still being typed is in the file', async ({ page }) => {
  await page.getByTestId('start-writing').click();
  await page.locator('.block-editor').fill('എന്റെ തിരക്കഥ ഒന്നാം വരി.');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    tapWithoutBlurring(page, 'download-document'),
  ]);

  expect(await readFile(await download.path(), 'utf8')).toBe('എന്റെ തിരക്കഥ ഒന്നാം വരി.\n');
});

test('an edit still in the field beats the stored paragraph', async ({ page }) => {
  await importCorpus(page, SMALL_DOC);
  await page.locator('.block-row').first().click();
  await page.locator('.block-editor').fill('തിരുത്തിയ ഒന്നാം ഖണ്ഡിക.');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    tapWithoutBlurring(page, 'download-document'),
  ]);

  const text = await readFile(await download.path(), 'utf8');
  expect(text.startsWith('തിരുത്തിയ ഒന്നാം ഖണ്ഡിക.\n\n')).toBe(true);
  expect(text).not.toContain('കടൽ ശാന്തമായിരുന്നു');
});

test('the flushed edit is committed, not just written to the file', async ({ page }) => {
  // The download must not be the only place the writing survives: whatever it
  // took to build the file is in the log by the time the file exists.
  await page.getByTestId('start-writing').click();
  await page.locator('.block-editor').fill('ലോഗിലും ഉണ്ടാകണം.');
  await Promise.all([
    page.waitForEvent('download'),
    tapWithoutBlurring(page, 'download-document'),
  ]);

  await page.reload();
  await expect(page.locator('.block-row').first()).toContainText('ലോഗിലും ഉണ്ടാകണം.');
});

test('the button at the end of the document downloads too', async ({ page }) => {
  // The toolbar's Download is the seventh of ten identically weighted buttons.
  // This one is where the writing stops.
  await importCorpus(page, SMALL_DOC);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('download-document-end').click(),
  ]);
  expect(await readFile(await download.path(), 'utf8')).toContain('മൂന്നാം ഖണ്ഡിക.');
});

test('typing survives the app being put away before the commit timer', async ({ page }) => {
  /*
   * Not about downloading, and found while looking for it: the 400ms the
   * editor holds a draft for is a window in which the writing exists nowhere
   * but a ref. A phone that freezes the process — a swipe to the home screen,
   * a call — took the sentence with it. The signals queue already flushed on
   * `visibilitychange`; telemetry about the writing was durable and the
   * writing was not. ADR-0036.
   */
  await page.getByTestId('start-writing').click();
  await page.locator('.block-editor').fill('ഈ വാചകം നഷ്ടപ്പെടരുത്.');

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  await page.reload();
  await expect(page.locator('.block-row').first()).toContainText('നഷ്ടപ്പെടരുത്');
});
