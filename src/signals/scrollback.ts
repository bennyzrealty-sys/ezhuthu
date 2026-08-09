/**
 * Scroll-back detection. PURE — fed scroll positions, hands back a signal.
 *
 * A scroll-back is "the writer went up to check something and then stopped
 * there": upward movement of at least SCROLLBACK_MIN_PX, followed by
 * SCROLLBACK_DWELL_MS of settled dwell on one block. It is the auto-bookmark of
 * docs/SIGNALS.md — the reference point a writer keeps returning to is the one
 * worth offering back.
 *
 * Both halves matter. Upward movement alone is scrolling; stopping alone is
 * reading forwards. Neither is a writer going back to check what a character
 * was called.
 *
 * Upward movement accumulates across samples: a deliberate scroll-back at
 * reading speed can easily be four unremarkable-looking steps rather than one
 * fling, and requiring the whole distance inside one sample would only ever
 * catch the fling.
 */

import { SCROLLBACK_DWELL_MS, SCROLLBACK_MIN_PX, SCROLL_SETTLED_PX } from './constants';

export interface ScrollbackOptions {
  minPx?: number;
  dwellMs?: number;
  settledPx?: number;
}

export interface ScrollbackHit {
  blockId: string;
  /** ms dwelled after the return — the value stored on the signal. */
  ms: number;
}

export class ScrollbackTracker {
  private readonly minPx: number;
  private readonly dwellMs: number;
  private readonly settledPx: number;

  private lastScrollTop: number;
  private upward = 0;
  private downward = 0;
  private armed = false;
  private candidate: { blockId: string; since: number } | null = null;

  constructor(scrollTop = 0, options: ScrollbackOptions = {}) {
    this.lastScrollTop = scrollTop;
    this.minPx = options.minPx ?? SCROLLBACK_MIN_PX;
    this.dwellMs = options.dwellMs ?? SCROLLBACK_DWELL_MS;
    this.settledPx = options.settledPx ?? SCROLL_SETTLED_PX;
  }

  /**
   * One sample. Returns the signal to emit when the pattern completes, and
   * `undefined` otherwise — which is almost always.
   */
  sample(scrollTop: number, centreBlockId: string | undefined, now: number): ScrollbackHit | undefined {
    const delta = scrollTop - this.lastScrollTop;
    this.lastScrollTop = scrollTop;

    if (delta < -this.settledPx) {
      this.upward += -delta;
      this.downward = 0;
      this.candidate = null;
      if (this.upward >= this.minPx) {
        this.armed = true;
        this.upward = 0;
      }
      return undefined;
    }

    if (delta > this.settledPx) {
      this.downward += delta;
      this.upward = 0;
      this.candidate = null;
      // Reading onwards again ends the visit; only a sustained downward move
      // counts, so that overshooting the target and correcting does not.
      if (this.downward >= this.minPx) this.armed = false;
      return undefined;
    }

    this.downward = 0;
    if (!this.armed || centreBlockId === undefined) return undefined;

    if (this.candidate === null || this.candidate.blockId !== centreBlockId) {
      this.candidate = { blockId: centreBlockId, since: now };
      return undefined;
    }

    const dwelled = now - this.candidate.since;
    if (dwelled < this.dwellMs) return undefined;

    this.armed = false;
    this.candidate = null;
    return { blockId: centreBlockId, ms: dwelled };
  }
}
