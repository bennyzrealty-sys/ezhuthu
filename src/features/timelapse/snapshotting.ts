/**
 * Writing the anchors the scrub replays from (ADR-0009).
 *
 * `maybeWriteSnapshot` has existed since Phase 1 with no caller, which was
 * correct while nothing read history: an anchor is worth exactly what it saves
 * a reader, and there was no reader. Time-lapse is that reader, and without
 * anchors it replays from empty every time — fine at a thousand events,
 * unusable at two hundred thousand.
 *
 * Two rules govern where this runs, and both come from the snapshot being
 * disposable. It is NOT part of the append transaction, so it can never fail or
 * slow a write of real work. And it goes to idle, because it materialises the
 * whole document and that is the one thing that must never happen while
 * somebody is typing.
 */

import type { EzhuthuDB } from '../../db/schema';
import type { DocId } from '../../db/types';
import { maybeWriteSnapshot } from '../../core/snapshots';

/** Runs work when the main thread has nothing better to do. */
export type IdleSchedule = (work: () => void) => void;

/**
 * `requestIdleCallback` where it exists, a timeout where it does not — Safari
 * shipped it only recently, and this must not be the reason history has no
 * anchors on iOS.
 *
 * The deadline is generous on purpose: a snapshot missed is a slower scrub
 * later, and there is no hurry at all.
 */
export const idle: IdleSchedule = (work) => {
  const request = (globalThis as { requestIdleCallback?: (cb: () => void, o?: unknown) => number })
    .requestIdleCallback;
  if (typeof request === 'function') request(work, { timeout: 10_000 });
  else setTimeout(work, 2_000);
};

export interface SnapshotSchedulerOptions {
  schedule?: IdleSchedule;
  now?: () => number;
}

/**
 * Asks for a snapshot after a commit, at most one at a time.
 *
 * Coalescing matters more than it looks: `request()` is called after every
 * committed keystroke burst, and `maybeWriteSnapshot` reads the log head and
 * the snapshot ladder before deciding it has nothing to do. Left uncoalesced,
 * a paragraph being typed queues one of those per commit.
 */
export class SnapshotScheduler {
  private pending = false;
  private stopped = false;

  constructor(
    private readonly db: EzhuthuDB,
    private readonly docId: DocId,
    private readonly options: SnapshotSchedulerOptions = {},
  ) {}

  request(): void {
    if (this.pending || this.stopped) return;
    this.pending = true;
    (this.options.schedule ?? idle)(() => {
      void this.run();
    });
  }

  stop(): void {
    this.stopped = true;
  }

  private async run(): Promise<void> {
    this.pending = false;
    if (this.stopped) return;
    try {
      await maybeWriteSnapshot(this.db, this.docId, this.options.now?.() ?? Date.now());
    } catch {
      // Losing an anchor costs speed on one feature and never data. There is
      // nothing to tell the writer and nothing to retry.
    }
  }
}
