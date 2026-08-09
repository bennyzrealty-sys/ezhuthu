/**
 * Hesitation and backspace density, and the guard that makes them mean anything
 * on IME input (ADR-0010, CLAUDE.md rule 6).
 *
 * The guard is the point of this file. Malayalam is typed through input
 * methods: a composition of `അ → അവ → അവന → അവൻ` fires an `input` event per
 * stage and a keydown per keystroke, all reported by Chrome as keyCode 229.
 * Counting them collapses hesitation to the IME's own cadence and spikes
 * backspace density wherever the IME rewrote its own buffer — for exactly the
 * input method the app exists to support.
 */

import { describe, expect, it } from 'vitest';
import { TypingSignals } from '@/signals/typing';
import { HESITATION_MIN_MS, IDLE_CUTOFF_MS } from '@/signals/constants';

type Emitted = [kind: string, blockId: string, value: number];

/** A clock the test moves by hand, so pauses cost no wall time. */
function harness() {
  const emitted: Emitted[] = [];
  const interactions: number[] = [];
  let clock = 0;

  const typing = new TypingSignals((kind, blockId, value) => emitted.push([kind, blockId, value]), {
    now: () => clock,
    onInteraction: (at) => interactions.push(at),
  });

  return {
    typing,
    emitted,
    interactions,
    advance(ms: number) {
      clock += ms;
    },
    get at() {
      return clock;
    },
  };
}

describe('hesitation', () => {
  it('reports a pause inside one block', () => {
    const h = harness();
    h.typing.input('a', false);
    h.advance(4_000);
    h.typing.input('a', false);

    expect(h.emitted).toEqual([['hesitation', 'a', 4_000]]);
  });

  it('ignores ordinary typing rhythm', () => {
    const h = harness();
    for (let i = 0; i < 20; i++) {
      h.typing.input('a', false);
      h.advance(120);
    }
    expect(h.emitted).toEqual([]);
  });

  it('ignores a gap long enough to be absence rather than thought', () => {
    const h = harness();
    h.typing.input('a', false);
    h.advance(IDLE_CUTOFF_MS + 1);
    h.typing.input('a', false);
    expect(h.emitted).toEqual([]);
  });

  it('does not report the gap across a block change', () => {
    // Which contains a tap, possibly a scroll, and a mount. That is navigating,
    // not pausing over this sentence.
    const h = harness();
    h.typing.input('a', false);
    h.advance(5_000);
    h.typing.input('b', false);
    expect(h.emitted).toEqual([]);
  });

  it('does not report the gap across leaving and returning to a block', () => {
    const h = harness();
    h.typing.input('a', false);
    h.typing.blur();
    h.advance(10_000);
    h.typing.input('a', false);
    expect(h.emitted).toEqual([]);
  });
});

describe('backspace density', () => {
  it('counts deletions and nothing else', () => {
    const h = harness();
    h.typing.keyDown('a', 'Backspace', false);
    h.typing.keyDown('a', 'Backspace', false);
    h.typing.keyDown('a', 'Delete', false);
    h.typing.keyDown('a', 'ക', false);
    h.typing.keyDown('a', 'ArrowLeft', false);

    expect(h.emitted).toEqual([
      ['backspace', 'a', 1],
      ['backspace', 'a', 1],
      ['backspace', 'a', 1],
    ]);
  });
});

describe('IME composition (ADR-0010)', () => {
  it('counts no backspace pressed inside a composition', () => {
    /*
     * Deleting a candidate character is the IME editing its own buffer, not the
     * writer fighting the words. This is the assertion that fails if the
     * isComposing check is "simplified" out of typing.ts.
     */
    const h = harness();
    for (let i = 0; i < 8; i++) h.typing.keyDown('a', 'Backspace', true);
    expect(h.emitted).toEqual([]);

    h.typing.keyDown('a', 'Backspace', false);
    expect(h.emitted).toEqual([['backspace', 'a', 1]]);
  });

  it('reports no hesitation between composition stages', () => {
    // A writer composing അ → അവ → അവന over several seconds is typing the whole
    // time. Naming any of it hesitation would report the IME's cadence.
    const h = harness();
    for (const _stage of ['അ', 'അവ', 'അവന']) {
      h.typing.input('a', true);
      h.advance(3_000);
    }
    expect(h.emitted).toEqual([]);
  });

  it('measures the pause after a composition from the last keystroke in it', () => {
    /*
     * Composing keystrokes are not counted, but they DO move the clock: they
     * are real keypresses by a real writer. Dropping them would report the
     * whole composition, plus the pause after it, as one long thought.
     */
    const h = harness();
    h.typing.input('a', false); // t=0
    h.advance(1_000);
    h.typing.input('a', true); // composing, t=1,000
    h.advance(1_000);
    h.typing.input('a', true); // composing, t=2,000
    h.advance(5_000);
    h.typing.input('a', false); // t=7,000

    expect(h.emitted).toEqual([['hesitation', 'a', 5_000]]);
  });

  it('still stamps the idle clock while composing', () => {
    // Otherwise a writer typing Malayalam and nothing else looks idle to the
    // attention model, and their dwell stops accruing after 60 s of work.
    const h = harness();
    h.typing.input('a', true);
    h.advance(HESITATION_MIN_MS);
    h.typing.keyDown('a', 'Backspace', true);

    expect(h.interactions).toEqual([0, HESITATION_MIN_MS]);
  });
});
