/**
 * Deriving (before, after) pairs from the log, per block (ADR-0012, ADR-0016).
 *
 * `prevText` is not stored when it is derivable, because storing it doubles the
 * log for data already present: the previous event for a block IS the next
 * event's `prevText`. The cost of that decision is paid here — the exporter
 * walks each block's history in order and carries the text forward, instead of
 * reading pairs straight out of the events.
 *
 * PURE. No Dexie, no DOM, no Date.now(). The cursor that feeds it is in
 * `export.ts`; everything about what a revision *is* lives in this file, so the
 * thresholds can be re-run over full history without touching storage.
 *
 * Text is carried forward exactly as `core/fold.ts` carries it, and that
 * correspondence is load-bearing. A restore that omits `text` leaves the text
 * standing (ADR-0018); a fresh insert without one starts empty. Getting either
 * backwards would not fail a test in the fold — it would quietly emit pairs
 * whose `before` is a paragraph that never existed.
 */

import type { BlockEvent } from '../../../db/types';
import { compareEvents } from '../../../core/order';
import { COALESCE_WINDOW_MS } from './constants';

/** One revision of one block, before session coalescing. */
export interface Revision {
  before: string;
  after: string;
  /** Wall clock of the revision. Display only — never used for ordering. */
  ts: number;
  seq: number;
  sessionId: string;
  /**
   * False when something other than an `update` touched this block since the
   * previous revision — a delete, or a restore that brought different text
   * back. Such a revision can never be coalesced onto the one before it,
   * whatever the clock says.
   */
  continuesRun: boolean;
}

/** What the exporter emits, one JSONL record each (ADR-0016). */
export interface EditPair {
  before: string;
  after: string;
  ts: number;
  /**
   * 1-based position of this revision in the block's history, counted AFTER
   * coalescing and BEFORE the triviality filter.
   *
   * So indices in an exported corpus have gaps, deliberately: `revisionIndex`
   * 7 means the seventh time this paragraph was worked over, and the six
   * before it having been filtered as typo fixes is itself part of what the
   * record says.
   */
  revisionIndex: number;
}

/**
 * Walk one block's events in order and produce its revisions.
 *
 * Events must all belong to the same block. Order is imposed here rather than
 * assumed, because `(seq, deviceId)` — never `seq` alone, never `ts` — is the
 * only correct one (ADR-0020) and a caller that got it from an index has only
 * the first component.
 */
export function revisionsForBlock(events: readonly BlockEvent[]): Revision[] {
  const ordered = [...events].sort(compareEvents);
  const out: Revision[] = [];

  /** The block's text as of the last event walked. */
  let current: string | undefined;
  /** Set when a non-update event has landed since the last revision. */
  let broken = false;

  for (const event of ordered) {
    switch (event.type) {
      case 'insert': {
        if (current === undefined) {
          // Creation. Mirrors the fold: a missing text payload means empty.
          current = event.payload.text ?? '';
        } else {
          // A restore (ADR-0018). Text comes back unchanged unless the event
          // carries a replacement.
          if (event.payload.text !== undefined) current = event.payload.text;
          broken = true;
        }
        break;
      }

      case 'update': {
        const after = event.payload.text ?? '';
        // Stored `prevText` wins where it exists — the first update to a block
        // whose creation predates the log has no other source (ADR-0012).
        const before = event.payload.prevText ?? current;
        current = after;

        if (before === undefined) {
          // History begins mid-block and nothing recorded what came before.
          // The pair is unknowable, and inventing an empty `before` would
          // publish "this paragraph was written from nothing" about a
          // paragraph that already existed.
          broken = true;
          break;
        }

        out.push({
          before,
          after,
          ts: event.ts,
          seq: event.seq,
          sessionId: event.sessionId,
          continuesRun: !broken,
        });
        broken = false;
        break;
      }

      case 'delete': {
        // The text is not lost — `delete` carries it (ADR-0012) — but a
        // deletion is not a revision of prose into better prose, and a pair
        // whose `after` is empty teaches nothing about how this writer edits.
        broken = true;
        break;
      }

      case 'move': {
        // Position only. Reordering a paragraph between two typing bursts is
        // not a reason to split them into two revisions.
        break;
      }
    }
  }

  return out;
}

export interface CoalesceOptions {
  /** Defaults to COALESCE_WINDOW_MS. */
  windowMs?: number;
}

/**
 * Collapse a run of consecutive revisions into the single act of revision it
 * was: the text at the start of the run and the text at the end (ADR-0012).
 *
 * Revisions must be for one block and in log order — the output of
 * `revisionsForBlock`.
 */
export function coalesceRevisions(
  revisions: readonly Revision[],
  options: CoalesceOptions = {},
): EditPair[] {
  const windowMs = options.windowMs ?? COALESCE_WINDOW_MS;
  const out: EditPair[] = [];

  let open: Revision | null = null;
  let last: Revision | null = null;

  const close = (): void => {
    if (open === null || last === null) return;
    out.push({
      before: open.before,
      after: last.after,
      // The moment the revision finished, not the moment it started: it is
      // the state at the end that the pair is about.
      ts: last.ts,
      revisionIndex: out.length + 1,
    });
    open = null;
    last = null;
  };

  for (const revision of revisions) {
    const joins =
      last !== null &&
      revision.continuesRun &&
      revision.sessionId === last.sessionId &&
      // `ts` is wall clock and can move backwards (NTP, DST). A negative gap
      // is not evidence of anything, so it is treated as adjacency rather than
      // as a reason to split a run.
      revision.ts - last.ts <= windowMs;

    if (!joins) close();
    open ??= revision;
    last = revision;
  }
  close();

  return out;
}

/** Convenience: one block's events straight to its coalesced pairs. */
export function pairsForBlock(
  events: readonly BlockEvent[],
  options: CoalesceOptions = {},
): EditPair[] {
  return coalesceRevisions(revisionsForBlock(events), options);
}
