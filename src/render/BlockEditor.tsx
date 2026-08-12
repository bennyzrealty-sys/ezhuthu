/**
 * The one focused, editable block.
 *
 * Two rules govern everything here:
 *
 * 1. **The change handler stores a string and returns.** The keystroke path
 *    must stay empty to hold the 16ms budget. Word counting, segmentation,
 *    signal capture and persistence all happen at commit time or on idle.
 *    The field is uncontrolled — React must never drive its value while it is
 *    focused, or the caret jumps.
 *
 * 2. **Never commit while composing** (ADR-0010). Malayalam is typed through
 *    IMEs, and writing to or re-rendering the field mid-composition resets the
 *    IME buffer: half-formed conjuncts commit as separate characters, the
 *    caret jumps to the start, vowel signs duplicate. This causes more visible
 *    breakage than incorrect grapheme handling.
 *
 *    This guard IS tested — tests/e2e/ime.spec.ts drives real composition
 *    sessions through CDP `Input.imeSetComposition`. Removing the isComposing
 *    check there commits an EMPTY block, so do not "simplify" it away.
 */

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type RefObject,
} from 'react';
import { placeCaret } from './caret';
import { previousClusterBoundary } from '../text/segmenter';
import type { TypingSignals } from '../signals/typing';

/** Quiet time before an edit is committed to the log. */
export const IDLE_COMMIT_MS = 400;

/**
 * What the focused editor can be asked for from outside.
 *
 * The draft lives in a ref here and nowhere else — that is rule 1 of this file,
 * and it is why the field can be typed into without a render. The consequence
 * is that everything OUTSIDE this component, including the thing that writes
 * the document to a file, sees only what has been committed: up to
 * `IDLE_COMMIT_MS` of the writer's most recent sentence is invisible to it.
 * That is the whole of the "I downloaded my script and my edit was not in it"
 * bug. `flush` is the seam that closes it.
 */
export interface BlockEditorHandle {
  /**
   * Hand over the current draft and stand down the idle timer.
   *
   * Does not write anything: the caller owns the append path and has to be able
   * to await it. `composing` is passed out rather than acted on here, because
   * refusing to COMMIT during composition (rule 6, ADR-0010) is about not
   * corrupting the input, and says nothing about what a file should contain —
   * the text is what the writer can see either way.
   */
  flush: () => { blockId: string; text: string; composing: boolean };
}

export interface BlockEditorProps {
  blockId: string;
  initialText: string;
  /** Where to put the caret on mount, from the tap that focused this block. */
  initialCaret: number;
  onCommit: (blockId: string, text: string) => void;
  /** Enter: commit `before` to this block and open a new one holding `after`. */
  onSplit: (blockId: string, before: string, after: string) => void;
  /** Backspace at offset 0: merge this block into the previous one. */
  onMergeBack: (blockId: string, text: string) => void;
  onBlur: (blockId: string, text: string) => void;
  onHeight: (blockId: string, height: number) => void;
  /**
   * Attention telemetry. Absent is a working editor with no signals, which is
   * what the unit tests and any future embedding get.
   *
   * `isComposing` is passed through raw rather than resolved here: the check
   * lives in signals/typing.ts, where docs/SIGNALS.md says it lives, so that a
   * second caller cannot forget it (ADR-0010).
   */
  typing?: TypingSignals;
  /** Imperative access to the in-flight draft. See `BlockEditorHandle`. */
  handleRef?: RefObject<BlockEditorHandle | null>;
}

/**
 * React types `onInput`'s native event as a bare `Event`, and a synthetic
 * `new Event('input')` — which the perf suite dispatches — genuinely has no
 * `isComposing`. So read it defensively rather than casting to `InputEvent`;
 * absent means not composing, which is the safe direction for a signal.
 */
function isComposingEvent(event: Event): boolean {
  return (event as Partial<InputEvent>).isComposing === true;
}

