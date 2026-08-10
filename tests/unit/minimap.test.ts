/**
 * Minimap bucketing (ADR-0021). Pure, so these drive it directly. The property
 * that matters is *maximum, not average*: one hot block among cold ones must
 * survive into its bucket, because the minimap exists to make it findable.
 */

import { describe, expect, it } from 'vitest';
import { bucketise, jumpTargetFor, type MinimapSource } from '@/features/visibility/minimap';

const T0 = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

/** n blocks, none edited unless overridden — the shape just after an import. */
function blocks(n: number, edits: Record<number, { updatedAt: number; revisionCount: number }> = {}) {
  return Array.from({ length: n }, (_, i): MinimapSource => ({
    blockId: `b${i}`,
    updatedAt: edits[i]?.updatedAt ?? T0,
    revisionCount: edits[i]?.revisionCount ?? 0,
  }));
}

describe('bucketise', () => {
  it('returns an all-empty column for an unedited document', () => {
    const buckets = bucketise(blocks(500), 60, T0 + 1);
    expect(buckets).toHaveLength(60);
    expect(buckets.every((b) => b.score === 0 && b.index === undefined)).toBe(true);
  });

  it('is O(1) in document size: the column stays the requested height', () => {
    expect(bucketise(blocks(20), 60, T0)).toHaveLength(60);
    expect(bucketise(blocks(20_000), 60, T0)).toHaveLength(60);
  });

  it('keeps one hot block among many cold ones — max, not average', () => {
    // Twenty blocks into one bucket; only block 7 was edited. An average would
    // divide its intensity by twenty and lose it. The bucket must show it.
    const source = blocks(20, { 7: { updatedAt: T0, revisionCount: 5 } });
    const [bucket] = bucketise(source, 1, T0 + 1);
    expect(bucket!.score).toBeGreaterThan(0);
    expect(bucket!.index).toBe(7);
    expect(bucket!.intensity).not.toBeNull();
  });

  it('when a bucket holds two edits, the winner is the higher-scoring one', () => {
    // Both in the single bucket: a fresh light edit outranks a week-old heavy
    // one, matching intensityScore's recency-first ordering.
    const source = blocks(10, {
      2: { updatedAt: T0 - 6 * 24 * HOUR, revisionCount: 40 },
      8: { updatedAt: T0, revisionCount: 1 },
    });
    const [bucket] = bucketise(source, 1, T0 + 1);
    expect(bucket!.index).toBe(8);
  });

  it('places edits in document-position order down the column', () => {
    // An edit near the top lands in an early bucket; one near the end lands late.
    const source = blocks(100, {
      3: { updatedAt: T0, revisionCount: 2 },
      96: { updatedAt: T0, revisionCount: 2 },
    });
    const buckets = bucketise(source, 10, T0 + 1);
    const hot = buckets.map((b, i) => (b.score > 0 ? i : -1)).filter((i) => i >= 0);
    expect(hot).toEqual([0, 9]);
  });
});

describe('jumpTargetFor', () => {
  it('jumps to the winning block when the tapped bucket has one', () => {
    const source = blocks(100, { 40: { updatedAt: T0, revisionCount: 3 } });
    const buckets = bucketise(source, 10, T0 + 1);
    // block 40 of 100 → bucket 4.
    expect(jumpTargetFor(buckets, 4, 100)).toBe(40);
  });

  it('falls back to a proportional jump for an empty bucket', () => {
    const buckets = bucketise(blocks(200), 10, T0); // all empty
    // Tapping halfway down an empty column lands halfway through the document.
    expect(jumpTargetFor(buckets, 5, 200)).toBe(100);
  });

  it('returns -1 when there is nowhere to go', () => {
    expect(jumpTargetFor([], 0, 0)).toBe(-1);
    expect(jumpTargetFor(bucketise(blocks(0), 10, T0), 3, 0)).toBe(-1);
  });
});
