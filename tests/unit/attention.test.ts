/**
 * The attention model (ADR-0017), including the synthetic-session test the ADR
 * asks for by name: **an idle gap must not inflate dwell.**
 *
 * These drive hours of reading, idling and backgrounding through a model that
 * takes time as a parameter, in a few milliseconds. That is the whole reason
 * `core/`-style purity is worth having outside `core/`: a test that had to wait
 * out a 60-second idle cutoff in real time is a test nobody would run.
 */

import { describe, expect, it } from 'vitest';
import { AttentionModel, centreWeight, type VisibleBlock } from '@/signals/attention';
import { ScrollbackTracker } from '@/signals/scrollback';
import { IDLE_CUTOFF_MS, SETTLE_MS } from '@/signals/constants';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** One block, dead centre. The simplest thing that can accrue. */
const READING: VisibleBlock[] = [{ blockId: 'a', weight: 1 }];

interface SessionOptions {
  /** ms between samples. Accrual is computed from timestamps, so this is only resolution. */
  step?: number;
  /** ms between interactions. Omitted means the writer touched nothing. */
  interactEvery?: number;
  visible?: VisibleBlock[];
}

/** Run the model forward from `from` to `to`, returning the time it ends at. */
function run(model: AttentionModel, from: number, to: number, options: SessionOptions = {}): number {
  const step = options.step ?? 1_000;
  const visible = options.visible ?? READING;
  let at = from;
  while (at < to) {
    at = Math.min(at + step, to);
    if (options.interactEvery !== undefined && (at - from) % options.interactEvery === 0) {
      model.interaction(at);
    }
    model.sample(visible, at);
  }
  return at;
}

function dwell(model: AttentionModel, blockId = 'a'): number {
  return model.drain().get(blockId) ?? 0;
}

describe('centre weighting (gate 3)', () => {
  it('scores the centre of the viewport highest and its edges at zero', () => {
    // Viewport 0..1000, so the centre is 500.
    expect(centreWeight(450, 550, 0, 1000)).toBe(1);
    expect(centreWeight(0, 100, 0, 1000)).toBeCloseTo(0.1, 5);
    expect(centreWeight(900, 1000, 0, 1000)).toBeCloseTo(0.1, 5);
    expect(centreWeight(-200, -100, 0, 1000)).toBe(0);
  });

  it('scores a block taller than the viewport as fully attended', () => {
    /*
     * Weighting on the block's own centre would score this at zero — its
     * midpoint is off-screen — when a paragraph filling the whole viewport is
     * the least ambiguous case of the thing being read that exists. The visible
     * extent is what is weighted, so it lands at 1.
     */
    expect(centreWeight(-2000, 3000, 0, 1000)).toBe(1);
  });

  it('gives the block being read more than a block merely on screen', () => {
    const model = new AttentionModel(0);
    const top = centreWeight(0, 200, 0, 1000);
    const middle = centreWeight(400, 600, 0, 1000);

    model.sample([{ blockId: 'top', weight: top }, { blockId: 'middle', weight: middle }], 0);
    run(model, 0, 60_000, { visible: [{ blockId: 'top', weight: top }, { blockId: 'middle', weight: middle }], interactEvery: 5_000 });

    const accrued = model.drain();
    expect(accrued.get('middle')!).toBeGreaterThan(accrued.get('top')! * 4);
  });
});

describe('settling (gate 4)', () => {
  it('accrues nothing for a block that has not been still for SETTLE_MS', () => {
    const model = new AttentionModel(0);
    model.sample(READING, 0);
    model.sample(READING, SETTLE_MS - 1);
    expect(dwell(model)).toBe(0);
  });

  it('accrues from the settle point, not from first sight', () => {
    const model = new AttentionModel(0);
    model.sample(READING, 0);
    model.sample(READING, 5_000);
    expect(dwell(model)).toBe(5_000 - SETTLE_MS);
  });

  it('banks nothing at all for a fling past fifty paragraphs', () => {
    // Scrolling-as-searching: each block crosses the viewport in 200ms. This is
    // the case naive dwell reports as fifty blocks all worth reading.
    const model = new AttentionModel(0);
    let at = 0;
    for (let i = 0; i < 50; i++) {
      model.interaction(at);
      model.sample([{ blockId: `b${i}`, weight: 1 }], at);
      at += 200;
    }
    expect([...model.drain().values()]).toEqual([]);
  });

  it('makes a block that left and came back settle again', () => {
    const model = new AttentionModel(0);
    model.sample(READING, 0);
    model.sample(READING, 4_000);
    expect(dwell(model)).toBe(3_000);

    // A sample is when we LEARN a block left, so the interval that ends here
    // still belongs to it.
    model.sample([{ blockId: 'other', weight: 1 }], 5_000);
    expect(dwell(model)).toBe(1_000);

    model.sample(READING, 6_000);
    model.sample(READING, 6_500);
    // Back on screen at 6,000 and still settling at 6,500.
    expect(dwell(model)).toBe(0);
  });
});

