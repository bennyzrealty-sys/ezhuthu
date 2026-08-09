/**
 * A read-only block. This is what 99% of the document is at any moment.
 *
 * Plain divs, not contenteditable — that is what lets virtualisation and text
 * editing coexist (ADR-0004). The browser only ever manages one editing
 * context, which it does extremely well, including IME composition and
 * autocorrect that we would otherwise have to rebuild.
 */

import { memo } from 'react';

export interface BlockRowProps {
  blockId: string;
  text: string;
  /** Tap position is passed through so the caret can land where the finger did. */
  onActivate: (blockId: string, clientX: number, clientY: number) => void;
}

function BlockRowImpl({ blockId, text, onActivate }: BlockRowProps) {
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
      {text === '' ? ' ' : text}
    </div>
  );
}

/**
 * Memoised on text identity: scrolling re-renders the list constantly, and
 * rows whose text has not changed must not re-render with it.
 */
export const BlockRow = memo(BlockRowImpl);
