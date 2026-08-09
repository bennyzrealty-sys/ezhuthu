/**
 * Keystroke-derived signals: hesitation and backspace density.
 *
 * **Every method here checks `isComposing` first** (ADR-0010, CLAUDE.md rule
 * 6). This is the rule this module is most likely to get wrong, because the
 * editor's own guard is somewhere else and cannot help us: during composition
 * Chrome reports `keyCode` 229 for everything and fires an `input` event per
 * candidate keystroke, so counting them would measure the input method rather
 * than the writer. Backspace density would spike wherever an IME rewrote its
 * own buffer, and hesitation would collapse to the IME's own cadence — for
 * exactly the input method Malayalam is typed with.
 *
 * Composing keystrokes are not counted, but they DO move the hesitation clock:
 * they are real keypresses by a real writer, and pretending they never happened
 * would report the whole composition as one long pause.
 *
 * Cost matters here — `input()` runs on the keystroke path. It is two map
 * lookups and a subtraction.
 */

import { HESITATION_MIN_MS, IDLE_CUTOFF_MS } from './constants';

export type EmitSignal = (kind: 'hesitation' | 'backspace', blockId: string, value: number) => void;

export interface TypingOptions {
  /** Monotonic clock. Wall clocks move backwards and would emit negative gaps. */
  now?: () => number;
  hesitationMinMs?: number;
  /** Gaps longer than this are absence, not hesitation — same reasoning as gate 2. */
  hesitationMaxMs?: number;
  /** Any keystroke, so the attention model's idle clock sees typing too. */
  onInteraction?: (now: number) => void;
}

export class TypingSignals {
  private readonly now: () => number;
  private readonly hesitationMinMs: number;
  private readonly hesitationMaxMs: number;
  private readonly onInteraction: ((now: number) => void) | undefined;

  private lastBlockId: string | null = null;
  private lastAt = 0;

  constructor(
    private readonly emit: EmitSignal,
    options: TypingOptions = {},
  ) {
    this.now = options.now ?? (() => performance.now());
    this.hesitationMinMs = options.hesitationMinMs ?? HESITATION_MIN_MS;
    this.hesitationMaxMs = options.hesitationMaxMs ?? IDLE_CUTOFF_MS;
    this.onInteraction = options.onInteraction;
  }

  /**
   * One `input` event on a block. `isComposing` comes from the event — the
   * caller must not resolve it for us.
   */
  input(blockId: string, isComposing: boolean): void {
    const at = this.now();
    this.onInteraction?.(at);

    const previousBlockId = this.lastBlockId;
    const previousAt = this.lastAt;
    this.lastBlockId = blockId;
    this.lastAt = at;

    if (isComposing) return;

    // Only within one block. The gap across a block change contains a tap, a
    // possible scroll and a mount — that is navigation, not a writer thinking
    // about this sentence.
    if (previousBlockId !== blockId) return;

    const gap = at - previousAt;
    if (gap < this.hesitationMinMs || gap > this.hesitationMaxMs) return;
    this.emit('hesitation', blockId, gap);
  }

  /** One `keydown`. Only deletions are counted; everything else is `input`'s job. */
  keyDown(blockId: string, key: string, isComposing: boolean): void {
    const at = this.now();
    this.onInteraction?.(at);
    if (isComposing) return;
    if (key !== 'Backspace' && key !== 'Delete') return;
    this.emit('backspace', blockId, 1);
  }

  /**
   * Focus left the block. Drops the hesitation clock so the pause that spans
   * "stopped typing, went away, came back to this same block" is not reported
   * as a single thought.
   */
  blur(): void {
    this.lastBlockId = null;
  }
}
