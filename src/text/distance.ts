/**
 * Edit distance over grapheme clusters.
 *
 * Written for the corpus triviality filter (ADR-0012), which has to answer
 * "how much of this paragraph actually changed" for every revision in the log.
 *
 * TWO reasons this is not `levenshtein(a, b)` over UTF-16 code units.
 *
 * Rule 4 — a character is not a codepoint. Correcting `നി` to `ന` is one
 * character to the writer and two code-unit edits to a naive distance, so a
 * code-unit distance systematically over-states change in Malayalam and
 * under-states it in English relative to each other. The filter's threshold
 * would then mean something different depending on the script.
 *
 * Rule 5 — both sides are folded first (text/normalize.ts). `അവൻ` typed with an
 * atomic chillu and `അവന്‍` typed as the ZWJ sequence are the same word on
 * screen and different bytes in storage. Unfolded, re-encoding a paragraph —
 * which a keyboard change does to a whole manuscript — reads as an edit to
 * every chillu in it, and the corpus fills with pairs whose before and after
 * are visually identical.
 *
 * PURE. Used at export time, which is batch, but blocks run to thousands of
 * clusters and a manuscript to tens of thousands of revisions, so the
 * quadratic version is not affordable even there: the distance is banded around
 * a caller-supplied cutoff and stops as soon as it is exceeded.
 */

import { normalizeForCompare } from './normalize';
import { graphemes } from './segmenter';

export interface DistanceOptions {
  /**
   * Stop once the distance is known to exceed this. The result is then
   * `max + 1`, which is all a threshold test needs to know.
   *
   * Not an optimisation detail the caller can ignore: the filter asks whether a
   * change is *small*, and every large change costs the same to reject as it
   * does to measure exactly.
   */
  max?: number;
}

export interface ClusterChange {
  /** Cluster edits between the folded forms, or `max + 1` when it stopped early. */
  distance: number;
  /** Clusters in the longer of the two folded forms. Zero when both are empty. */
  clusters: number;
  /** `distance / clusters`, 0 when both sides are empty. */
  ratio: number;
  /** The cutoff was hit, so `distance` is a lower bound rather than exact. */
  exceeded: boolean;
}

/**
 * How much changed, in clusters and as a fraction of the longer side.
 *
 * The fraction is what the filter thresholds on: fixing one letter in a
 * sentence and fixing one letter in a chapter are the same absolute distance
 * and very different revisions.
 */
export function clusterChange(a: string, b: string, options: DistanceOptions = {}): ClusterChange {
  const left = graphemes(normalizeForCompare(a));
  const right = graphemes(normalizeForCompare(b));
  const clusters = Math.max(left.length, right.length);

  const cap = options.max ?? Number.POSITIVE_INFINITY;
  const distance = bounded(left, right, Number.isFinite(cap) ? cap : left.length + right.length);
  const exceeded = distance > cap;

  return {
    distance,
    clusters,
    ratio: clusters === 0 ? 0 : distance / clusters,
    exceeded,
  };
}

/** Cluster edit distance, or `max + 1` if it stopped early. */
export function clusterDistance(a: string, b: string, options: DistanceOptions = {}): number {
  return clusterChange(a, b, options).distance;
}

/**
 * Banded Levenshtein with an early exit.
 *
 * Common affixes are trimmed first, which is not a micro-optimisation here:
 * the revisions this runs over are overwhelmingly a change to one clause of an
 * otherwise untouched paragraph, so trimming turns a 600 × 600 table into a
 * 20 × 20 one before the band is even considered.
 */
function bounded(a: readonly string[], b: readonly string[], max: number): number {
  let start = 0;
  let endA = a.length;
  let endB = b.length;

  while (start < endA && start < endB && a[start] === b[start]) start += 1;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  // The shorter string drives the row width, so the table is n × m with n ≤ m.
  let short = a.slice(start, endA);
  let long = b.slice(start, endB);
  if (short.length > long.length) [short, long] = [long, short];

  const n = short.length;
  const m = long.length;

  if (n === 0) return m > max ? max + 1 : m;
  // A length difference alone already costs that many insertions.
  if (m - n > max) return max + 1;

  const sentinel = max + 1;
  let previous = new Int32Array(n + 1);
  let current = new Int32Array(n + 1);
  for (let i = 0; i <= n; i += 1) previous[i] = i;

  for (let j = 1; j <= m; j += 1) {
    // Cells further than `max` from the diagonal cannot be on a path cheaper
    // than the cutoff, so only the band is computed and everything outside it
    // is left at a value that can never win a min().
    const from = Math.max(1, j - max);
    const to = Math.min(n, j + max);

    current[0] = j;
    if (from > 1) current[from - 1] = sentinel;

    let best = sentinel;
    for (let i = from; i <= to; i += 1) {
      const cost = short[i - 1] === long[j - 1] ? 0 : 1;
      const value = Math.min(previous[i]! + 1, current[i - 1]! + 1, previous[i - 1]! + cost);
      current[i] = value;
      if (value < best) best = value;
    }
    for (let i = to + 1; i <= n; i += 1) current[i] = sentinel;

    if (best > max) return max + 1;

    const swap = previous;
    previous = current;
    current = swap;
  }

  return Math.min(previous[n]!, sentinel);
}
