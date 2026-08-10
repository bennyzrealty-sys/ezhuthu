/**
 * Bucketing for the minimap (ADR-0021). PURE — no DOM, time is a parameter.
 *
 * The minimap shows the whole document as a narrow column shaded by edit
 * intensity. At two thousand blocks in a ~600 px column each block gets 0.3 px,
 * so drawn one-tick-per-block the edits alias into an even grey wash and, worse,
 * whether a given edit is visible depends on sub-pixel rounding — a real edit
 * can vanish entirely.
 *
 * So the column is divided into **buckets**, one per device-pixel row, and each
 * bucket takes the **maximum** intensity of the blocks that fall in it, never
 * the average. Maximum is the decision that matters: the minimap answers "is
 * there anything here I should look at", and one hot block among twenty cold
 * ones must survive. An average would drown it.
 *
 * Blocks are assigned to buckets by their position in document order. That makes
 * tap targeting approximate in the vertical dimension — a bucket's pixel row is
 * not the block's exact scroll offset, because blocks are not equal height — but
 * the jump itself is exact: the bucket carries the winning block's index, so a
 * tap is `scrollToIndex`, not a guess. ADR-0021 accepts the vertical
 * approximation by construction.
 *
 * Cost is proportional to bucket count — the column height — not to document
 * length, so the minimap is O(1) in document size (one pass over the index to
 * fill buckets, which is the same walk virtualisation already affords).
 */

import { intensityScore, markIntensity, type Intensity, type IntensityInput } from './intensity';

export interface MinimapSource extends IntensityInput {
  blockId: string;
}

export interface Bucket {
  /** Max intensity score of the blocks in this bucket; 0 if none is marked. */
  score: number;
  /** Position in the source list of the winning block — the jump target. */
  index: number | undefined;
  /** The winning block's mark, so the column draws it in the bar's own terms. */
  intensity: Intensity | null;
}

function emptyBucket(): Bucket {
  return { score: 0, index: undefined, intensity: null };
}

/**
 * Divide `blocks` into `bucketCount` buckets by document position, each holding
 * the highest-intensity block that fell in it.
 *
 * A bucket with no marked block keeps score 0 and no target — the column draws
 * nothing there, and a tap on it falls back to a proportional jump in the
 * component, not to this function's concern.
 */
export function bucketise(
  blocks: readonly MinimapSource[],
  bucketCount: number,
  now: number,
): Bucket[] {
  const count = Math.max(0, Math.floor(bucketCount));
  const buckets: Bucket[] = Array.from({ length: count }, emptyBucket);
  if (count === 0 || blocks.length === 0) return buckets;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    const intensity = markIntensity(block, now);
    const score = intensityScore(intensity);
    if (score <= 0) continue;

    const at = Math.min(count - 1, Math.floor((i / blocks.length) * count));
    const bucket = buckets[at]!;
    if (score > bucket.score) {
      bucket.score = score;
      bucket.index = i;
      bucket.intensity = intensity;
    }
  }
  return buckets;
}

/**
 * The block a tap at bucket row `at` should jump to.
 *
 * If that bucket has a winner, jump to it exactly. If it is empty — most of the
 * column usually is — jump to the proportional document position instead, so a
 * tap anywhere on the minimap moves the reader roughly there rather than doing
 * nothing. Both are indices into the source list; -1 means there is nowhere to
 * go (an empty document).
 */
export function jumpTargetFor(buckets: readonly Bucket[], at: number, blockCount: number): number {
  if (buckets.length === 0 || blockCount === 0) return -1;
  const clamped = Math.max(0, Math.min(buckets.length - 1, at));
  const winner = buckets[clamped]?.index;
  if (winner !== undefined) return winner;
  return Math.min(blockCount - 1, Math.floor((clamped / buckets.length) * blockCount));
}
