/**
 * Materialising a past state (ADR-0009).
 *
 * This is the reason snapshots exist. Cold open never replays — the projection
 * is transactionally consistent with the log (ADR-0008) — but the scrub has to
 * produce arbitrary past states at drag rates, and that is a bounded replay
 * from the nearest anchor.
 *
 * Runs INSIDE THE WORKER. No React, no DOM, and nothing here may be imported
 * by a component: the whole point is that a replay of two hundred thousand
 * events never competes with typing.
 *
 * The materialised state stays here. What crosses the boundary is a summary and
 * a window of blocks, never the document — the memory rule that keeps the
 * present bounded (docs/PERFORMANCE.md) is not suspended because the text is
 * old.
 */

import Dexie from 'dexie';
import type { EzhuthuDB } from '../../db/schema';
import type { Block, DocId } from '../../db/types';
import { visibleBlocks } from '../../core/fold';
import { replayTo } from '../../core/replay';
import { countWordsInBlocks } from '../../text/count';
import { buildTimeline, type EventSample, type Timeline, type TimelineOptions } from './timeline';

/** One paragraph of a past state, as the panel renders it. */
export interface PastBlock {
  blockId: string;
  text: string;
}

export interface PastSummary {
  /** The state materialised is the document as of, and including, this seq. */
  seq: number;
  blockCount: number;
  wordCount: number;
}

export const EMPTY_SUMMARY: PastSummary = { seq: 0, blockCount: 0, wordCount: 0 };

/**
 * A document at a point in its history, held so windows of it can be read
 * without replaying again.
 */
export class PastDocument {
  private blocks: Block[] = [];
  private summary: PastSummary = EMPTY_SUMMARY;

  constructor(
    private readonly db: EzhuthuDB,
    private readonly docId: DocId,
  ) {}

  /**
   * Where the scrub can stop.
   *
   * Reads every event for the document, which is the one genuinely expensive
   * thing this class does — and it is done once, in the Worker, when the panel
   * opens. Only `(seq, ts, sessionId)` is kept; the payloads are what make the
   * log large and none of them are wanted here.
   */
  async timeline(options: TimelineOptions = {}): Promise<Timeline> {
    const samples: EventSample[] = [];
    await this.db.events
      .where('[docId+seq]')
      .between([this.docId, Dexie.minKey], [this.docId, Dexie.maxKey])
      .each((event) => {
        samples.push({ seq: event.seq, ts: event.ts, sessionId: event.sessionId });
      });
    return buildTimeline(samples, options);
  }

  /**
   * Replay to `targetSeq` and hold the result.
   *
   * Soft-deleted blocks are dropped from what is held: the panel shows the
   * document as the writer saw it at that moment, and at that moment a deleted
   * paragraph was not on the page. Ghost markers are a feature of the present
   * (ADR-0018), not of history.
   */
  async materialise(targetSeq: number): Promise<PastSummary> {
    const state = await replayTo(this.db, this.docId, targetSeq);
    this.blocks = visibleBlocks(state);
    this.summary = {
      seq: state.seq,
      blockCount: this.blocks.length,
      wordCount: countWordsInBlocks(this.blocks.map((b) => b.text)),
    };
    return this.summary;
  }

  /** The state currently held. */
  get current(): PastSummary {
    return this.summary;
  }

  /**
   * `count` blocks from `from`, clamped to what exists.
   *
   * A window rather than the document, and a copy rather than a view: this
   * result is about to be structured-cloned across a thread boundary.
   */
  window(from: number, count: number): PastBlock[] {
    const start = Math.max(0, Math.min(from, Math.max(0, this.blocks.length - 1)));
    return this.blocks
      .slice(start, start + Math.max(0, count))
      .map((b) => ({ blockId: b.blockId, text: b.text }));
  }
}
