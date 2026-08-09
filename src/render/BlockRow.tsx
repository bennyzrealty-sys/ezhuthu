/**
 * A read-only block. This is what 99% of the document is at any moment.
 *
 * Plain divs, not contenteditable — that is what lets virtualisation and text
 * editing coexist (ADR-0004). The browser only ever manages one editing
 * context, which it does extremely well, including IME composition and
 * autocorrect that we would otherwise have to rebuild.
 */

import { memo, type ReactNode } from 'react';

export interface BlockRowProps {
  blockId: string;
  text: string;
  /** Tap position is passed through so the caret can land where the finger did. */
  onActivate: (blockId: string, clientX: number, clientY: number) => void;
  /**
   * Offsets of a search match to mark, in this block's own text. Offsets come
   * from text/search.ts and are already snapped to grapheme boundaries, so
   * slicing on them cannot sever a vowel sign from its base.
   */
  highlight?: { start: number; end: number };
}

/**
 * Split the text around the highlight.
 *
 * The mark carries a background and nothing else — no padding, no weight, no
 * font change. Anything that alters metrics would make the text reflow the
 * moment the highlight cleared, and the reader is looking straight at it.
 */
function withHighlight(text: string, at: BlockRowProps['highlight']): ReactNode {
  if (at === undefined || at.start >= at.end || at.end > text.length) return text;
  return (
    <>
      {text.slice(0, at.start)}
      <mark className="block-match">{text.slice(at.start, at.end)}</mark>
      {text.slice(at.end)}
    </>
  );
}

function BlockRowImpl({ blockId, text, onActivate, highlight }: BlockRowProps) {
  return (
    <div
      className="block-row"
      data-block-id={blockId}
      // Malayalam and English interleave inside a single paragraph constantly,
      // so never assume one script per block (docs/MALAYALAM.md Rule 6).
      dir="auto"
      role="button"
      tabIndex={0}
      /*
       * `click`, NOT `pointerdown`.
       *
       * Activating on pointerdown swaps this node for a textarea and focuses
       * it — and then the browser finishes the gesture it already started.
       * The subsequent mousedown targets whatever now sits under the cursor,
       * and its default action moves focus away from the field we just
       * focused. The editor mounts and is blurred within the same gesture, so
       * the tap appears to do nothing at all.
       *
       * Waiting for click means the focus-moving default action has already
       * run before we mount. Click still fires within the user gesture, so
       * calling focus() from it opens the mobile keyboard.
       */
      onClick={(e) => onActivate(blockId, e.clientX, e.clientY)}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        const box = e.currentTarget.getBoundingClientRect();
        onActivate(blockId, box.left + 1, box.top + 1);
      }}
    >
      {text === '' ? ' ' : withHighlight(text, highlight)}
    </div>
  );
}

/**
 * Memoised on text identity: scrolling re-renders the list constantly, and
 * rows whose text has not changed must not re-render with it.
 */
export const BlockRow = memo(BlockRowImpl);
