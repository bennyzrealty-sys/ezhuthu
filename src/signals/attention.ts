/**
 * The attention model (ADR-0017). PURE — no DOM, no clock of its own.
 *
 * Naive dwell is "the block was on screen, and time passed". That measures
 * pixels, not attention, and the two diverge in ways that are not edge cases: a
 * phone left face-up accrues dwell all night, and the block at the top of the
 * viewport accrues as much as the one being read. Since "longest dwelled" is
 * offered to the writer as *where your attention was*, uncorrected it is not
 * imprecise but confidently wrong, and the writer will follow it.
 *
 * So dwell accrues only under four gates:
 *
 *   1. visibility  — a hidden document accrues nothing
 *   2. idle cutoff — accrual stops IDLE_CUTOFF_MS after the last interaction
 *   3. centre      — accrual is weighted by proximity to the viewport centre
 *   4. settling    — a block accrues nothing for its first SETTLE_MS on screen
 *
 * Time is a parameter everywhere (CLAUDE.md rule 8), which is what makes the
 * synthetic-session test in tests/unit/attention.test.ts possible: it drives
 * hours of reading, idling and backgrounding in a few milliseconds.
 */

import { IDLE_CUTOFF_MS, SETTLE_MS } from './constants';

/** One block on screen at a sample, with its centre weight already computed. */
export interface VisibleBlock {
  blockId: string;
  /** 1 at the viewport centre, 0 at its edges. See `centreWeight`. */
  weight: number;
}

/**
 * Centre weight for a block, from the block's VISIBLE extent rather than its
 * full extent.
 *
 * Using the whole block would score a paragraph taller than the screen at zero
 * — its geometric centre is off-screen — when a paragraph filling the viewport
 * is the clearest case of the thing being read there is.
 *
 * Linear falloff. A curve would be easy and no more defensible; this is a
 * weighting, not a measurement.
 */
export function centreWeight(
  blockTop: number,
  blockBottom: number,
  viewTop: number,
  viewBottom: number,
): number {
  const top = Math.max(blockTop, viewTop);
  const bottom = Math.min(blockBottom, viewBottom);
  if (bottom <= top) return 0;

  const half = (viewBottom - viewTop) / 2;
  if (half <= 0) return 0;

  const distance = Math.abs((top + bottom) / 2 - (viewTop + viewBottom) / 2);
  return Math.max(0, Math.min(1, 1 - distance / half));
}

export interface AttentionOptions {
  idleCutoffMs?: number;
  settleMs?: number;
}

interface Tracked {
  weight: number;
  /** When this block entered the visible set. Reset if it leaves and returns. */
  seenAt: number;
}

export class AttentionModel {
  private readonly idleCutoffMs: number;
  private readonly settleMs: number;

  private tracked = new Map<string, Tracked>();
  private readonly banked = new Map<string, number>();

  private lastSampleAt: number;
  private lastInteractionAt: number;
  private hidden = false;
  private centre: string | undefined;

  /**
   * `startedAt` seeds both the sample clock and the interaction clock: opening
   * the document is itself an interaction, so a writer who opens it and reads
   * without touching anything accrues for the full idle window.
   */
  constructor(startedAt: number, options: AttentionOptions = {}) {
    this.idleCutoffMs = options.idleCutoffMs ?? IDLE_CUTOFF_MS;
    this.settleMs = options.settleMs ?? SETTLE_MS;
    this.lastSampleAt = startedAt;
    this.lastInteractionAt = startedAt;
  }

  /** A keystroke, scroll, touch, or a return to the tab. Gate 2's clock. */
  interaction(now: number): void {
    if (now > this.lastInteractionAt) this.lastInteractionAt = now;
  }

  /**
   * Gate 1. Hiding banks what was accrued up to this instant and then stops;
   * showing restarts the clock from now, so the time the app spent in the
   * background is not accrued retroactively at the next sample.
   */
  setHidden(hidden: boolean, now: number): void {
    if (hidden === this.hidden) return;
    if (hidden) {
      this.accrue(now);
      this.hidden = true;
      this.lastSampleAt = now;
    } else {
      this.hidden = false;
      this.lastSampleAt = now;
      // Returning to the document is an interaction in its own right.
      this.interaction(now);
    }
  }

  /**
   * Record what is on screen now. Accrual for the interval that just ended is
   * computed against the PREVIOUS sample — that interval is when those blocks
   * were the ones on screen.
   */
  sample(visible: readonly VisibleBlock[], now: number): void {
    this.accrue(now);
    this.lastSampleAt = now;

    const next = new Map<string, Tracked>();
    let best: VisibleBlock | undefined;
    for (const block of visible) {
      const previous = this.tracked.get(block.blockId);
      next.set(block.blockId, {
        weight: block.weight,
        // A block that stayed on screen keeps its settle clock; one that left
        // and came back has to settle again, because it did move.
        seenAt: previous?.seenAt ?? now,
      });
      if (best === undefined || block.weight > best.weight) best = block;
    }
    this.tracked = next;
    this.centre = best?.blockId;
  }

  /** The block nearest the viewport centre at the last sample. */
  get centreBlockId(): string | undefined {
    return this.centre;
  }

  /** Accrued dwell in ms per block since the last drain. Clears the ledger. */
  drain(): Map<string, number> {
    const out = new Map(this.banked);
    this.banked.clear();
    return out;
  }

  /**
   * Bank the interval [lastSampleAt, now] against the current visible set.
   *
   * The interval is clipped, not rejected: gate 2 ends accrual exactly
   * `idleCutoffMs` after the last interaction, wherever inside the interval
   * that falls, and gate 4 starts it exactly `settleMs` after the block
   * appeared. Time already banked is kept; the gap itself is discarded.
   */
  private accrue(now: number): void {
    if (this.hidden) return;

    const until = Math.min(now, this.lastInteractionAt + this.idleCutoffMs);
    if (until <= this.lastSampleAt) return;

    for (const [blockId, block] of this.tracked) {
      if (block.weight <= 0) continue;
      const from = Math.max(this.lastSampleAt, block.seenAt + this.settleMs);
      const span = until - from;
      if (span <= 0) continue;
      this.banked.set(blockId, (this.banked.get(blockId) ?? 0) + span * block.weight);
    }
  }
}
