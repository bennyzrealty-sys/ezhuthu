/**
 * Scroll-back auto-bookmarks (docs/SIGNALS.md). The places the writer keeps
 * scrolling back to — a character's name, a fact laid down long ago — surfaced
 * as a list he can jump to. He never made these bookmarks; the returning is what
 * marked them.
 *
 * A panel, not a strip: unlike Resume (an opening offer, once per launch), this
 * is a tool reached on demand, so it is modelled on Search — toggled from the
 * toolbar, each row jumps the document to that block.
 */

import { useEffect, useId, useState } from 'react';
import type { EzhuthuDB } from '../../db/schema';
import type { DocId } from '../../db/types';
import { resolveBookmarks, type Bookmark } from './bookmarks';

export interface BookmarksPanelProps {
  db: EzhuthuDB;
  docId: DocId;
  onReveal: (blockId: string) => void;
  onClose: () => void;
}

export function BookmarksPanel({ db, docId, onReveal, onClose }: BookmarksPanelProps) {
  const [bookmarks, setBookmarks] = useState<Bookmark[] | null>(null);
  const listId = useId();

  useEffect(() => {
    let cancelled = false;
    void resolveBookmarks(db, docId).then((found) => {
      if (!cancelled) setBookmarks(found);
    });
    return () => {
      cancelled = true;
    };
  }, [db, docId]);

  return (
    <div
      className="bookmarks-panel"
      role="region"
      aria-label="Places you keep returning to"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div className="bookmarks-head">
        <span className="bookmarks-title">Places you keep returning to</span>
        <span className="spacer" />
        <button type="button" onClick={onClose} aria-label="Close bookmarks">
          ✕
        </button>
      </div>

      {bookmarks !== null && bookmarks.length === 0 && (
        <p className="note bookmarks-note" data-testid="bookmarks-empty">
          Nothing yet. When you scroll back to check something and stay there, it shows up here.
        </p>
      )}

      <ul className="bookmarks-list" id={listId} data-testid="bookmarks-list">
        {(bookmarks ?? []).map((bookmark) => (
          <li key={bookmark.blockId}>
            <button
              type="button"
              className="bookmark"
              data-testid="bookmark"
              onClick={() => onReveal(bookmark.blockId)}
            >
              <span className="bookmark-excerpt" dir="auto">
                {bookmark.excerpt}
              </span>
              <span className="bookmark-detail">{bookmark.detail}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
