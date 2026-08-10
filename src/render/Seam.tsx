/**
 * A ghost marker (ADR-0018): the seam left where one or more blocks were
 * deleted. Collapsed, it is a 2 px rule the width of the text — quiet, but
 * present, so a deletion is not invisible. Tapped, it reveals the deleted text;
 * tapped again it collapses. Each revealed paragraph offers Restore, which
 * appends an event like any other change and puts the text back where it was.
 *
 * The text is fetched lazily on first reveal — a seam over the whole document
 * must not carry the deleted manuscript in memory before anyone asks to see it.
 */

import { useCallback, useState } from 'react';
import type { Ghost } from '../features/visibility/seams';

export interface SeamProps {
  ghosts: Ghost[];
  /** Fetch a deleted block's text on demand. */
  getText: (blockId: string) => Promise<string>;
  /** Restore one deleted block. Resolves once the document has caught up. */
  onRestore: (blockId: string) => Promise<void>;
}

export function Seam({ ghosts, getText, onRestore }: SeamProps) {
  const [open, setOpen] = useState(false);
  const [texts, setTexts] = useState<Map<string, string>>(new Map());
  const [restoring, setRestoring] = useState<string | null>(null);

  const total = ghosts.length;
  const label =
    total === 1 ? '1 deleted paragraph' : `${total} deleted paragraphs`;

  const toggle = useCallback(async () => {
    const next = !open;
    setOpen(next);
    if (!next) return;

    // Fetch anything we do not already hold. A seam that stays open across a
    // restore keeps the texts it had; only the missing ones are read.
    const missing = ghosts.filter((g) => !texts.has(g.blockId));
    if (missing.length === 0) return;
    const fetched = await Promise.all(missing.map((g) => getText(g.blockId)));
    setTexts((previous) => {
      const map = new Map(previous);
      missing.forEach((g, i) => map.set(g.blockId, fetched[i] ?? ''));
      return map;
    });
  }, [open, ghosts, texts, getText]);

  const restore = useCallback(
    async (blockId: string) => {
      setRestoring(blockId);
      try {
        await onRestore(blockId);
      } finally {
        setRestoring(null);
      }
    },
    [onRestore],
  );

  return (
    <div className={`seam${open ? ' is-open' : ''}`} data-testid="seam">
      <button
        type="button"
        className="seam-rule"
        aria-expanded={open}
        aria-label={`${label} — tap to ${open ? 'hide' : 'show'}`}
        data-testid="seam-rule"
        onClick={() => void toggle()}
      >
        <span className="seam-count">{label}</span>
      </button>

      {open && (
        <ul className="seam-ghosts">
          {ghosts.map((ghost) => (
            <li key={ghost.blockId} className="seam-ghost">
              <p className="seam-text">{texts.get(ghost.blockId) ?? '…'}</p>
              <button
                type="button"
                className="seam-restore"
                data-testid="seam-restore"
                disabled={restoring !== null}
                onClick={() => void restore(ghost.blockId)}
              >
                {restoring === ghost.blockId ? 'Restoring…' : 'Restore'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
