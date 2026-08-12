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
