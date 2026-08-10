/**
 * What a block's text was, at any point in its history.
 *
 * ONE definition, because there are now two readers of it — the corpus exporter
 * walking (before, after) pairs (ADR-0012) and undo working out what an `update`
 * has to be put back to (ADR-0033) — and the moment they disagree, one of them
 * is publishing a paragraph that never existed.
 *
 * The rule is the fold's rule, restated for text alone:
 *
 *   insert   a block that does not exist yet starts at its payload text, or
 *            empty. A block that DOES exist is a restore (ADR-0018): its text
 *            stands unless the event carries a replacement.
 *   update   becomes its payload text.
 *   delete   keeps its text. A soft delete removes the block from the document,
 *            not the words from the record — which is what ghost restore reads.
 *   move     changes position and nothing else.
 *
 * PURE. No Dexie, no DOM, no clock.
 */

import type { BlockEvent } from '../db/types';
import { compareEvents } from './order';

/**
 * The block's text after this event, given what it was before.
 *
 * `undefined` for "before" means the block did not exist yet; `undefined` out
 * means it still does not.
 */
export function textAfterEvent(event: BlockEvent, before: string | undefined): string | undefined {
  switch (event.type) {
    case 'insert':
      if (before === undefined) return event.payload.text ?? '';
      // A restore. Absent text leaves the paragraph exactly as it was.
      return event.payload.text ?? before;
    case 'update':
      return event.payload.text ?? '';
    case 'delete':
    case 'move':
      return before;
  }
}

/**
 * The block's text as it stood immediately BEFORE `seq`.
 *
 * Events must all belong to one block; order is imposed here rather than
 * assumed, because `(seq, deviceId)` is the only correct one (ADR-0020) and a
 * caller that read them from an index has only the first component.
 *
 * Returns `undefined` when nothing in the given events establishes a text —
 * the block's creation is older than the events supplied. Undo treats that as
 * "cannot be reversed" rather than guessing, for the same reason the corpus
 * emits no pair for it: an invented empty `before` claims a paragraph was
 * written from nothing when it already existed.
 */
export function textBefore(events: readonly BlockEvent[], seq: number): string | undefined {
  let text: string | undefined;
  for (const event of [...events].sort(compareEvents)) {
    if (event.seq >= seq) break;
    text = textAfterEvent(event, text);
  }
  return text;
}
