/**
 * Snapshots — anchors for historical reconstruction, NOT a cold-open
 * optimisation (ADR-0009).
 *
 * The retention ladder keeps at most one snapshot per octave of age: dense
 * near head, progressively sparser going back, so total storage is O(log n)
 * in log length.
 *
 * The guarantee this provides — and the reason dropping the oldest anchors is
 * safe — is that reconstructing any past state never replays more events than
 * lie between that state and the present. A state early in the log needs no
 * anchor, because replaying it from empty is bounded by its own position,
 * which is small precisely because it is early.
 */

import Dexie from 'dexie';
import type { EzhuthuDB } from '../db/schema';
import type { DocId, Snapshot } from '../db/types';
import { allBlocksInOrder } from './fold';
import { logHeadSeq, replayTo } from './replay';

/** Events between snapshot writes. Tunable; see docs/PERFORMANCE.md. */
export const SNAPSHOT_INTERVAL = 500;

/**
 * Which snapshots to keep, given the seqs that exist and the current log head.
 *
 * Pure and unit-tested. Keeps the newest snapshot unconditionally, then at
 * most one per octave of age — so ages roughly 1, 2, 4, 8, 16 … thousand
 * events back each retain a single anchor.
 */
export function selectSnapshotsToRetain(seqs: readonly number[], headSeq: number): Set<number> {
  const retain = new Set<number>();
  const seenOctaves = new Set<number>();
  const descending = [...seqs].sort((a, b) => b - a);

  for (const seq of descending) {
    const age = Math.max(1, headSeq - seq);
    const octave = Math.floor(Math.log2(age));
    if (!seenOctaves.has(octave)) {
      seenOctaves.add(octave);
      retain.add(seq);
    }
  }
  return retain;
}

/** True when enough events have accumulated since the last snapshot. */
export function shouldWriteSnapshot(headSeq: number, lastSnapshotSeq: number): boolean {
  return headSeq - lastSnapshotSeq >= SNAPSHOT_INTERVAL;
}

export async function latestSnapshotSeq(db: EzhuthuDB, docId: DocId): Promise<number> {
  const latest = await db.snapshots
    .where('[docId+seq]')
    .between([docId, Dexie.minKey], [docId, Dexie.maxKey])
    .last();
  return latest?.seq ?? 0;
}

/**
 * Write a snapshot at the current log head and prune the ladder.
 *
 * Deliberately NOT part of the append transaction: a snapshot is disposable,
 * so it must never be able to fail or slow a write of real work. Call it
 * opportunistically after a commit, ideally from idle time.
 */
export async function maybeWriteSnapshot(
  db: EzhuthuDB,
  docId: DocId,
  now = Date.now(),
): Promise<Snapshot | null> {
  const headSeq = await logHeadSeq(db, docId);
  const lastSeq = await latestSnapshotSeq(db, docId);
  if (!shouldWriteSnapshot(headSeq, lastSeq)) return null;

  const state = await replayTo(db, docId, headSeq);
  const snapshot: Snapshot = {
    docId,
    seq: headSeq,
    ts: now,
    blocks: allBlocksInOrder(state).map((b) => ({ ...b, meta: { ...b.meta } })),
  };

  await db.snapshots.put(snapshot);
  await pruneSnapshots(db, docId, headSeq);
  return snapshot;
}

export async function pruneSnapshots(
  db: EzhuthuDB,
  docId: DocId,
  headSeq: number,
): Promise<number> {
  const existing = await db.snapshots.where('docId').equals(docId).toArray();
  const retain = selectSnapshotsToRetain(
    existing.map((s) => s.seq),
    headSeq,
  );
  const doomed = existing.filter((s) => !retain.has(s.seq));
  for (const s of doomed) await db.snapshots.delete([s.docId, s.seq]);
  return doomed.length;
}
