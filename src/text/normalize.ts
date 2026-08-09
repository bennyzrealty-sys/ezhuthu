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

/**
 * The canonical comparison form: NFC, then the chillu fold.
 *
 * NFC alone handles the vowel signs that have canonical decompositions
 * (ൊ ോ ൌ), which keyboards produce inconsistently. It does not handle chillu.
 * Both halves are needed and both are asserted by tests.
 */
export function normalizeForCompare(text: string): string {
  return foldChillu(text.normalize('NFC'));
}

export function equals(a: string, b: string): boolean {
  return normalizeForCompare(a) === normalizeForCompare(b);
}

export function includes(haystack: string, needle: string): boolean {
  return normalizeForCompare(haystack).includes(normalizeForCompare(needle));
}

export function indexOfNormalized(haystack: string, needle: string, from = 0): number {
  return normalizeForCompare(haystack).indexOf(normalizeForCompare(needle), from);
}

/**
 * Explicit, user-invoked normalisation of stored text. This is a visible edit
 * that appends events like any other change — never applied automatically
 * (ADR-0014).
 */
export function normalizeForStorage(text: string): string {
  return text.normalize('NFC');
}
