/**
 * Undo (ADR-0033).
 *
 * THE LOG IS NEVER REWRITTEN. An undo appends a compensating event — a delete
 * that reverses an insert, an update back to the previous text, an insert that
 * restores a delete — so history keeps both what the writer did and the fact
 * that they took it back. Removing events would break replay, the scrub and
 * every backup that already holds them (ADR-0001, Rule 1).
 *
 * That leaves two questions this module answers, both pure:
 *
 *   which action is next to undo, given that undoing is itself recorded?
 *   what is the event that reverses it?
 *
 * SCOPE IS THE CURRENT SESSION. Undo goes back through this launch of the app
 * and stops. Reaching further is not undo, it is time travel, and the scrub
 * already does that (ADR-0009) — with the difference that the scrub cannot
 * silently rewrite a paragraph the writer has since spent an hour on.
 */

import type { AppendInput } from '../../core/events';
import { compareEvents } from '../../core/order';
import { textAfterEvent, textBefore } from '../../core/history';
import type { BlockEvent, DocId } from '../../db/types';

/**
 * One action's worth of events, newest last.
 *
 * A split is an update plus an insert, and a merge an update plus a delete. The
 * writer performed one action and expects one press to take it back, so events
 * carrying a shared `groupId` are reversed together.
 */
export type UndoableAction = BlockEvent[];

/**
 * The events an undo would reverse, or null when there is nothing to undo.
 *
 * Skips two kinds of event: those that are themselves undos, and those an undo
 * has already reversed. Without both, pressing undo twice would undo the undo,
 * which is a redo the writer did not ask for.
 */
export function nextUndoable(
  events: readonly BlockEvent[],
  sessionId: string,
): UndoableAction | null {
  const undone = new Set<string>();
  for (const event of events) {
    if (event.payload.undoOf !== undefined) undone.add(event.payload.undoOf);
  }

  const mine = [...events]
    .filter((e) => e.sessionId === sessionId)
    .filter((e) => e.payload.undoOf === undefined)
    .filter((e) => !undone.has(e.id))
    .sort(compareEvents);

  const last = mine.at(-1);
  if (last === undefined) return null;

  // The whole action, not the last event of it.
  const group = last.payload.groupId;
  if (group === undefined) return [last];
  return mine.filter((e) => e.payload.groupId === group);
}

/**
 * What reversing one event looks like, as an append.
 *
 * `previousText` is what the block held immediately before the event, which
 * only an `update` needs — and which the caller derives with
 * `core/history.ts`, the same rule the corpus uses.
 *
 * Returns null for an event that cannot be reversed on its own. `move` is the
 * live case: putting a block back requires the neighbour it sat after, which
 * the event does not record. Nothing in the UI emits one today, and when
 * something does, the reversal wants a recorded previous position rather than a
 * guess.
 */
export function inverseOf(
  event: BlockEvent,
  previousText: string | undefined,
): AppendInput | null {
  const base = { docId: event.docId, blockId: event.blockId };

  switch (event.type) {
    case 'insert': {
      /*
       * A soft delete, whether the insert created the block or restored it: the
       * text stays in the record either way, so a ghost marker can still reach
       * it (ADR-0018). The text to carry is what the block held once the insert
       * had landed, which is the same rule the corpus reads.
       */
      const text = textAfterEvent(event, previousText) ?? '';
      return { ...base, type: 'delete', payload: { text, undoOf: event.id } };
    }

    case 'update': {
      // Nothing in the log says what this paragraph held before, so there is
      // nothing to put back. Refusing beats writing an empty paragraph over
      // the writer's work.
      if (previousText === undefined) return null;
      return { ...base, type: 'update', payload: { text: previousText, undoOf: event.id } };
    }

    case 'delete': {
      // An insert naming an existing block is a restore, and an absent
      // `afterBlockId` means "back where it was" (ADR-0018).
      return { ...base, type: 'insert', payload: { undoOf: event.id } };
    }

    case 'move':
      return null;
  }
}

/** Everything needed to reverse an action, in the order the appends must run. */
export interface UndoPlan {
  docId: DocId;
  /** Appends to make, newest event first — an action is unwound backwards. */
  appends: AppendInput[];
  /** The events being reversed, for the caller to report or test against. */
  reversing: BlockEvent[];
}

/**
 * Build the plan for undoing one action.
 *
 * `historyFor` supplies a block's events, so this stays pure and the caller
 * owns the store. Returns null when there is nothing to undo, or when the
 * action cannot be reversed — a plan that only half-works would leave the
 * document in a state the writer never typed.
 */
export function planUndo(
  action: UndoableAction,
  historyFor: (blockId: string) => readonly BlockEvent[],
): UndoPlan | null {
  if (action.length === 0) return null;

  const ordered = [...action].sort(compareEvents).reverse();
  const appends: AppendInput[] = [];

  for (const event of ordered) {
    const previous = textBefore(historyFor(event.blockId), event.seq);
    const inverse = inverseOf(event, previous);
    if (inverse === null) return null;
    appends.push(inverse);
  }

  return { docId: ordered[0]!.docId, appends, reversing: ordered };
}
