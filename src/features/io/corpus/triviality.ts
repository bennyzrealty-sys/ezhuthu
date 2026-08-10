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
import { clusterChange } from '../../../text/distance';
import { countWords, isEffectivelyEmpty } from '../../../text/count';
import type { EditPair } from './pairs';
import {
  DISTANCE_CUTOFF_CLUSTERS,
  TRIVIAL_MAX_CLUSTERS,
  TRIVIAL_MAX_RATIO,
} from './constants';

export type TrivialReason =
  /** The two sides are the same text once folded. Re-encoding, or an undo. */
  | 'unchanged'
  /** One side is nothing: composition or erasure, not revision. */
  | 'empty'
  /** One grapheme cluster changed. */
  | 'single-cluster'
  /** Only spacing and punctuation moved. */
  | 'punctuation'
  /** A small proportional change that added and removed no words. */
  | 'sub-threshold';

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

  const change = clusterChange(before, after, { max: DISTANCE_CUTOFF_CLUSTERS });
  if (change.distance <= TRIVIAL_MAX_CLUSTERS) return 'single-cluster';

  // Reflowing, joining sentences, fixing a stray space. The letters are
  // untouched, so whatever changed was not the prose.
  if (skeleton(before) === skeleton(after)) return 'punctuation';

  if (!change.exceeded && change.ratio < TRIVIAL_MAX_RATIO) {
    // Words neither added nor removed: the change stayed inside the words that
    // were already there, which is the shape of a correction rather than a
    // rewrite.
    if (countWords(before) === countWords(after)) return 'sub-threshold';
  }

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
    'sub-threshold': 0,
  };
}

/** Keep the pairs worth exporting, counting what went and why. */
export function filterTrivial(
  pairs: readonly EditPair[],
  tally: TrivialTally = emptyTally(),
): { kept: EditPair[]; tally: TrivialTally } {
  const kept: EditPair[] = [];
  for (const pair of pairs) {
    const reason = trivialReason(pair);
    if (reason === null) kept.push(pair);
    else tally[reason] += 1;
  }
  return { kept, tally };
}
