/**
 * Search, end to end (ADR-0015).
 *
 * The unit tests cover the matcher and the cursor. What only a browser can
 * show is the part the feature exists for: finding a paragraph that is not in
 * the DOM, and getting the reader to it.
 */

import { expect, test } from '@playwright/test';
import { importCorpus, resetDatabase } from './helpers';

/** A document long enough that the target is nowhere near the rendered window. */
function longDocument(): string {
  const blocks = Array.from({ length: 400 }, (_, i) => `ഖണ്ഡിക ${i} — കടൽ ശാന്തമായിരുന്നു.`);
  blocks[312] = 'ഇവിടെ ഒരു അപൂർവ്വ വാക്ക് ഒളിച്ചിരിക്കുന്നു.';
  // Chillu written as a ZWJ sequence: identical on screen to the atomic form.
  blocks[188] = 'അവന്‍ ഒരു software engineer ആണ്.';
  return blocks.join('\n\n');
}

test.beforeEach(async ({ page }) => {
  await resetDatabase(page);
});

async function search(page: import('@playwright/test').Page, needle: string) {
  await page.getByTestId('search-toggle').click();
  await page.getByTestId('search-input').fill(needle);
}

test('finds a paragraph that was never rendered', async ({ page }) => {
  await importCorpus(page, longDocument());

  // The justification for ADR-0015 in one assertion: the target is not in the
  // DOM, so find-in-page could not reach it.
  await expect(page.locator('.block-row', { hasText: 'അപൂർവ്വ' })).toHaveCount(0);

  await search(page, 'അപൂർവ്വ');

  await expect(page.getByTestId('search-summary')).toHaveText('1 match in 1 paragraph');
  await expect(page.getByTestId('search-results').locator('.result')).toHaveCount(1);
  await expect(page.getByTestId('search-results')).toContainText('313');
});

test('scrolls to the result and marks it', async ({ page }) => {
  await importCorpus(page, longDocument());
  await search(page, 'അപൂർവ്വ');

  await page.getByTestId('search-results').locator('.result').first().click();

  const marked = page.locator('.block-row .block-match');
  await expect(marked).toBeVisible();
  await expect(marked).toHaveText('അപൂർവ്വ');
  await expect(page.locator('.block-row', { hasText: 'ഒളിച്ചിരിക്കുന്നു' })).toBeVisible();
});

test('finds a chillu word typed in the other form', async ({ page }) => {
  await importCorpus(page, longDocument());

  // The document has അവന്‍ as a ZWJ sequence; the query uses atomic അവൻ. Both
  // read as "അവൻ" and no normalisation form unifies them, so without the
  // chillu fold this finds nothing.
  await search(page, 'അവൻ');

  await expect(page.getByTestId('search-summary')).toHaveText('1 match in 1 paragraph');

  await page.getByTestId('search-results').locator('.result').first().click();
  // The mark covers the ZWJ sequence that is actually in storage, not the
  // four characters the folded form would have suggested.
  await expect(page.locator('.block-row .block-match')).toHaveText('അവന്‍');
});

test('ignores case for the Latin inside Malayalam prose', async ({ page }) => {
  await importCorpus(page, longDocument());
  await search(page, 'SOFTWARE');

  await expect(page.getByTestId('search-summary')).toHaveText('1 match in 1 paragraph');

  await page.getByRole('checkbox', { name: 'Match case' }).check();
  await expect(page.getByTestId('search-summary')).toHaveText('No matches');
});

test('steps through results with Enter', async ({ page }) => {
  await importCorpus(page, longDocument());
  await search(page, 'ഖണ്ഡിക 1');

  const results = page.getByTestId('search-results').locator('.result');
  await expect(results.first()).toBeVisible();
  const count = await results.count();
  expect(count).toBeGreaterThan(1);

  // First Enter opens result one, not result two.
  await page.getByTestId('search-input').press('Enter');
  await expect(results.nth(0)).toHaveClass(/current/);

  await page.getByTestId('search-input').press('Enter');
  await expect(results.nth(1)).toHaveClass(/current/);

  await page.getByTestId('search-input').press('Shift+Enter');
  await expect(results.nth(0)).toHaveClass(/current/);
});

test('whole word rejects the same letters inside a longer word', async ({ page }) => {
  await importCorpus(page, ['മഴ പെയ്തു.', 'മഴയത്ത് നനഞ്ഞു.'].join('\n\n'));

  await search(page, 'മഴ');
  await expect(page.getByTestId('search-summary')).toHaveText('2 matches in 2 paragraphs');

  await page.getByRole('checkbox', { name: 'Whole word' }).check();
  await expect(page.getByTestId('search-summary')).toHaveText('1 match in 1 paragraph');
});

test('reports no matches without pretending to have found something', async ({ page }) => {
  await importCorpus(page, longDocument());
  await search(page, 'ഇങ്ങനെയൊരു വാക്ക് ഇവിടെ ഇല്ല');

  await expect(page.getByTestId('search-summary')).toHaveText('No matches');
  await expect(page.getByTestId('search-results').locator('.result')).toHaveCount(0);
});

test('closing search clears the mark but not the scroll position', async ({ page }) => {
  await importCorpus(page, longDocument());
  await search(page, 'അപൂർവ്വ');
  await page.getByTestId('search-results').locator('.result').first().click();

  await expect(page.locator('.block-match')).toBeVisible();

  await page.getByTestId('search-toggle').click();

  await expect(page.locator('.block-match')).toHaveCount(0);
  // The reader asked to go here. Closing the panel is not a request to leave.
  await expect(page.locator('.block-row', { hasText: 'ഒളിച്ചിരിക്കുന്നു' })).toBeVisible();
});

test('editing a found block clears the mark rather than letting it drift', async ({ page }) => {
  await importCorpus(page, longDocument());
  await search(page, 'അപൂർവ്വ');
  await page.getByTestId('search-results').locator('.result').first().click();

  await page.locator('.block-row', { hasText: 'ഒളിച്ചിരിക്കുന്നു' }).click();

  await expect(page.locator('.block-editor')).toBeFocused();
  await expect(page.locator('.block-match')).toHaveCount(0);
});
