/**
 * Substring matching over Malayalam and English text.
 *
 * Pure — no Dexie, no DOM. The store cursor that drives it is in
 * features/search/, and it never touches rendered nodes: only ~12 of 1,563
 * blocks are in the DOM, so anything DOM-based finds a rounding error's worth
 * of the document (ADR-0015).
 *
 * Matching is done on the folded comparison form of both sides
 * (text/normalize.ts) and reported in offsets into the ORIGINAL text. The fold
 * is the entire reason the feature works: `അവൻ` typed with an atomic chillu
 * and `അവന്‍` typed as a ZWJ sequence are the same word on screen and
 * different bytes in storage, and no Unicode normalisation form unifies them.
 * Search on raw strings silently returns nothing for a word the reader is
 * looking at.
 */

import { clusterBoundaries } from './segmenter';
import { foldWithOffsets, normalizeForCompare, type FoldOptions } from './normalize';

export interface SearchQuery {
  needle: string;
  /** Default false. Malayalam is unicameral; this is for the Latin in it. */
  caseSensitive?: boolean;
  /** Match only at word boundaries. */
  wholeWord?: boolean;
}

/** A match, in offsets into the original (unfolded) text. */
export interface Match {
  start: number;
  end: number;
}

/**
 * A query with its needle already folded. Folding the needle once per search
 * rather than once per block is the difference between one fold and 1,563.
 */
export interface CompiledQuery {
  readonly folded: string;
  readonly wholeWord: boolean;
  readonly fold: FoldOptions;
}

/**
 * Word characters for whole-word matching.
 *
 * ZWJ and ZWNJ are explicitly INSIDE a word. They are not whitespace and not
 * separators (docs/MALAYALAM.md Rule 3) — treating them as boundaries would
 * make `അവന്‍` two words, and a whole-word search for it would then match
 * inside longer words.
 */
const WORD_CHAR = /[\p{L}\p{M}\p{N}‌‍_]/u;

/**
 * Prepare a query. Returns null when there is nothing to search for, which is
 * a normal state — the search field is empty most of the time — and not an
 * error the caller should have to distinguish.
 *
 * Note the needle is not trimmed. Searching for a trailing space is a
 * legitimate thing to do while editing prose, and silently trimming it makes
 * the result set inexplicable.
 */
export function compileQuery(query: SearchQuery): CompiledQuery | null {
  const fold: FoldOptions = { caseInsensitive: query.caseSensitive !== true };
  const folded = normalizeForCompare(query.needle, fold);
  if (folded.length === 0) return null;
  return { folded, wholeWord: query.wholeWord === true, fold };
}

function isWordChar(text: string, at: number): boolean {
  if (at < 0 || at >= text.length) return false;
  return WORD_CHAR.test(text[at]!);
}

function boundedHere(haystack: string, start: number, end: number): boolean {
  return !isWordChar(haystack, start - 1) && !isWordChar(haystack, end);
}

/**
 * Cheap "is it in here at all". No offset map is built, so this is what the
 * store cursor runs against every block; the mapping cost is paid only by the
 * blocks that matched.
 */
export function hasMatch(text: string, query: CompiledQuery): boolean {
  const folded = normalizeForCompare(text, query.fold);
  if (!query.wholeWord) return folded.includes(query.folded);

  let at = folded.indexOf(query.folded);
  while (at !== -1) {
    if (boundedHere(folded, at, at + query.folded.length)) return true;
    at = folded.indexOf(query.folded, at + 1);
  }
  return false;
}

/**
 * Every match in `text`, as offsets into `text` itself.
 *
 * Matches do not overlap: the scan resumes at the end of the one it just
 * found, which is what a reader stepping through results expects.
 */
export function findMatches(text: string, query: CompiledQuery, limit = Infinity): Match[] {
  const out: Match[] = [];
  if (limit <= 0) return out;

  const folded = foldWithOffsets(text, query.fold);
  const { text: haystack, sourceStart, sourceEnd } = folded;
  const width = query.folded.length;

  let at = haystack.indexOf(query.folded);
  while (at !== -1) {
    const end = at + width;
    if (!query.wholeWord || boundedHere(haystack, at, end)) {
      out.push({ start: sourceStart[at]!, end: sourceEnd[end - 1]! });
      if (out.length >= limit) return out;
      at = haystack.indexOf(query.folded, end);
    } else {
      /*
       * One character, not one match. A needle containing a separator can
       * have a real match starting inside a candidate that was just
       * rejected — `a a` in `xa a a` — and resuming at `end` walks past it.
       */
      at = haystack.indexOf(query.folded, at + 1);
    }
  }

  return out;
}

export function countMatches(text: string, query: CompiledQuery): number {
  return findMatches(text, query).length;
}

/**
 * A window of text around a match, for a result row.
 *
 * Sized in grapheme clusters, not characters, and cut only at cluster
 * boundaries: `text.slice(0, 40)` on Malayalam severs a vowel sign from its
 * base and renders a dotted circle (Rule 1).
 */
export interface Excerpt {
  text: string;
  /** Offsets of the match within `text`. */
  matchStart: number;
  matchEnd: number;
  /** Text was dropped from that side. */
  elidedBefore: boolean;
  elidedAfter: boolean;
}

export function excerptAround(source: string, match: Match, radiusClusters = 20): Excerpt {
  const boundaries = clusterBoundaries(source);

  // The cluster the match begins in, and the one it ends in.
  let firstCluster = 0;
  let lastCluster = boundaries.length - 2;
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    if (boundaries[i]! <= match.start) firstCluster = i;
    if (boundaries[i]! < match.end) lastCluster = i;
  }

  const from = boundaries[Math.max(0, firstCluster - radiusClusters)]!;
  const to = boundaries[Math.min(boundaries.length - 1, lastCluster + 1 + radiusClusters)]!;

  return {
    text: source.slice(from, to),
    matchStart: match.start - from,
    matchEnd: match.end - from,
    elidedBefore: from > 0,
    elidedAfter: to < source.length,
  };
}
