/**
 * The DOM half of signal capture: sample what is on screen, feed the attention
 * model, hand what it banks to the batching queue.
 *
 * **Why a sampler and not an `IntersectionObserver`.** The obvious reading of
 * docs/SIGNALS.md is IO, and IO is the wrong tool twice over. It reports
 * threshold *crossings*, and the model needs a value over *time* — so a timer
 * is required regardless, and IO would only supply staler geometry to it.
 * And the question IO exists to answer cheaply, "which of a document's
 * elements are near the viewport", is one the virtualiser has already answered:
 * roughly a dozen rows exist in the DOM at all (ADR-0004). Sampling them
 * directly is one `querySelectorAll` and a dozen rects, once a second, off the
 * typing path — against an observer that must be attached and detached on every
 * row the virtualiser recycles. See ADR-0025.
 *
 * Nothing here runs during a keystroke. `typing` is the only part the editor
 * touches, and its methods are a map lookup each.
 */

import type { EzhuthuDB } from '../db/schema';
import type { DocId } from '../db/types';
import { AttentionModel, centreWeight, type VisibleBlock } from './attention';
import { SAMPLE_INTERVAL_MS } from './constants';
import { SignalQueue, type SignalQueueOptions } from './queue';
import { ScrollbackTracker } from './scrollback';
import { TypingSignals } from './typing';

export interface SignalCollectorOptions extends SignalQueueOptions {
  /** Monotonic clock for durations. Wall clocks move backwards. */
  now?: () => number;
  sampleIntervalMs?: number;
  /** Test seam: drive `sample()` by hand instead of on a timer. */
  autoStart?: boolean;
}

/**
 * Read the rendered rows and their centre weights.
 *
 * Exported for the unit test, which stubs `getBoundingClientRect` — the geometry
 * is the part worth testing and jsdom has none of its own.
 */
export function sampleRows(scroller: HTMLElement): VisibleBlock[] {
  const view = scroller.getBoundingClientRect();
  const rows = scroller.querySelectorAll<HTMLElement>('[data-block-id]');

  const visible: VisibleBlock[] = [];
  for (const row of rows) {
    const blockId = row.dataset.blockId;
    if (blockId === undefined) continue;
    const box = row.getBoundingClientRect();
    const weight = centreWeight(box.top, box.bottom, view.top, view.bottom);
    if (weight <= 0) continue;
    visible.push({ blockId, weight });
  }
  return visible;
}

export class SignalCollector {
  readonly typing: TypingSignals;

  private readonly queue: SignalQueue;
  private readonly model: AttentionModel;
  private readonly scrollback: ScrollbackTracker;
  private readonly now: () => number;
  private readonly sampleIntervalMs: number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    db: EzhuthuDB,
    docId: DocId,
    private readonly scroller: HTMLElement,
    options: SignalCollectorOptions = {},
  ) {
    this.now = options.now ?? (() => performance.now());
    this.sampleIntervalMs = options.sampleIntervalMs ?? SAMPLE_INTERVAL_MS;

    this.queue = new SignalQueue(db, docId, options);
    this.model = new AttentionModel(this.now());
    this.scrollback = new ScrollbackTracker(scroller.scrollTop);
    this.typing = new TypingSignals(
      (kind, blockId, value) => this.queue.add(kind, blockId, value),
      { now: this.now, onInteraction: (at) => this.model.interaction(at) },
    );

    scroller.addEventListener('scroll', this.onActivity, { passive: true });
    scroller.addEventListener('pointerdown', this.onActivity, { passive: true });
    scroller.addEventListener('touchstart', this.onActivity, { passive: true });
    document.addEventListener('visibilitychange', this.onVisibilityChange);

    if (options.autoStart !== false) {
      this.timer = setInterval(() => {
        // Gate 1 is the model's, but there is no reason to touch layout for a
        // document nobody is looking at.
        if (!document.hidden) this.sample();
      }, this.sampleIntervalMs);
    }
  }

  /**
   * One sample: geometry in, dwell and scroll-back out.
   *
   * Public because the timer is not the only caller that matters — the unit
   * test drives a synthetic session through here, and a test that has to wait
   * real seconds to measure a 60 s idle cutoff is a test nobody runs.
   */
  sample(at: number = this.now()): void {
    if (this.stopped) return;

    const visible = sampleRows(this.scroller);
    this.model.sample(visible, at);

    for (const [blockId, ms] of this.model.drain()) {
      this.queue.add('dwell', blockId, ms);
    }

    const hit = this.scrollback.sample(this.scroller.scrollTop, this.model.centreBlockId, at);
    if (hit !== undefined) this.queue.add('scrollback', hit.blockId, hit.ms);
  }

  /** Write what is queued now, rather than at the next flush. */
  flush(): Promise<void> {
    return this.queue.flush();
  }

  /** Final sample, final flush, listeners off. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.sample();
    this.stopped = true;

    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.scroller.removeEventListener('scroll', this.onActivity);
    this.scroller.removeEventListener('pointerdown', this.onActivity);
    this.scroller.removeEventListener('touchstart', this.onActivity);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);

    await this.queue.stop();
  }

  /**
   * Fires on every scroll frame during a fling, so it does exactly one thing:
   * stamp the idle clock. No DOM reads — `scrollTop` is read at sample time,
   * where a forced layout costs nothing.
   */
  private readonly onActivity = (): void => {
    this.model.interaction(this.now());
  };

  /**
   * Gate 1, and the flush that matters most: on mobile this is frequently the
   * last code that runs before the app is frozen or discarded.
   */
  private readonly onVisibilityChange = (): void => {
    const at = this.now();
    if (document.hidden) {
      // Bank up to this instant BEFORE the model stops accruing, then get the
      // batch out while there is still a main thread to write it with.
      this.sample(at);
      this.model.setHidden(true, at);
      void this.queue.flush();
    } else {
      this.model.setHidden(false, at);
    }
  };
}
