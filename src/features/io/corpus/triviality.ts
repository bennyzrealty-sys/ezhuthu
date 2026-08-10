/**
 * The triviality filter (ADR-0012).
 *
 * The corpus wants meaningful revisions. Left unfiltered it is dominated by
 * autosave noise — which session coalescing removes — and by typo corrections,
 * which it does not: a writer fixing a vowel sign produces exactly the same
 * shape of event as a writer choosing a better word, and only the size and
 * kind of the change tell them apart.
 *
 * PURE, and an EXPORT-TIME filter over an intact log. Nothing here is applied
 * on a write path, nothing is discarded from storage, and changing a threshold
 * re-runs over full history. That is the property that makes it acceptable to
 * be wrong about any of these numbers.
 */

import { normalizeForCompare } from '../../../text/normalize';
import { clusterDistance } from '../../../text/distance';
import { isEffectivelyEmpty } from '../../../text/count';
import type { EditPair } from './pairs';
import { TRIVIAL_MAX_CLUSTERS, TRIVIAL_MAX_WORD_CLUSTERS } from './constants';

export type TrivialReason =
  /** The two sides are the same text once folded. Re-encoding, or an undo. */
  | 'unchanged'
  /** One side is nothing: composition or erasure, not revision. */
  | 'empty'
  /** One grapheme cluster changed. */
  | 'single-cluster'
  /** Only spacing and punctuation moved. */
  | 'punctuation'
  /** Every word that changed is a misspelling of the word it replaced. */
  | 'correction';

/**
 * Everything except letters, marks, digits and the zero-width joiners.
 *
 * ZWJ and ZWNJ are inside a word, not punctuation (Rule 3): stripping them
 * would make `അവന്‍` and `അവന്` the same skeleton, and a ZWNJ added or removed
 * changes which conjunct is displayed — a real edit that would then vanish from
 * the corpus as "punctuation".
 */
const NOT_WORD_CHAR = /[^\p{L}\p{M}\p{N}‌‍]+/gu;

function skeleton(text: string): string {
  return normalizeForCompare(text).replace(NOT_WORD_CHAR, '');
}

/** Folded words, in order. Splitting on whitespace, as `countWords` does. */
function words(text: string): string[] {
  const folded = normalizeForCompare(text).trim();
  return folded === '' ? [] : folded.split(/\s+/);
}

/**
 * Did every word that changed merely change its spelling?
 *
 * Requires the same number of words, so nothing was added or taken away, and
 * then asks of each differing pair whether the second is a near-miss of the
 * first. That is what separates a typo from a word choice, and it is a question
 * about the WORD — at paragraph scale both changes are a rounding error
 * (ADR-0032).
 */
function everyChangedWordIsAMisspelling(before: string, after: string): boolean {
  const from = words(before);
  const to = words(after);
  if (from.length !== to.length || from.length === 0) return false;

  let changed = 0;
  for (const [i, word] of from.entries()) {
    const other = to[i]!;
    if (word === other) continue;
    changed += 1;
    if (clusterDistance(word, other, { max: TRIVIAL_MAX_WORD_CLUSTERS }) > TRIVIAL_MAX_WORD_CLUSTERS) {
      return false;
    }
  }
  return changed > 0;
}

/**
 * Why this pair is not worth keeping, or null when it is.
 *
 * Returns the reason rather than a boolean so the export can report what it
 * dropped and why. A filter that silently removes most of its input is
 * indistinguishable from a filter that is broken.
 */
export function trivialReason(pair: Pick<EditPair, 'before' | 'after'>): TrivialReason | null {
  const { before, after } = pair;

  // Folded, so the two encodings of a chillu are one text (Rule 5). This is
  // what keeps a keyboard change out of the corpus: re-encoding a manuscript
  // rewrites every paragraph in it and revises none of them.
  if (normalizeForCompare(before) === normalizeForCompare(after)) return 'unchanged';

  // Writing a paragraph from nothing, or emptying one. Both are real acts and
  // neither answers "how did this sentence change" — the same reasoning that
  // keeps deletions out of the pairs at all (see pairs.ts).
  if (isEffectivelyEmpty(before) || isEffectivelyEmpty(after)) return 'empty';

  // Only whether it is at most one cluster is ever asked, so the cutoff is set
  // to just past the answer rather than to a figure that would have to be
  // computed exactly and then thrown away.
  if (clusterDistance(before, after, { max: TRIVIAL_MAX_CLUSTERS }) <= TRIVIAL_MAX_CLUSTERS) {
    return 'single-cluster';
  }

  // Reflowing, joining sentences, fixing a stray space. The letters are
  // untouched, so whatever changed was not the prose.
  if (skeleton(before) === skeleton(after)) return 'punctuation';

  if (everyChangedWordIsAMisspelling(before, after)) return 'correction';

  return null;
}

export function isTrivial(pair: Pick<EditPair, 'before' | 'after'>): boolean {
  return trivialReason(pair) !== null;
}

/** Tally of what a filtering pass dropped, keyed by reason. */
export type TrivialTally = Record<TrivialReason, number>;

export function emptyTally(): TrivialTally {
  return {
    unchanged: 0,
    empty: 0,
    'single-cluster': 0,
    punctuation: 0,
    correction: 0,
  };
}

/**
 * Keep the pairs worth exporting, counting what went and why.
 *
 * The tally is threaded through rather than returned fresh, so an export can
 * accumulate one across every block it walks.
 */
export function filterTrivial<T extends Pick<EditPair, 'before' | 'after'>>(
  pairs: readonly T[],
  tally: TrivialTally = emptyTally(),
): { kept: T[]; tally: TrivialTally } {
  const kept: T[] = [];
  for (const pair of pairs) {
    const reason = trivialReason(pair);
    if (reason === null) kept.push(pair);
    else tally[reason] += 1;
  }
  return { kept, tally };
}
