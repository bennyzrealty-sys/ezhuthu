/**
 * Replay: rebuilding state from the log.
 *
 * This is NOT the cold-open path. Because the `blocks` projection is written
 * transactionally with every event (ADR-0008), opening a document is one
 * indexed get plus one indexed range query and involves no replay at all.
 *
 * Replay runs in three situations:
 *   - the watermark is behind the log head (a crash mid-transaction)
 *   - the time-lapse scrub materialises a past state (ADR-0009)
 *   - the projection is rebuilt, or a backup is restored
 *
 * No React, no DOM — this module runs inside a Worker.
 */

import Dexie from 'dexie';
import type { EzhuthuDB } from '../db/schema';
import type { Block, BlockEvent, DocId, DocState } from '../db/types';
import { compareEvents } from './order';
import { emptyState, foldEvents } from './fold';

/** Highest seq in the log for this document, or 0 if the log is empty. */
export async function logHeadSeq(db: EzhuthuDB, docId: DocId): Promise<number> {
  const last = await db.events
    .where('[docId+seq]')
    .between([docId, Dexie.minKey], [docId, Dexie.maxKey])
    .last();
  return last?.seq ?? 0;
}

/** Events in (fromSeqExclusive, toSeqInclusive], correctly ordered. */
export async function eventsInRange(
  db: EzhuthuDB,
  docId: DocId,
  fromSeqExclusive: number,
  toSeqInclusive: number,
): Promise<BlockEvent[]> {
  if (toSeqInclusive <= fromSeqExclusive) return [];
  const events = await db.events
    .where('[docId+seq]')
    .between([docId, fromSeqExclusive], [docId, toSeqInclusive], false, true)
    .toArray();
  // The index orders by seq; compareEvents adds the deviceId tiebreak that
  // makes the total order deterministic (ADR-0020).
  return events.sort(compareEvents);
}

/** Fold the entire log from nothing. Correct, and slow — used for repair. */
export async function replayFromEmpty(db: EzhuthuDB, docId: DocId): Promise<DocState> {
  const head = await logHeadSeq(db, docId);
  const events = await eventsInRange(db, docId, 0, head);
  return foldEvents(emptyState(docId), events);
}

/**
 * Materialise the document as it existed at `targetSeq`, using the nearest
 * snapshot at or before it as an anchor. This is what the time-lapse scrub
 * calls, and the reason snapshots exist at all (ADR-0009).
 */
export async function replayTo(
  db: EzhuthuDB,
  docId: DocId,
  targetSeq: number,
): Promise<DocState> {
  const snapshot = await db.snapshots
    .where('[docId+seq]')
    .between([docId, Dexie.minKey], [docId, targetSeq], true, true)
    .last();

  const state = snapshot ? stateFromBlocks(docId, snapshot.blocks, snapshot.seq) : emptyState(docId);
  const events = await eventsInRange(db, docId, state.seq, targetSeq);
  return foldEvents(state, events);
}

/** Rehydrate a DocState from a snapshot's block array. */
export function stateFromBlocks(docId: DocId, blocks: readonly Block[], seq: number): DocState {
  const sorted = [...blocks].sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
  return {
    docId,
    blocks: new Map(sorted.map((b) => [b.blockId, { ...b, meta: { ...b.meta } }])),
    order: sorted.map((b) => b.blockId),
    seq,
  };
}

export interface ProjectionCheck {
  consistent: boolean;
  watermark: number;
  headSeq: number;
}

/**
 * Is the `blocks` projection in step with the log?
 *
 * One integer comparison, run on every open. When it fails the projection is
 * stale — a crash landed between the event append and the block write — and
 * the tail must be replayed before the document is trusted.
 */
export async function checkProjection(db: EzhuthuDB, docId: DocId): Promise<ProjectionCheck> {
  const doc = await db.docs.get(docId);
  if (doc === undefined) throw new Error(`checkProjection: unknown document ${docId}`);
  const headSeq = await logHeadSeq(db, docId);
  return { consistent: doc.lastAppliedSeq === headSeq, watermark: doc.lastAppliedSeq, headSeq };
}

/**
 * Bring the projection back in step by replaying only the events after the
 * watermark. Cheap: bounded by however many events the crash lost.
 */
export async function repairProjection(db: EzhuthuDB, docId: DocId): Promise<number> {
  return db.transaction('rw', db.docs, db.blocks, db.events, async () => {
    const doc = await db.docs.get(docId);
    if (doc === undefined) throw new Error(`repairProjection: unknown document ${docId}`);

    const headSeq = await logHeadSeq(db, docId);
    if (headSeq === doc.lastAppliedSeq) return 0;

    const stored = await db.blocks.where('docId').equals(docId).toArray();
    const state = stateFromBlocks(docId, stored, doc.lastAppliedSeq);
    const events = await eventsInRange(db, docId, doc.lastAppliedSeq, headSeq);
    foldEvents(state, events);

    const touched = new Set(events.map((e) => e.blockId));
    for (const blockId of touched) {
      const block = state.blocks.get(blockId);
      if (block !== undefined) await db.blocks.put(block);
    }

    await db.docs.update(docId, {
      lastAppliedSeq: headSeq,
      seqCounter: Math.max(doc.seqCounter, headSeq + 1),
    });
    return events.length;
  });
}
