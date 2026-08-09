/**
 * Counting. Words for the document metadata, graphemes for anything the user
 * sees as "characters".
 *
 * Grapheme-level cursor and selection operations arrive in Phase 3
 * (src/text/segmenter.ts). This module only counts.
 */

import { normalizeForCompare, ZWJ, ZWNJ } from './normalize';

/**
 * Malayalam separates words with spaces, so splitting on whitespace works.
 *
 * ZWJ and ZWNJ are NOT whitespace and must never split a word — they control
 * conjunct and chillu formation, and treating them as separators both inflates
 * the count and, if anything ever strips them, changes the spelling
 * (docs/MALAYALAM.md Rule 3).
 *
 * Normalises first so the figure is stable regardless of input encoding.
 */
export function countWords(text: string): number {
  const normalized = normalizeForCompare(text).trim();
  if (normalized === '') return 0;
  return normalized.split(/\s+/).length;
}

/** Words in a whole document, from block texts. */
export function countWordsInBlocks(texts: readonly string[]): number {
  let total = 0;
  for (const t of texts) total += countWords(t);
  return total;
}

/**
 * Characters as a reader would count them, not codepoints. `"നി".length` is 2
 * and the user sees one character.
 *
 * Falls back to codepoint counting where Intl.Segmenter is unavailable, which
 * over-counts but never throws.
 */
export function countGraphemes(text: string, locale = 'ml'): number {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    let n = 0;
    for (const _ of segmenterFor(locale).segment(text)) n += 1;
    return n;
  }
  return [...text].length;
}

const segmenterCache = new Map<string, Intl.Segmenter>();

/**
 * Segmenter construction is expensive and this runs on the caret path.
 * Instances are cached per locale — never construct one at a call site.
 */
function segmenterFor(locale: string): Intl.Segmenter {
  let s = segmenterCache.get(locale);
  if (s === undefined) {
    s = new Intl.Segmenter(locale, { granularity: 'grapheme' });
    segmenterCache.set(locale, s);
  }
  return s;
}

/** True if the string contains only the zero-width joiners and whitespace. */
export function isEffectivelyEmpty(text: string): boolean {
  return text.replaceAll(ZWJ, '').replaceAll(ZWNJ, '').trim() === '';
}
