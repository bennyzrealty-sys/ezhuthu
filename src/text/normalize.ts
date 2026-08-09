/**
 * Normalisation for COMPARISON ONLY.
 *
 * Stored text keeps the bytes it arrived with, so import → export is
 * byte-faithful and a manuscript brought into the app comes out unchanged
 * (ADR-0014). Nothing here is ever applied on a write path.
 *
 * Every comparison of user text in the project goes through this module. Raw
 * `===` on user text is a bug — see docs/MALAYALAM.md Rule 2.
 */

import { clusterBoundaries } from './segmenter';

export const ZWJ = '‍';
export const ZWNJ = '‌';
const VIRAMA = '്';

/**
 * Atomic chillu ← <consonant, virama, ZWJ>.
 *
 * NFC does NOT do this. Unicode added the atomic chillu characters in 5.1
 * specifically so the two forms could be told apart, so they are deliberately
 * not canonically equivalent and no normalisation form will unify them. Left
 * unfolded, a search for a word visible on screen silently returns nothing.
 *
 * (U+0D7C CHILLU RR is mapped from ര RA per the Unicode chillu table; the "RR"
 * in its name is a naming artefact, not a reference to റ RRA.)
 */
const CHILLU_BASES: ReadonlyArray<readonly [base: string, atomic: string]> = [
  ['ണ', 'ൺ'], // ണ → ൺ
  ['ന', 'ൻ'], // ന → ൻ
  ['ര', 'ർ'], // ര → ർ
  ['ല', 'ൽ'], // ല → ൽ
  ['ള', 'ൾ'], // ള → ൾ
  ['ക', 'ൿ'], // ക → ൿ
];

const CHILLU_PATTERN = new RegExp(
  `([${CHILLU_BASES.map(([base]) => base).join('')}])${VIRAMA}${ZWJ}`,
  'g',
);

const CHILLU_MAP = new Map(CHILLU_BASES);

/** Fold legacy ZWJ chillu sequences to their atomic characters. */
export function foldChillu(text: string): string {
  if (!text.includes(ZWJ)) return text;
  return text.replace(CHILLU_PATTERN, (whole, base: string) => CHILLU_MAP.get(base) ?? whole);
}

export interface FoldOptions {
  /**
   * Case-fold before normalising. Malayalam is unicameral, so this only ever
   * affects the Latin that runs through the middle of Malayalam prose —
   * technical terms, names, citations (docs/MALAYALAM.md Rule 6).
   *
   * Lowercasing first and normalising after, not the other way round: a few
   * codepoints lowercase into sequences that are not in NFC (U+0130 İ becomes
   * i + U+0307), and normalising before that would leave them decomposed.
   */
  caseInsensitive?: boolean;
}

/**
 * The canonical comparison form: NFC, then the chillu fold.
 *
 * NFC alone handles the vowel signs that have canonical decompositions
 * (ൊ ോ ൌ), which keyboards produce inconsistently. It does not handle chillu.
 * Both halves are needed and both are asserted by tests.
 */
export function normalizeForCompare(text: string, options: FoldOptions = {}): string {
  const cased = options.caseInsensitive === true ? text.toLowerCase() : text;
  return foldChillu(cased.normalize('NFC'));
}

export function equals(a: string, b: string, options?: FoldOptions): boolean {
  return normalizeForCompare(a, options) === normalizeForCompare(b, options);
}

export function includes(haystack: string, needle: string, options?: FoldOptions): boolean {
  return normalizeForCompare(haystack, options).includes(normalizeForCompare(needle, options));
}

export function indexOfNormalized(haystack: string, needle: string, from = 0): number {
  return normalizeForCompare(haystack).indexOf(normalizeForCompare(needle), from);
}

/**
 * The comparison form, plus a way back to the original string.
 *
 * WHY THIS EXISTS. `normalizeForCompare` changes length. `അവന്‍` is five
 * codepoints and folds to four; a decomposed `ോ` is two and composes to one.
 * So an offset into the folded text is not an offset into what the user typed,
 * and the gap grows with how much Malayalam precedes it. A search that reports
 * folded offsets highlights the wrong characters, and does so only in
 * Malayalam, and only further into the paragraph — the kind of bug that gets
 * reported as "the highlight drifts" and never reproduced on ASCII.
 *
 * The mapping is per grapheme cluster rather than per character, because
 * neither normalisation nor case folding is a per-character operation and both
 * stay inside a cluster: combining marks belong to the cluster of their base by
 * definition, and the chillu sequence C + virama + ZWJ is one cluster.
 * `tests/unit/text.test.ts` asserts that folding cluster-by-cluster and folding
 * the whole string agree, over every string in docs/MALAYALAM.md.
 *
 * A match therefore resolves to whole clusters: `sourceStart` of its first
 * folded character, `sourceEnd` of its last. Slightly generous at the edges,
 * and correct by construction — a highlight can never bisect a glyph.
 */
export interface FoldedText {
  /** The comparison form of the whole input. */
  text: string;
  /** Per folded character: where its source cluster starts in the original. */
  sourceStart: Int32Array;
  /** Per folded character: where its source cluster ends in the original. */
  sourceEnd: Int32Array;
  /** The original, unmodified. */
  source: string;
}

export function foldWithOffsets(source: string, options: FoldOptions = {}): FoldedText {
  const boundaries = clusterBoundaries(source);
  const parts: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];

  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const from = boundaries[i]!;
    const to = boundaries[i + 1]!;
    const folded = normalizeForCompare(source.slice(from, to), options);
    parts.push(folded);
    for (let n = 0; n < folded.length; n += 1) {
      starts.push(from);
      ends.push(to);
    }
  }

  return {
    text: parts.join(''),
    sourceStart: Int32Array.from(starts),
    sourceEnd: Int32Array.from(ends),
    source,
  };
}

/**
 * Explicit, user-invoked normalisation of stored text. This is a visible edit
 * that appends events like any other change — never applied automatically
 * (ADR-0014).
 */
export function normalizeForStorage(text: string): string {
  return text.normalize('NFC');
}
