import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EzhuthuDB } from '@/db/schema';
import { createDoc, insertBlock, updateBlock } from '@/core/events';
import {
  latestSnapshotSeq,
  maybeWriteSnapshot,
  pruneSnapshots,
  selectSnapshotsToRetain,
  shouldWriteSnapshot,
  SNAPSHOT_INTERVAL,
} from '@/core/snapshots';
import { logHeadSeq, replayTo } from '@/core/replay';
import { visibleBlocks } from '@/core/fold';

describe('retention ladder', () => {
  it('keeps at most one snapshot per octave of age', () => {
    const seqs = Array.from({ length: 40 }, (_, i) => (i + 1) * 500);
    const head = 20_000;
    const retained = selectSnapshotsToRetain(seqs, head);

    // O(log n), not O(n) — this is the property that bounds storage.
    expect(retained.size).toBeLessThan(seqs.length);
    expect(retained.size).toBeLessThanOrEqual(16);
    // The newest is always kept.
    expect(retained.has(20_000)).toBe(true);
  });

  it('is dense near head, sparse going back', () => {
    // Recent history is where the scrub spends its time, so anchors cluster
    // there. Deep history is reachable but costs more — see the invariant
    // asserted below, which is what makes that acceptable.
    const seqs = Array.from({ length: 60 }, (_, i) => (i + 1) * 500);
    const retained = [...selectSnapshotsToRetain(seqs, 30_000)].sort((a, b) => a - b);

    expect(retained.at(-1)).toBe(30_000);

    const gaps: number[] = [];
    for (let i = 1; i < retained.length; i++) gaps.push(retained[i]! - retained[i - 1]!);
    // Gaps shrink as you approach head.
    expect(gaps.at(-1)!).toBeLessThan(gaps[0]!);
  });

  it('never replays more events than lie between the target and the present', () => {
    // THE invariant the ladder provides. Reconstructing a recent state is
    // cheap; reconstructing a distant one costs at most what has happened
    // since. Early targets need no anchor at all — replaying from empty is
    // bounded by the target's own seq, which is small precisely because it is
    // early. This is why dropping the oldest anchors is safe.
    const seqs = Array.from({ length: 60 }, (_, i) => (i + 1) * 500);
    const head = 30_000;
    const retained = [...selectSnapshotsToRetain(seqs, head)].sort((a, b) => a - b);

    for (let target = 500; target <= head; target += 500) {
      const anchor = retained.filter((s) => s <= target).at(-1) ?? 0;
      const replayDistance = target - anchor;
      const age = head - target;
      expect(replayDistance).toBeLessThanOrEqual(Math.max(age, 500));
    }
  });

  it('holds that invariant across a range of log sizes', () => {
    for (const head of [5_000, 50_000, 200_000]) {
      const seqs = Array.from({ length: head / 500 }, (_, i) => (i + 1) * 500);
      const retained = [...selectSnapshotsToRetain(seqs, head)].sort((a, b) => a - b);

      // Storage stays logarithmic.
      expect(retained.length).toBeLessThanOrEqual(Math.ceil(Math.log2(head)) + 2);

      for (let target = 500; target <= head; target += 500) {
        const anchor = retained.filter((s) => s <= target).at(-1) ?? 0;
        expect(target - anchor).toBeLessThanOrEqual(Math.max(head - target, 500));
      }
    }
  });

  it('handles an empty set and a single snapshot', () => {
    expect(selectSnapshotsToRetain([], 100).size).toBe(0);
    expect(selectSnapshotsToRetain([50], 100)).toEqual(new Set([50]));
  });
});

describe('write cadence', () => {
  it('waits for the interval', () => {
    expect(shouldWriteSnapshot(499, 0)).toBe(false);
    expect(shouldWriteSnapshot(SNAPSHOT_INTERVAL, 0)).toBe(true);
    expect(shouldWriteSnapshot(1200, 1000)).toBe(false);
    expect(shouldWriteSnapshot(1500, 1000)).toBe(true);
  });
});

describe('snapshots against a real log', () => {
  let db: EzhuthuDB;
  let counter = 0;
  const DOC = 'doc-1';

  beforeEach(async () => {
    db = new EzhuthuDB(`ezhuthu-snap-${counter++}`);
    await db.open();
    await createDoc(db, { docId: DOC, now: 1_000 });
  });

  afterEach(() => db.close());

  it('writes nothing before the interval', async () => {
    await insertBlock(db, DOC, 'one');
    expect(await maybeWriteSnapshot(db, DOC)).toBeNull();
    expect(await db.snapshots.count()).toBe(0);
  });

  it('writes at the interval and anchors an exact reconstruction', async () => {
    const a = await insertBlock(db, DOC, 'original');
    for (let i = 0; i < SNAPSHOT_INTERVAL; i++) {
      await updateBlock(db, DOC, a.blockId, `revision ${i}`);
    }

    const snapshot = await maybeWriteSnapshot(db, DOC, 9_000);
    expect(snapshot).not.toBeNull();
    expect(await latestSnapshotSeq(db, DOC)).toBe(await logHeadSeq(db, DOC));

    // Replaying through the anchor must equal the state the log implies.
    const head = await logHeadSeq(db, DOC);
    const viaSnapshot = await replayTo(db, DOC, head);
    expect(visibleBlocks(viaSnapshot).map((b) => b.text)).toEqual([
      `revision ${SNAPSHOT_INTERVAL - 1}`,
    ]);
  });

  it('reconstructs a point BEFORE the snapshot correctly', async () => {
    // The case that matters: scrubbing backwards past an anchor must fall
    // through to an earlier anchor (or empty), not reuse the newer one.
    const a = await insertBlock(db, DOC, 'v0');
    const earlySeq = await logHeadSeq(db, DOC);
    for (let i = 0; i < SNAPSHOT_INTERVAL; i++) {
      await updateBlock(db, DOC, a.blockId, `v${i + 1}`);
    }
    await maybeWriteSnapshot(db, DOC, 9_000);

    const past = await replayTo(db, DOC, earlySeq);
    expect(visibleBlocks(past).map((b) => b.text)).toEqual(['v0']);
  });

  it('prunes to the ladder', async () => {
    for (const seq of [500, 1000, 1500, 2000, 2500, 3000, 3500, 4000]) {
      await db.snapshots.put({ docId: DOC, seq, ts: seq, blocks: [] });
    }
    const removed = await pruneSnapshots(db, DOC, 4000);
    const left = await db.snapshots.where('docId').equals(DOC).count();

    expect(removed).toBeGreaterThan(0);
    expect(left).toBe(8 - removed);
    const seqs = (await db.snapshots.where('docId').equals(DOC).toArray()).map((s) => s.seq);
    expect(seqs).toContain(4000);
  });
});