export function BlockEditor({
  blockId,
  initialText,
  initialCaret,
  onCommit,
  onSplit,
  onMergeBack,
  onBlur,
  onHeight,
  typing,
  handleRef,
}: BlockEditorProps) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const composing = useRef(false);
  const timer = useRef<number | null>(null);
  /** Latest text, held outside React so typing never triggers a render. */
  const draft = useRef(initialText);
  /**
   * The last text handed to the owner to be committed.
   *
   * Not the same as `initialText`, which is the prop this editor mounted with
   * and does not change while it is focused. Without this, the unmount commit
   * cannot tell "never saved" from "saved a moment ago by blur", and appends a
   * second, identical `update` event — which is invisible in the document and
   * very visible in undo, where one press then takes back half an edit.
   */
  const handedOver = useRef(initialText);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const commitNow = useCallback(() => {
    clearTimer();
    // A commit that lands mid-composition corrupts the IME buffer. The timer
    // is restarted by compositionend instead.
    if (composing.current) return;
    if (draft.current === handedOver.current) return;
    handedOver.current = draft.current;
    onCommit(blockId, draft.current);
  }, [blockId, clearTimer, onCommit]);

  const scheduleCommit = useCallback(() => {
    clearTimer();
    if (composing.current) return;
    timer.current = window.setTimeout(commitNow, IDLE_COMMIT_MS);
  }, [clearTimer, commitNow]);

  useImperativeHandle(
    handleRef,
    () => ({
      flush() {
        // The field is the truth, not `draft`: text the browser has put in
        // `value` but not yet reported through an input event (an IME's own
        // buffer, a paste mid-processing) is already visible to the writer.
        const text = ref.current?.value ?? draft.current;
        draft.current = text;
        clearTimer();
        // The caller commits unless an IME is mid-word, so record it as handed
        // over in that case — otherwise the unmount commit repeats it.
        if (!composing.current) handedOver.current = text;
        return { blockId, text, composing: composing.current };
      },
    }),
    [blockId, clearTimer],
  );

  /** Grow to fit, and report the height so the virtualiser can reserve it. */
  const resize = useCallback(() => {
    const field = ref.current;
    if (field === null) return;
    field.style.height = 'auto';
    field.style.height = `${field.scrollHeight}px`;
    onHeight(blockId, field.offsetHeight);
  }, [blockId, onHeight]);

  useLayoutEffect(() => {
    const field = ref.current;
    if (field === null) return;
    draft.current = initialText;
    handedOver.current = initialText;
    field.value = initialText;
    resize();
    placeCaret(field, initialCaret);
    // Mount only: re-running this on every prop change would fight the IME and
    // reset the caret mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockId]);

  /*
   * Commit on unmount, not merely stand the timer down.
   *
   * The draft lives in a ref, and the field's own `blur` was doing the saving.
   * But a focused element that is REMOVED from the document does not get a
   * blur event in Chromium or WebKit, and this field is an ordinary
   * virtualised row: scroll the paragraph you are typing into off the screen
   * within the 400ms window and it is recycled, taking the sentence with it.
   * Undo (which reloads the view), Import (which remounts it) and appending a
   * paragraph (which moves focus) all unmount it the same way.
   *
   * Held in a ref rather than closed over, so the cleanup runs with the latest
   * draft and the latest `onCommit` without re-subscribing on every keystroke.
   * `draft` rather than the field's value: React may have detached the DOM ref
   * by the time this runs.
   */
  const commitOnUnmount = useRef<() => void>(() => undefined);
  commitOnUnmount.current = () => {
    // Rule 6: never commit mid-composition. The IME's buffer is the browser's
    // to finish, and this is not a moment we can make it safe.
    if (composing.current) return;
    if (draft.current === handedOver.current) return;
    handedOver.current = draft.current;
    onCommit(blockId, draft.current);
  };

  useEffect(
    () => () => {
      clearTimer();
      commitOnUnmount.current();
    },
    [clearTimer],
  );

  const handleInput = useCallback(
    (e: React.FormEvent<HTMLTextAreaElement>) => {
      // Everything expensive is deliberately absent from this function.
      const field = ref.current;
      if (field === null) return;
      draft.current = field.value;
      // Two map lookups and a subtraction. Anything more expensive than that
      // does not belong on this path — see docs/PERFORMANCE.md.
      typing?.input(blockId, isComposingEvent(e.nativeEvent) || composing.current);
      resize();
      scheduleCommit();
    },
    [blockId, resize, scheduleCommit, typing],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      typing?.keyDown(blockId, e.key, e.nativeEvent.isComposing || composing.current);

      // During composition Chrome reports keyCode 229 for everything, so key
      // identity is meaningless. isComposing is authoritative.
      if (e.nativeEvent.isComposing || composing.current) return;

      const field = e.currentTarget;

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        clearTimer();
        const at = field.selectionStart;
        onSplit(blockId, field.value.slice(0, at), field.value.slice(field.selectionEnd));
        return;
      }

      if (
        e.key === 'Backspace' &&
        field.selectionStart === 0 &&
        field.selectionEnd === 0
      ) {
        e.preventDefault();
        clearTimer();
        onMergeBack(blockId, field.value);
        return;
      }

      // Arrow keys move by grapheme cluster, not codepoint. Without this the
      // caret lands between a consonant and its vowel sign, and the next
      // keystroke inserts into the middle of a character.
      if (e.key === 'ArrowLeft' && !e.shiftKey && field.selectionStart === field.selectionEnd) {
        const target = previousClusterBoundary(field.value, field.selectionStart);
        if (target !== field.selectionStart) {
          e.preventDefault();
          field.setSelectionRange(target, target);
        }
      }
    },
    [blockId, clearTimer, onMergeBack, onSplit, typing],
  );

  return (
    <textarea
      ref={ref}
      className="block-editor"
      // The signal collector samples `[data-block-id]`, and the block being
      // edited is the one most obviously being attended to. Without this it is
      // the one block that accrues no dwell.
      data-block-id={blockId}
      dir="auto"
      rows={1}
      spellCheck={false}
      autoCapitalize="sentences"
      // Uncontrolled: React never writes `value` while this is focused.
      defaultValue={initialText}
      onInput={handleInput}
      onKeyDown={handleKeyDown}
      onCompositionStart={() => {
        composing.current = true;
        clearTimer();
      }}
      onCompositionEnd={() => {
        composing.current = false;
        const field = ref.current;
        if (field !== null) draft.current = field.value;
        resize();
        // The idle clock starts only once composition has finished, so the
        // effective cadence is "400ms quiet AFTER the IME is done".
        scheduleCommit();
      }}
      onBlur={() => {
        clearTimer();
        // Drops the hesitation clock: the gap either side of leaving a block is
        // navigation, not the writer pausing over this sentence.
        typing?.blur();
        // Blur during composition finalises it first; the browser fires
        // compositionend before blur, so the draft is already settled.
        handedOver.current = draft.current;
        onBlur(blockId, draft.current);
      }}
    />
  );
}
