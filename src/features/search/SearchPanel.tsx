/**
 * In-app search (ADR-0015).
 *
 * Replaces browser find-in-page, which cannot see the 99% of the document that
 * is not in the DOM — and which ADR-0011 also depends on, as one of the three
 * things offered in exchange for cross-block selection.
 *
 * Results are block references. Selecting one scrolls the virtualiser to that
 * block and marks the match; nothing about search materialises the document.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { EzhuthuDB } from '../../db/schema';
import type { DocId } from '../../db/types';
import {
  EMPTY_OUTCOME,
  searchDocument,
  type SearchHit,
  type SearchOutcome,
} from './searchDocument';

/**
 * Wait this long after the last keystroke before scanning.
 *
 * The scan is a cursor over every block, so running it per keystroke means a
 * transliteration keyboard resolving one Malayalam word queues half a dozen
 * full-document scans. Long enough to coalesce a burst of typing, short enough
 * that a deliberate pause feels like it searched immediately.
 */
const DEBOUNCE_MS = 180;

export interface SearchPanelProps {
  db: EzhuthuDB;
  docId: DocId;
  onReveal: (hit: SearchHit, matchIndex: number) => void;
  onClose: () => void;
}

export function SearchPanel({ db, docId, onReveal, onClose }: SearchPanelProps) {
  const [needle, setNeedle] = useState('');
  const [wholeWord, setWholeWord] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [outcome, setOutcome] = useState<SearchOutcome>(EMPTY_OUTCOME);
  const [running, setRunning] = useState(false);
  const [selected, setSelected] = useState(0);
  /**
   * Whether `selected` has actually been jumped to. The first Enter should
   * open result 1, not skip to result 2 — but every Enter after that means
   * "next".
   */
  const [revealed, setRevealed] = useState(false);

  const field = useRef<HTMLInputElement | null>(null);
  const listId = useId();

  useEffect(() => {
    field.current?.focus();
  }, []);

  // ---------------------------------------------------------------------------
  // Scanning
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (needle === '') {
      setOutcome(EMPTY_OUTCOME);
      setRunning(false);
      return;
    }

    const controller = new AbortController();
    setRunning(true);

    const timer = setTimeout(() => {
      void searchDocument(db, docId, {
        needle,
        wholeWord,
        caseSensitive,
        signal: controller.signal,
      })
        .then((result) => {
          // An aborted scan covers a prefix of the document. Rendering it as a
          // finished one would show "3 results" for a query that has more.
          if (result.aborted) return;
          setOutcome(result);
          setSelected(0);
          setRevealed(false);
          setRunning(false);
        })
        .catch(() => {
          if (!controller.signal.aborted) setRunning(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [db, docId, needle, wholeWord, caseSensitive]);

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  const flat = useMemo(
    () => outcome.hits.flatMap((hit, hitIndex) => hit.matches.map((_, i) => ({ hitIndex, i }))),
    [outcome.hits],
  );

  const go = useCallback(
    (at: number) => {
      if (flat.length === 0) return;
      // Wraps in both directions: stepping through results in a manuscript,
      // stopping dead at the last one is more annoying than useful.
      const next = ((at % flat.length) + flat.length) % flat.length;
      const entry = flat[next]!;
      setSelected(next);
      setRevealed(true);
      onReveal(outcome.hits[entry.hitIndex]!, entry.i);
    },
    [flat, outcome.hits, onReveal],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      // Never act on a key during composition: Chrome reports keyCode 229 for
      // everything while an IME is resolving, so Enter here would be the IME
      // accepting a candidate, not the reader asking for the next result
      // (ADR-0010).
      if (event.nativeEvent.isComposing) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        if (!revealed) go(selected);
        else go(event.shiftKey ? selected - 1 : selected + 1);
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        go(selected + 1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        go(selected - 1);
      }
    },
    [go, onClose, selected, revealed],
  );

  // ---------------------------------------------------------------------------

  const summary = summarise(outcome, needle, running);

  return (
    <div className="search-panel" role="search" onKeyDown={onKeyDown}>
      <div className="search-bar">
        <input
          ref={field}
          type="search"
          className="search-field"
          value={needle}
          placeholder="തിരയുക · Search"
          aria-label="Search the document"
          aria-controls={listId}
          data-testid="search-input"
          // Malayalam and English interleave, so let the field pick its own
          // direction from what is typed (Rule 6).
          dir="auto"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => setNeedle(e.target.value)}
        />
        <button type="button" onClick={onClose} aria-label="Close search">
          ✕
        </button>
      </div>

      <div className="search-options">
        <label>
          <input
            type="checkbox"
            checked={wholeWord}
            onChange={(e) => setWholeWord(e.target.checked)}
          />
          Whole word
        </label>
        <label>
          <input
            type="checkbox"
            checked={caseSensitive}
            onChange={(e) => setCaseSensitive(e.target.checked)}
          />
          Match case
        </label>
        <span className="spacer" />
        <span className="search-summary" data-testid="search-summary" aria-live="polite">
          {summary}
        </span>
      </div>

      <ul className="search-results" id={listId} data-testid="search-results">
        {outcome.hits.map((hit, hitIndex) => (
          <li key={hit.blockId}>
            <button
              type="button"
              className={flat[selected]?.hitIndex === hitIndex ? 'result current' : 'result'}
              onClick={() => go(flat.findIndex((f) => f.hitIndex === hitIndex))}
            >
              <span className="result-position">{hit.position + 1}</span>
              <span className="result-text" dir="auto">
                {hit.excerpt.elidedBefore && '…'}
                {hit.excerpt.text.slice(0, hit.excerpt.matchStart)}
                <mark>{hit.excerpt.text.slice(hit.excerpt.matchStart, hit.excerpt.matchEnd)}</mark>
                {hit.excerpt.text.slice(hit.excerpt.matchEnd)}
                {hit.excerpt.elidedAfter && '…'}
              </span>
              {hit.matches.length > 1 && (
                <span className="result-count">×{hit.matches.length}</span>
              )}
            </button>
          </li>
        ))}
      </ul>

      {outcome.truncated && (
        <p className="note search-note">
          Showing the first {outcome.hits.length.toLocaleString()} paragraphs. Narrow the search to
          see the rest.
        </p>
      )}
    </div>
  );
}

function summarise(outcome: SearchOutcome, needle: string, running: boolean): string {
  if (needle === '') return '';
  if (running) return 'തിരയുന്നു…';
  if (outcome.matchCount === 0) return 'No matches';

  const matches = `${outcome.matchCount.toLocaleString()} ${outcome.matchCount === 1 ? 'match' : 'matches'}`;
  const blocks = outcome.hits.length === 1 ? '1 paragraph' : `${outcome.hits.length} paragraphs`;
  return `${matches} in ${blocks}`;
}
