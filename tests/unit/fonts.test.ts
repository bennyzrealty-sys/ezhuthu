/**
 * The bundled font must still be able to shape Malayalam (ADR-0019).
 *
 * This asserts against the committed woff2 — the file that actually ships —
 * rather than against the subsetter's flags, because the flags are only
 * evidence about the last time someone ran the script.
 *
 * What this test cannot see is whether the shaper produces the right glyphs;
 * jsdom has no layout. That assertion is in tests/e2e/fonts.spec.ts, which
 * measures a real conjunct in a real browser. This one is the fast guard that
 * runs on every push.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { featureTags, readWoff2 } from './woff2';

const read = (path: string) =>
  readWoff2(readFileSync(fileURLToPath(new URL(path, import.meta.url))));

const BUNDLED = '../../public/fonts/manjari-regular.woff2';

/**
 * Every GSUB feature Malayalam conjunct formation goes through. Lose one and a
 * whole class of clusters stops forming — `half` alone is every C+virama+C
 * conjunct in the document.
 */
const REQUIRED_GSUB = ['akhn', 'blwf', 'blws', 'half', 'haln', 'pref', 'pres', 'psts', 'pstf'];

describe('bundled Manjari', () => {
  const font = read(BUNDLED);

  it('keeps the tables the shaper needs', () => {
    expect([...font.tables.keys()]).toEqual(expect.arrayContaining(['GSUB', 'GPOS', 'GDEF', 'cmap']));
  });

  it('keeps every Malayalam shaping feature', () => {
    expect(featureTags(font, 'GSUB')).toEqual(expect.arrayContaining(REQUIRED_GSUB));
  });

  it('keeps mark positioning', () => {
    // Malayalam stacks marks above and below the base. Without GPOS features
    // they land at the origin and pile up on each other.
    expect(featureTags(font, 'GPOS')).toEqual(expect.arrayContaining(['abvm', 'kern']));
  });

  it('keeps the glyphs those features substitute in', () => {
    /*
     * The second way to break this, and the quieter one: `--no-layout-closure`
     * keeps the feature list intact and drops every glyph reachable only
     * through it, so a feature-tag check alone passes. Manjari subsets to 828
     * glyphs with closure and 323 without.
     */
    expect(font.numGlyphs).toBeGreaterThan(600);
  });

  it('stays inside its share of the cold-open budget', () => {
    // Precached and on the first-paint path (font-display: block), so its size
    // is time the reader spends looking at nothing on a cold offline open.
    const bytes = readFileSync(fileURLToPath(new URL(BUNDLED, import.meta.url))).byteLength;
    expect(bytes).toBeLessThan(100 * 1024);
  });
});

/*
 * Proof that the assertions above can fail. Both fixtures are three-codepoint
 * subsets of the same source face; only the subsetter flags differ. See
 * tests/fixtures/fonts/README.md.
 */
describe('the failure this guards against', () => {
  it('is detected: a font subset with --layout-features=""', () => {
    const stripped = read('../fixtures/fonts/tiny-layout-stripped.woff2');

    // The table survives — which is why "does GSUB exist" is not the test.
    expect(stripped.tables.has('GSUB')).toBe(true);
    expect(featureTags(stripped, 'GSUB')).toEqual([]);
  });

  it('is not a false positive: the same subset with the features kept', () => {
    const kept = read('../fixtures/fonts/tiny-layout-kept.woff2');
    expect(featureTags(kept, 'GSUB')).toEqual(expect.arrayContaining(['akhn', 'half', 'haln']));
  });
});
