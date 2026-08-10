/**
 * Running an undo against the store (ADR-0033).
 *
 * Every decision is in `undo.ts`, which is pure. This file reads the log and
 * appends — through `appendEvent` like every other mutation, so an undo is a
 * transaction with a watermark exactly as an edit is (ADR-0008), and a crash
 * halfway through one leaves the projection consistent.
 */

import Dexie from 'dexie';
import type { EzhuthuDB } from '../../db/schema';
import { appendEvent } from '../../core/events';
import { getSessionId } from '../../db/ids';
import type { BlockEvent, BlockId, DocId } from '../../db/types';
import { nextUndoable, planUndo } from './undo';

/**
 * How far back the tail is read to find something to undo.
 *
 * Bounded because this runs on the main thread, and unbounded because it does
 * not need to be: undo reaches back through one session, and the events it can
 * reverse are by definition at the end of the log. A writer who has appended
 * more than this within one launch has passed the point where pressing undo
 * repeatedly is what they want.
 */
export const UNDO_WINDOW_EVENTS = 500;

export interface UndoOutcome {
  /** Events appended. Zero means there was nothing to undo. */
  undone: number;
  /** The kinds of event reversed, for the message the toolbar shows. */
  reversed: BlockEvent['type'][];
  /** Set when an action was found but could not be reversed. */
  refused?: 'not-reversible';
}

const NOTHING: UndoOutcome = { undone: 0, reversed: [] };

/** The tail of this document's log, newest first. */
async function recentEvents(db: EzhuthuDB, docId: DocId): Promise<BlockEvent[]> {
  return db.events
    .where('[docId+seq]')
    .between([docId, Dexie.minKey], [docId, Dexie.maxKey])
    .reverse()
    .limit(UNDO_WINDOW_EVENTS)
    .toArray();
}

/** One block's whole history, which is what deriving its previous text needs. */
async function historyOf(db: EzhuthuDB, docId: DocId, blockId: BlockId): Promise<BlockEvent[]> {
  return db.events
    .where('[docId+blockId+seq]')
    .between([docId, blockId, 0], [docId, blockId, Dexie.maxKey])
    .toArray();
}

/** Is there anything for the undo button to do? Drives its disabled state. */
export async function canUndo(
  db: EzhuthuDB,
  docId: DocId,
  sessionId = getSessionId(),
): Promise<boolean> {
  return nextUndoable(await recentEvents(db, docId), sessionId) !== null;
}

/**
 * Reverse the most recent action of this session.
 *
 * The whole action: a split is an update plus an insert and a merge an update
 * plus a delete, and the writer pressed one key for each (ADR-0033).
 */
export async function undoLast(
  db: EzhuthuDB,
  docId: DocId,
  sessionId = getSessionId(),
): Promise<UndoOutcome> {
  const action = nextUndoable(await recentEvents(db, docId), sessionId);
  if (action === null) return NOTHING;

  const histories = new Map<BlockId, BlockEvent[]>();
  for (const blockId of new Set(action.map((e) => e.blockId))) {
    histories.set(blockId, await historyOf(db, docId, blockId));
  }

  const plan = planUndo(action, (blockId) => histories.get(blockId) ?? []);
  if (plan === null) return { ...NOTHING, refused: 'not-reversible' };

  for (const append of plan.appends) await appendEvent(db, append);

  return { undone: plan.appends.length, reversed: plan.reversing.map((e) => e.type) };
}
