/**
 * The edit-corpus export (ADR-0016).
 *
 * Driven through the real button and the real download, because the file
 * reaching the user's disk is the feature — everything upstream of that is
 * covered by the unit tests.
 */

import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { importCorpus, resetDatabase, SMALL_DOC } from './helpers';

test.beforeEach(async ({ page }) => {
  await resetDatabase(page);
});

/** Rewrite the first paragraph, committing on blur. */
async function revise(page: import('@playwright/test').Page, text: string): Promise<void> {
  await page.locator('.block-row').first().click();
  const editor = page.locator('.block-editor');
  await editor.fill(text);
  await editor.blur();
  await expect(page.locator('.block-row').first()).toContainText(text.slice(0, 8));
}

test('writes the revisions to a JSONL file', async ({ page }) => {
  await importCorpus(page, SMALL_DOC);
  await revise(page, 'ഒന്നാം ഖണ്ഡിക മാറ്റി എഴുതി. കടൽ ഇളകിമറിഞ്ഞു, ആകാശം ഇരുണ്ടു.');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('corpus-export').click(),
  ]);

  expect(download.suggestedFilename()).toMatch(/^ezhuthu-corpus-.+\.jsonl$/);

  const path = await download.path();
  const lines = (await readFile(path, 'utf8')).trim().split('\n');
  expect(lines).toHaveLength(1);

  const record = JSON.parse(lines[0]!) as Record<string, unknown>;
  expect(Object.keys(record).sort()).toEqual(['after', 'before', 'revisionIndex', 'ts']);
  expect(record.before).toContain('ഒന്നാം ഖണ്ഡിക. കടൽ');
  expect(record.after).toContain('ഇളകിമറിഞ്ഞു');

  await expect(page.getByTestId('message')).toContainText('Exported 1');
});

test('collapses a burst of commits into one revision', async ({ page }) => {
  await importCorpus(page, SMALL_DOC);

  // Three commits within seconds: one act of revision (ADR-0012).
  await revise(page, 'ആദ്യ തിരുത്ത് ഇവിടെ വന്നു, കടൽ ശാന്തമായിരുന്നു.');
  await revise(page, 'രണ്ടാം തിരുത്ത് ഇവിടെ വന്നു, കാറ്റ് നിലച്ചിരുന്നു.');
  await revise(page, 'മൂന്നാം തിരുത്ത് ഇവിടെ വന്നു, ആകാശം തെളിഞ്ഞിരുന്നു.');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('corpus-export').click(),
  ]);

  const lines = (await readFile(await download.path(), 'utf8')).trim().split('\n');
  expect(lines).toHaveLength(1);

  const record = JSON.parse(lines[0]!) as { before: string; after: string };
  expect(record.before).toContain('ഒന്നാം ഖണ്ഡിക');
  expect(record.after).toContain('മൂന്നാം തിരുത്ത്');
});

test('says there is nothing to export rather than writing an empty file', async ({ page }) => {
  await importCorpus(page, SMALL_DOC);

  // An import is not a revision: every block was written once.
  await page.getByTestId('corpus-export').click();

  await expect(page.getByTestId('message')).toContainText('No revisions yet');
});

test('drops a correction and says nothing was worth exporting', async ({ page }) => {
  await importCorpus(page, 'അവൻ ഒരു software engineer ആണ്.');

  // One character. A typo fix is not style (ADR-0012).
  await revise(page, 'അവൾ ഒരു software engineer ആണ്.');

  await page.getByTestId('corpus-export').click();
  await expect(page.getByTestId('message')).toContainText('all of them corrections');
});