describe('visibility (gate 1)', () => {
  it('stops accrual while the document is hidden', () => {
    const model = new AttentionModel(0);
    model.sample(READING, 0);
    run(model, 0, 10_000, { interactEvery: 5_000 });
    const active = dwell(model);

    model.setHidden(true, 10_000);
    // Samples while hidden accrue nothing — the app is frozen in practice, but
    // the model must not depend on that.
    model.sample(READING, 10_000 + HOUR / 2);
    model.setHidden(false, 10_000 + HOUR);

    /*
     * An hour in the background accrued nothing, and returning did not accrue
     * it retroactively at the next sample: only the 500 ms since the writer
     * came back is banked. The block is not made to settle again — it never
     * moved, and ADR-0017 has four gates, not five.
     */
    model.sample(READING, 10_000 + HOUR + 500);
    expect(dwell(model)).toBe(500);
    expect(active).toBe(10_000 - SETTLE_MS);
  });

  it('banks time up to the moment of hiding, not to the next sample', () => {
    const model = new AttentionModel(0);
    model.sample(READING, 0);
    model.setHidden(true, 4_500);
    expect(dwell(model)).toBe(4_500 - SETTLE_MS);
  });
});

describe('the idle cutoff (gate 2)', () => {
  it('does not let an idle gap inflate dwell', () => {
    /*
     * The synthetic session ADR-0017 requires. A writer reads one paragraph for
     * ten minutes, then is interrupted and leaves the phone face-up on the desk
     * for eight hours.
     *
     * Naive dwell reports 8h10m on that paragraph and offers it as "where your
     * attention was" — confidently wrong, and the writer will follow it.
     */
    const model = new AttentionModel(0);
    model.sample(READING, 0);

    const reading = 10 * MINUTE;
    run(model, 0, reading, { interactEvery: 5_000 });
    const attended = dwell(model);
    expect(attended).toBe(reading - SETTLE_MS);

    // Eight hours of nobody touching anything. Sampling continues, because the
    // document is still on screen — that is precisely the failure case.
    run(model, reading, reading + 8 * HOUR, { step: MINUTE });
    const abandoned = dwell(model);

    // What the gap added is bounded by the cutoff, not by its own length.
    expect(abandoned).toBeLessThanOrEqual(IDLE_CUTOFF_MS);
    expect(attended + abandoned).toBeLessThan(reading + 2 * MINUTE);
    // ...and is a rounding error next to what naive dwell would have banked.
    expect(attended + abandoned).toBeLessThan(0.03 * 8 * HOUR);
  });

  it('accrues the full session when the writer keeps working', () => {
    // The complement: the cutoff must not be so eager that it clips real work.
    const model = new AttentionModel(0);
    model.sample(READING, 0);
    run(model, 0, 2 * HOUR, { step: 10_000, interactEvery: 30_000 });
    expect(dwell(model)).toBe(2 * HOUR - SETTLE_MS);
  });

  it('discards the gap but keeps what was banked either side of it', () => {
    const model = new AttentionModel(0);
    model.sample(READING, 0);

    run(model, 0, 30_000, { interactEvery: 5_000 });
    run(model, 30_000, 30_000 + HOUR, { step: MINUTE });
    const beforeReturn = dwell(model);

    // The writer comes back and works for another 30 s.
    const resumed = 30_000 + HOUR;
    model.interaction(resumed);
    model.sample(READING, resumed);
    run(model, resumed, resumed + 30_000, { interactEvery: 5_000 });

    expect(dwell(model)).toBe(30_000);
    expect(beforeReturn).toBeLessThanOrEqual(29_000 + IDLE_CUTOFF_MS);
  });
});

describe('scroll-back detection', () => {
  const settled = (tracker: ScrollbackTracker, top: number, block: string, at: number) =>
    tracker.sample(top, block, at);

  it('reports a block scrolled back to and dwelled on', () => {
    const tracker = new ScrollbackTracker(5_000);
    // Up 600px, in the three steps a deliberate scroll-back actually takes.
    tracker.sample(4_800, 'a', 1_000);
    tracker.sample(4_600, 'b', 2_000);
    tracker.sample(4_400, 'c', 3_000);

    expect(settled(tracker, 4_400, 'c', 4_000)).toBeUndefined();
    expect(settled(tracker, 4_400, 'c', 5_000)).toBeUndefined();
    const hit = settled(tracker, 4_400, 'c', 6_000);
    expect(hit).toEqual({ blockId: 'c', ms: 2_000 });
  });

  it('ignores an upward scroll the writer does not stop at', () => {
    const tracker = new ScrollbackTracker(5_000);
    for (let i = 1; i <= 6; i++) tracker.sample(5_000 - i * 400, `b${i}`, i * 1_000);
    // Never settles: this is searching, not checking a reference.
    expect(tracker.sample(2_600, 'b6', 7_000)).toBeUndefined();
  });

  it('ignores stopping without having scrolled back', () => {
    const tracker = new ScrollbackTracker(0);
    // Reading forwards, then pausing. Nothing was gone back to.
    tracker.sample(400, 'a', 1_000);
    tracker.sample(800, 'b', 2_000);
    for (let i = 3; i <= 8; i++) expect(tracker.sample(800, 'b', i * 1_000)).toBeUndefined();
  });

  it('forgets the return once the writer reads onwards again', () => {
    const tracker = new ScrollbackTracker(5_000);
    tracker.sample(4_500, 'a', 1_000);
    tracker.sample(4_500, 'a', 2_000);
    tracker.sample(5_200, 'b', 3_000);
    for (let i = 4; i <= 10; i++) expect(tracker.sample(5_200, 'b', i * 1_000)).toBeUndefined();
  });
});
