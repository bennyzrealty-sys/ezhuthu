/**
 * The time-lapse scrub.
 *
 * Drag the slider and the document behind it becomes the document as it was.
 * Everything expensive happens in the Worker (ADR-0009); this component holds a
 * timeline, a position, and one window of paragraphs.
 *
 * THE READING POSITION IS FIXED AND TIME MOVES. That is the whole design. A
 * scrub that reset to the top of the document on every position would be a
 * series of unrelated snapshots of a first paragraph; keeping the offset and
 * moving time is what lets a writer watch one passage being rewritten, which is
 * the only question anybody actually asks of their own history.
 *
 * Read-only, and no path from here appends anything. Restoring a past state is
 * not offered: it would be a whole-document write, and the one honest way to do
 * it — replay forward into new events — is not something to bolt onto a viewer.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DocId } from '../../db/types';
import { TimelapseClient, createReplayWorker } from './client';
import type { PastBlock, PastSummary } from './materialise';
import { EMPTY_TIMELINE, type Timeline } from './timeline';
import { WINDOW_BLOCKS } from './constants';

export interface TimelapsePanelProps {
  docId: DocId;
  onClose: () => void;
}

/** Only the parts of a date the reader needs to place a stop. */
const stamp = (ts: number): string =>
  new Date(ts).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

export function TimelapsePanel({ docId, onClose }: TimelapsePanelProps) {
  const [timeline, setTimeline] = useState<Timeline>(EMPTY_TIMELINE);
  const [index, setIndex] = useState(0);
  const [summary, setSummary] = useState<PastSummary | null>(null);
  const [blocks, setBlocks] = useState<PastBlock[]>([]);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const client = useRef<TimelapseClient | null>(null);

  // ---------------------------------------------------------------------------
  // The Worker, and the timeline it builds once
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const started = new TimelapseClient(createReplayWorker());
    client.current = started;

    let cancelled = false;
    void started
      .timeline(docId)
      .then((built) => {
        if (cancelled) return;
        setTimeline(built);
        // Open at the present: the panel should first show what the reader can
        // already see, so that dragging is visibly a move backwards rather than
        // an unexplained jump.
        setIndex(Math.max(0, built.stops.length - 1));
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });

    return () => {
      cancelled = true;
      client.current = null;
      started.close();
    };
  }, [docId]);

  // ---------------------------------------------------------------------------
  // Materialising the position
  // ---------------------------------------------------------------------------

  const stop = timeline.stops[index];

  useEffect(() => {
    const active = client.current;
    if (active === null || stop === undefined) return;

    let cancelled = false;
    void active
      .materialise(docId, stop.seq)
      // `null` means the thumb moved on before the Worker reached this
      // position. Nothing to render and nothing wrong.
      .then((result) => {
        if (cancelled || result === null) return;
        setSummary(result);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });

    return () => {
      cancelled = true;
    };
  }, [docId, stop]);

  // ---------------------------------------------------------------------------
  // The window of text
  // ---------------------------------------------------------------------------

  const seq = summary?.seq;

  useEffect(() => {
    const active = client.current;
    if (active === null || seq === undefined) return;

    let cancelled = false;
    void active
      .window(docId, offset, WINDOW_BLOCKS)
      .then((result) => {
        // The Worker holds one state. A window that arrives after the scrub has
        // moved on belongs to a different moment, and showing it would put the
        // wrong paragraphs under the date on screen.
        if (cancelled || result.seq !== seq) return;
        setBlocks(result.blocks);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });

    return () => {
      cancelled = true;
    };
  }, [docId, seq, offset]);

  // Clamp the reading position when the past document is shorter than the
  // present one — which it usually is.
  const blockCount = summary?.blockCount ?? 0;
  useEffect(() => {
    if (blockCount > 0 && offset >= blockCount) {
      setOffset(Math.max(0, blockCount - WINDOW_BLOCKS));
    }
  }, [blockCount, offset]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    },
    [onClose],
  );

  const label = useMemo(() => {
    if (stop === undefined) return '';
    const at = stamp(stop.ts);
    const words = summary === null ? '…' : summary.wordCount.toLocaleString();
    const paragraphs = summary === null ? '…' : summary.blockCount.toLocaleString();
    return `${at} · ${words} words · ${paragraphs} paragraphs`;
  }, [stop, summary]);

  const atPresent = index === timeline.stops.length - 1;

  return (
    <div className="timelapse-panel" onKeyDown={onKeyDown} data-testid="timelapse-panel">
      <div className="timelapse-bar">
        <strong>സമയരേഖ · Time-lapse</strong>
        <span className="spacer" />
        <button type="button" onClick={onClose} aria-label="Close time-lapse">
          ✕
        </button>
      </div>

      {error !== null && <p className="note state-danger">{error}</p>}

      {loading ? (
        <p className="note">ചരിത്രം വായിക്കുന്നു…</p>
      ) : timeline.stops.length === 0 ? (
        <p className="note">
          This document has no history yet. Write something and it will have one.
        </p>
      ) : (
        <>
          <div className="timelapse-scrub">
            <input
              type="range"
              min={0}
              max={timeline.stops.length - 1}
              step={1}
              value={index}
              data-testid="timelapse-slider"
              aria-label="Point in history"
              aria-valuetext={label}
              onChange={(e) => setIndex(Number(e.target.value))}
            />
            <span className="timelapse-label" data-testid="timelapse-label" aria-live="polite">
              {label}
            </span>
            <span className="timelapse-position">
              {index + 1}/{timeline.stops.length}
              {atPresent && ' · now'}
            </span>
          </div>

          <div className="timelapse-doc" data-testid="timelapse-doc">
            {blocks.map((block) => (
              // Not a .block-row: this text is not editable and must not invite
              // a tap that does nothing.
              <p key={block.blockId} className="past-row" dir="auto">
                {block.text}
              </p>
            ))}
            {blocks.length === 0 && <p className="note">Nothing here at this point.</p>}
          </div>

          <div className="timelapse-paging">
            <button
              type="button"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - WINDOW_BLOCKS))}
            >
              ↑ Earlier paragraphs
            </button>
            <span className="note">
              {blockCount === 0
                ? ''
                : `${(offset + 1).toLocaleString()}–${Math.min(
                    offset + blocks.length,
                    blockCount,
                  ).toLocaleString()} of ${blockCount.toLocaleString()}`}
            </span>
            <button
              type="button"
              disabled={offset + WINDOW_BLOCKS >= blockCount}
              onClick={() => setOffset(offset + WINDOW_BLOCKS)}
            >
              ↓ Later paragraphs
            </button>
          </div>
        </>
      )}
    </div>
  );
}
