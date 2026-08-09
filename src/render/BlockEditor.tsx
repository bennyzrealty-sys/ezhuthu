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

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { placeCaret } from './caret';
import { previousClusterBoundary } from '../text/segmenter';

/** Quiet time before an edit is committed to the log. */
export const IDLE_COMMIT_MS = 400;

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
}: BlockEditorProps) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const composing = useRef(false);
  const timer = useRef<number | null>(null);
  /** Latest text, held outside React so typing never triggers a render. */
  const draft = useRef(initialText);

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
    if (draft.current === initialText) return;
    onCommit(blockId, draft.current);
  }, [blockId, clearTimer, initialText, onCommit]);

  const scheduleCommit = useCallback(() => {
    clearTimer();
    if (composing.current) return;
    timer.current = window.setTimeout(commitNow, IDLE_COMMIT_MS);
  }, [clearTimer, commitNow]);

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
    field.value = initialText;
    resize();
    placeCaret(field, initialCaret);
    // Mount only: re-running this on every prop change would fight the IME and
    // reset the caret mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockId]);

  useEffect(() => clearTimer, [clearTimer]);

  const handleInput = useCallback(() => {
    // Everything expensive is deliberately absent from this function.
    const field = ref.current;
    if (field === null) return;
    draft.current = field.value;
    resize();
    scheduleCommit();
  }, [resize, scheduleCommit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
    [blockId, clearTimer, onMergeBack, onSplit],
  );

  return (
    <textarea
      ref={ref}
      className="block-editor"
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
        // Blur during composition finalises it first; the browser fires
        // compositionend before blur, so the draft is already settled.
        onBlur(blockId, draft.current);
      }}
    />
  );
}
