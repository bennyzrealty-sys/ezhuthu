/**
 * Does the bundled font actually shape Malayalam? (ADR-0019, Rule 7.)
 *
 * tests/unit/fonts.test.ts asserts the layout tables survived subsetting, which
 * is necessary and not sufficient — it inspects the file, not the shaper. This
 * one puts the font in front of a real HarfBuzz and measures what comes out.
 *
 * The assertion is comparative, not a hardcoded pixel width: absolute advances
 * depend on the platform's rasteriser and would make this a test that fails
 * when the CI image changes. What cannot vary is the *relationship* between a
 * conjunct and the same consonants with the conjunct suppressed.
 */

import { expect, test } from '@playwright/test';

/** ക + virama + ക — forms the kka conjunct through GSUB. */
const CONJUNCT = 'ക്ക';
/** The same, with ZWNJ after the virama: chandrakkala form, no conjunct. */
const SUPPRESSED = 'ക്‌ക';
/** Four-consonant stack, the hardest shaping case in docs/MALAYALAM.md. */
const DEEP_STACK = 'ഗ്ദ്ധ';
const DEEP_SUPPRESSED = 'ഗ്‌ദ്‌ധ';

/** Width of a string laid out at a fixed size in the given family. */
async function measure(page: import('@playwright/test').Page, text: string, family: string) {
  return page.evaluate(
    ([t, f]) => {
      const span = document.createElement('span');
      span.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:32px ${f}`;
      span.textContent = t;
      document.body.append(span);
      const width = span.getBoundingClientRect().width;
      span.remove();
      return width;
    },
    [text, family] as const,
  );
}

test.describe('bundled Manjari', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // font-display: block means layout is already waiting on this, but the
    // measurement below must not race the load on a slow cold start.
    await page.evaluate(() => document.fonts.load('32px Manjari').then(() => undefined));
  });

  test('loads from our own origin', async ({ page }) => {
    expect(await page.evaluate(() => document.fonts.check('32px Manjari'))).toBe(true);

    // Rule 9: no font CDN, ever. A same-origin check here is what stops a
    // future "just use Google Fonts, it's faster" change passing review.
    const sources = await page.evaluate(() =>
      performance
        .getEntriesByType('resource')
        .filter((e) => e.name.includes('.woff'))
        .map((e) => new URL(e.name).origin),
    );
    expect(sources.length).toBeGreaterThan(0);
    for (const origin of sources) expect(origin).toBe(new URL(page.url()).origin);
  });

  test('forms conjuncts — GSUB survived subsetting', async ({ page }) => {
    const conjunct = await measure(page, CONJUNCT, 'Manjari');
    const suppressed = await measure(page, SUPPRESSED, 'Manjari');

    /*
     * This is the whole test. With the layout features stripped, ക്ക renders
     * as two consonants with a visible virama between them — which is exactly
     * what the ZWNJ form asks for — so the two widths collapse to the same
     * number. They differ only if the shaper substituted a conjunct glyph.
     *
     * ZWNJ itself has zero advance, so it contributes nothing to the gap.
     */
    expect(conjunct).toBeGreaterThan(0);
    expect(Math.abs(conjunct - suppressed)).toBeGreaterThan(1);
    // The conjunct is a stacked ligature, so it is the narrower of the two.
    expect(conjunct).toBeLessThan(suppressed);
  });

  test('forms a four-consonant stack', async ({ page }) => {
    const stacked = await measure(page, DEEP_STACK, 'Manjari');
    const suppressed = await measure(page, DEEP_SUPPRESSED, 'Manjari');

    expect(stacked).toBeGreaterThan(0);
    expect(stacked).toBeLessThan(suppressed);
  });

  test('renders document text in Manjari, not the device font', async ({ page }) => {
    const family = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.className = 'block-row';
      document.body.append(probe);
      const value = getComputedStyle(probe).fontFamily;
      probe.remove();
      return value;
    });
    expect(family.startsWith('Manjari')).toBe(true);
  });
});
