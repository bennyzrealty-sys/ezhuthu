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

/**
 * How long after the last commit a snapshot may be attempted.
 *
 * MEASURED, not guessed. Without it the perf suite's keystroke handler went
 * from 0.95 ms median to 1.13–1.21 ms on the same machine, and the cause is
 * plain once seen: the editor commits on a 400 ms cadence while typing, the
 * first commit on a document whose log is already past SNAPSHOT_INTERVAL finds
 * a snapshot due, and `requestIdleCallback` hands it a gap between two
 * keystrokes to materialise 1,563 blocks in. Idle during a typing burst is not
 * idle — it is the space the next keystroke is about to need.
 */
export const QUIET_AFTER_COMMIT_MS = 5_000;

/** Runs work after a delay; returns a cancel. `setTimeout` with a seam. */
export type Delay = (ms: number, work: () => void) => () => void;

export const timeout: Delay = (ms, work) => {
  const id = setTimeout(work, ms);
  return () => clearTimeout(id);
};

export interface SnapshotSchedulerOptions {
  schedule?: IdleSchedule;
  delay?: Delay;
  now?: () => number;
}

/**
 * Asks for a snapshot once the writer has stopped, and never more than one at a
 * time.
 *
 * Two gates, and the order matters. The debounce decides WHETHER the writer has
 * finished; idle decides WHEN inside that quiet period to do the work. Idle
 * alone is not enough, because the gaps between keystrokes are idle.
 *
 * Debouncing also coalesces, which is worth having on its own: `request()` runs
 * after every committed burst, and `maybeWriteSnapshot` reads the log head and
 * the snapshot ladder before concluding it has nothing to do.
 */
export class SnapshotScheduler {
  private cancel: (() => void) | null = null;
  private stopped = false;

  constructor(
    private readonly db: EzhuthuDB,
    private readonly docId: DocId,
    private readonly options: SnapshotSchedulerOptions = {},
  ) {}

  request(): void {
    if (this.stopped) return;
    // Each commit pushes the attempt further out, so a paragraph being typed
    // makes no attempt at all until it is finished.
    this.cancel?.();
    this.cancel = (this.options.delay ?? timeout)(QUIET_AFTER_COMMIT_MS, () => {
      this.cancel = null;
      (this.options.schedule ?? idle)(() => {
        void this.run();
      });
    });
  }

  stop(): void {
    this.stopped = true;
    this.cancel?.();
    this.cancel = null;
  }

  private async run(): Promise<void> {
    if (this.stopped) return;
    try {
      await maybeWriteSnapshot(this.db, this.docId, this.options.now?.() ?? Date.now());
    } catch {
      // Losing an anchor costs speed on one feature and never data. There is
      // nothing to tell the writer and nothing to retry.
    }
  }
}
