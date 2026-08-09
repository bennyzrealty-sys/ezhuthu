/**
 * Grapheme-cluster operations. EVERY user-facing cursor, selection and
 * character operation goes through here.
 *
 * `"നി".length` is 2 and the user sees one character. Indexing raw UTF-16
 * offsets splits a base consonant from its vowel sign: backspace eats half a
 * glyph, the caret lands inside a character, and the next keystroke inserts
 * into the middle of it.
 *
 * Segmenter construction is expensive and this runs on the caret path, so
 * instances are cached per locale. Never construct one at a call site.
 */

const cache = new Map<string, Intl.Segmenter>();

export const DEFAULT_LOCALE = 'ml';

function segmenter(locale: string): Intl.Segmenter {
  let s = cache.get(locale);
  if (s === undefined) {
    s = new Intl.Segmenter(locale, { granularity: 'grapheme' });
    cache.set(locale, s);
  }
  return s;
}

export function graphemes(text: string, locale = DEFAULT_LOCALE): string[] {
  return [...segmenter(locale).segment(text)].map((s) => s.segment);
}

export function graphemeCount(text: string, locale = DEFAULT_LOCALE): number {
  let n = 0;
  for (const _ of segmenter(locale).segment(text)) n += 1;
  return n;
}

/**
 * Every UTF-16 offset at which a grapheme cluster starts, plus `text.length`.
 * Always begins with 0, so it is never empty.
 */
export function clusterBoundaries(text: string, locale = DEFAULT_LOCALE): number[] {
  const out: number[] = [];
  for (const s of segmenter(locale).segment(text)) out.push(s.index);
  out.push(text.length);
  return out;
}

/**
 * Snap a raw UTF-16 offset to the nearest cluster boundary.
 *
 * This is what the tap-to-caret handoff needs: the browser reports a hit
 * position that may fall inside a cluster, and placing the caret there is what
 * produces the "cursor jumps when I type" bug.
 */
export function snapToClusterBoundary(
  text: string,
  offset: number,
  locale = DEFAULT_LOCALE,
): number {
  if (offset <= 0) return 0;
  if (offset >= text.length) return text.length;

  const boundaries = clusterBoundaries(text, locale);
  let best = 0;
  for (const b of boundaries) {
    if (b === offset) return offset;
    if (Math.abs(b - offset) < Math.abs(best - offset)) best = b;
    if (b > offset) break;
  }
  return best;
}

/** The boundary at or before `offset`. Used when a caret must not drift forward. */
export function floorToClusterBoundary(
  text: string,
  offset: number,
  locale = DEFAULT_LOCALE,
): number {
  if (offset <= 0) return 0;
  if (offset >= text.length) return text.length;
  let last = 0;
  for (const b of clusterBoundaries(text, locale)) {
    if (b > offset) break;
    last = b;
  }
  return last;
}

/** Offset one cluster back from `offset`, for cursor movement and backspace. */
export function previousClusterBoundary(
  text: string,
  offset: number,
  locale = DEFAULT_LOCALE,
): number {
  const floored = floorToClusterBoundary(text, offset, locale);
  if (floored <= 0) return 0;
  const boundaries = clusterBoundaries(text, locale);
  const i = boundaries.indexOf(floored);
  return i > 0 ? boundaries[i - 1]! : 0;
}

/** Offset one cluster forward from `offset`. */
export function nextClusterBoundary(
  text: string,
  offset: number,
  locale = DEFAULT_LOCALE,
): number {
  if (offset >= text.length) return text.length;
  for (const b of clusterBoundaries(text, locale)) {
    if (b > offset) return b;
  }
  return text.length;
}

/**
 * Truncate to at most `maxClusters`, never cutting a cluster in half.
 *
 * Used by every preview label — the resume strip, ghost markers, search
 * results. `text.slice(0, 40)` on Malayalam produces a dotted-circle
 * replacement character where the vowel sign lost its base.
 */
export function truncateToClusters(
  text: string,
  maxClusters: number,
  locale = DEFAULT_LOCALE,
): string {
  if (maxClusters <= 0) return '';
  let count = 0;
  for (const s of segmenter(locale).segment(text)) {
    count += 1;
    if (count > maxClusters) return text.slice(0, s.index);
  }
  return text;
}

/** First `maxClusters` clusters with an ellipsis when anything was dropped. */
export function preview(text: string, maxClusters = 40, locale = DEFAULT_LOCALE): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  const truncated = truncateToClusters(collapsed, maxClusters, locale);
  return truncated.length < collapsed.length ? `${truncated}…` : truncated;
}
