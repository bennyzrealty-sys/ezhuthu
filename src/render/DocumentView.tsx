/**
 * The virtualiser host. Owns the block index, the visible-text window, and
 * which block is focused.
 *
 * Only blocks in and slightly around the viewport exist in the DOM: a
 * 100k-word document is ~2,000 blocks and we render 15-30. Heights are
 * measured rather than assumed, because Malayalam wrapping cannot be predicted
 * from character counts.
 *
 * Block TEXT is never all resident (docs/PERFORMANCE.md). What is held for
 * every block is the compact index — id, order, updatedAt, revisionCount,
 * length — about 100 bytes each. Text is fetched by range as the viewport
 * needs it and evicted behind.
 */

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { EzhuthuDB } from '../db/schema';
import type { BlockIndexEntry, DocId } from '../db/types';
import { deleteBlock, insertBlock, updateBlock } from '../core/events';
import { HeightCache } from './measure';
import { caretOffsetFromPoint } from './caret';
import { BlockRow } from './BlockRow';
import { BlockEditor } from './BlockEditor';
import { MarginBar } from './MarginBar';
import { Minimap } from './Minimap';
import { markIntensity } from '../features/visibility/intensity';
import { SignalCollector } from '../signals/collector';

/** Blocks rendered beyond the viewport on each side. */
const OVERSCAN = 6;
/** Text is fetched for the visible range plus this margin. */
const TEXT_MARGIN = 24;

/** Where a search result lives, and which characters of it to mark. */
export interface RevealTarget {
  blockId: string;
  /** Position among live blocks, from the search cursor. A hint, not the truth. */
  position: number;
  match?: { start: number; end: number };
}

export interface DocumentViewHandle {
  /**
   * Scroll a block into view and mark the match inside it.
   *
   * Imperative because it is a one-off command, not state: expressing "go
   * here" as a prop means every re-render has an opinion about where the
   * document is scrolled, and the reader scrolling away afterwards fights it.
   */
  reveal: (target: RevealTarget) => void;
  clearHighlight: () => void;
}

export interface DocumentViewProps {
  db: EzhuthuDB;
  docId: DocId;
  onChange?: () => void;
  /**
   * Clock for margin-bar decay (ADR-0006, CLAUDE.md rule 8). Injected rather
   * than called inside the render so the decay is testable; real callers omit
   * it. Read once per render, so bars fade whenever the list re-renders — which
   * a scroll or an edit already forces — not on a timer of their own.
   */
  now?: () => number;
  ref?: RefObject<DocumentViewHandle | null>;
}

interface FocusTarget {
  blockId: string;
  caret: number;
}

export function DocumentView({ db, docId, onChange, now, ref }: DocumentViewProps) {
  const [index, setIndex] = useState<BlockIndexEntry[]>([]);
  const [texts, setTexts] = useState<Map<string, string>>(new Map());
  const [focus, setFocus] = useState<FocusTarget | null>(null);
  const [loading, setLoading] = useState(true);
  const [highlight, setHighlight] = useState<RevealTarget | null>(null);
  const [signals, setSignals] = useState<SignalCollector | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const heights = useRef(new HeightCache());
  const width = useRef(0);

  // -------------------------------------------------------------------------
  // Index
  // -------------------------------------------------------------------------

  const loadIndex = useCallback(async () => {
    const blocks = await db.blocks
      .where('[docId+order]')
      .between([docId, ''], [docId, '￿'])
      .toArray();

    // Text is dropped here rather than retained: this is the one moment the
    // whole document passes through memory, and holding it would blow the
    // memory budget outright.
    setIndex(
      blocks
        .filter((b) => b.deletedAt === undefined)
        .map((b) => ({
          blockId: b.blockId,
          order: b.order,
          updatedAt: b.updatedAt,
          revisionCount: b.revisionCount,
          length: b.text.length,
          deleted: false,
        })),
    );
    setLoading(false);
  }, [db, docId]);

  useEffect(() => {
    void loadIndex();
  }, [loadIndex]);

  // -------------------------------------------------------------------------
  // Virtualiser
  // -------------------------------------------------------------------------

  const estimateSize = useCallback(
    (i: number) => {
      const entry = index[i];
      if (entry === undefined) return 48;
      const cached = heights.current.get(entry.blockId, width.current);
      return cached ?? heights.current.estimate(entry.length, width.current || 360);
    },
    [index],
  );

  const virtualizer = useVirtualizer({
    count: index.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    overscan: OVERSCAN,
    getItemKey: (i) => index[i]?.blockId ?? i,
  });

  const items = virtualizer.getVirtualItems();

  // -------------------------------------------------------------------------
  // Text window
  // -------------------------------------------------------------------------

  const first = items[0]?.index ?? 0;
  const last = items.at(-1)?.index ?? 0;

  useEffect(() => {
    if (index.length === 0) return;

    const from = Math.max(0, first - TEXT_MARGIN);
    const to = Math.min(index.length - 1, last + TEXT_MARGIN);
    const wanted = index.slice(from, to + 1).map((e) => e.blockId);

    let cancelled = false;
    void (async () => {
      const missing = wanted.filter((id) => !texts.has(id));
      if (missing.length === 0) return;

      const fetched = await db.blocks.bulkGet(missing);
      if (cancelled) return;

      setTexts((previous) => {
        const next = new Map(previous);
        for (const block of fetched) {
          if (block !== undefined) next.set(block.blockId, block.text);
        }
        // Evict anything well outside the window so a long scroll does not
        // accumulate the whole document in memory.
        if (next.size > wanted.length * 3) {
          const keep = new Set(wanted);
          for (const id of next.keys()) {
            if (!keep.has(id) && id !== focus?.blockId) next.delete(id);
          }
        }
        return next;
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [db, index, first, last, texts, focus?.blockId]);

  // -------------------------------------------------------------------------
  // Width changes — rotation, resize, split view
  // -------------------------------------------------------------------------

  useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;

    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 0;
      if (heights.current.setWidth(next)) {
        width.current = Math.round(next);
        virtualizer.measure();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [virtualizer]);

  // -------------------------------------------------------------------------
  // Jumping to a search result
  // -------------------------------------------------------------------------

  useImperativeHandle(
    ref,
    () => ({
      reveal(target) {
        /*
         * The search cursor and this index are both "live blocks in order", so
         * `position` is normally right. It can still be stale — a block
         * deleted between the search and the tap shifts everything after it —
         * so the id is what we trust and the position is only a starting
         * guess. Getting this backwards sends the reader to a paragraph near
         * the one they asked for, which is worse than a visible miss.
         */
        const at =
          index[target.position]?.blockId === target.blockId
            ? target.position
            : index.findIndex((e) => e.blockId === target.blockId);
        if (at === -1) return;

        setHighlight(target);
        // `center` rather than `start`: a result pinned under the toolbar
        // gives no context above it, and context is what tells the reader
        // whether this is the paragraph they meant.
        virtualizer.scrollToIndex(at, { align: 'center' });
      },
      clearHighlight() {
        setHighlight(null);
      },
    }),
    [index, virtualizer],
  );

  // -------------------------------------------------------------------------
  // Font loading
  // -------------------------------------------------------------------------

  /*
   * Safety net for the case `font-display: block` is meant to make impossible.
   * If Manjari has not arrived within the block period the browser paints the
   * fallback face, and every height measured against it is wrong — at 1,563
   * blocks that is a scrollbar lying by whole screens. Clearing the cache when
   * fonts settle costs one re-measure of the ~12 rendered rows.
   *
   * On the normal path the font is already loaded here and this fires once
   * with nothing cached, which is free.
   */
  useEffect(() => {
    if (typeof document === 'undefined' || document.fonts === undefined) return;

    let cancelled = false;
    void document.fonts.ready.then(() => {
      if (cancelled) return;
      heights.current.clear();
      virtualizer.measure();
    });

    return () => {
      cancelled = true;
    };
  }, [virtualizer]);

  // -------------------------------------------------------------------------
  // Attention telemetry
  // -------------------------------------------------------------------------

  /*
   * The collector needs the scroll element, which does not exist on the first
   * render: a loading or empty document renders a placeholder instead. `ready`
   * is what this waits for, rather than mount.
   *
   * Everything it does is on a timer or a passive listener. The only part the
   * editor touches is `signals.typing`, and only from handlers that already
   * run — see signals/collector.ts.
   */
  const ready = !loading && index.length > 0;

  useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;

    const collector = new SignalCollector(db, docId, element);
    setSignals(collector);

    return () => {
      setSignals(null);
      // Takes a final sample and flushes; failures are swallowed inside.
      void collector.stop();
    };
  }, [db, docId, ready]);

  // -------------------------------------------------------------------------
  // Editing
  // -------------------------------------------------------------------------

  const patchEntry = useCallback((blockId: string, text: string) => {
    setIndex((previous) =>
      previous.map((e) =>
        e.blockId === blockId
          ? { ...e, length: text.length, revisionCount: e.revisionCount + 1, updatedAt: Date.now() }
          : e,
      ),
    );
  }, []);

  const activate = useCallback(
    (blockId: string, clientX: number, clientY: number) => {
      const element = scrollRef.current?.querySelector(`[data-block-id="${blockId}"]`);
      const text = texts.get(blockId) ?? '';
      const caret =
        element === null || element === undefined
          ? text.length
          : caretOffsetFromPoint(element, clientX, clientY, text);
      setFocus({ blockId, caret });
      // The mark's offsets are into the text as it was when the search ran.
      // Once the reader is editing, they are a claim about text that is about
      // to change, so drop it rather than let it drift.
      setHighlight(null);
    },
    [texts],
  );

  const commit = useCallback(
    async (blockId: string, text: string) => {
      if (texts.get(blockId) === text) return;
      await updateBlock(db, docId, blockId, text);
      setTexts((previous) => new Map(previous).set(blockId, text));
      patchEntry(blockId, text);
      heights.current.invalidate(blockId);
      onChange?.();
    },
    [db, docId, texts, patchEntry, onChange],
  );

  const split = useCallback(
    async (blockId: string, before: string, after: string) => {
      await updateBlock(db, docId, blockId, before);
      const event = await insertBlock(db, docId, after, blockId);

      setTexts((previous) => {
        const next = new Map(previous);
        next.set(blockId, before);
        next.set(event.blockId, after);
        return next;
      });
      heights.current.invalidate(blockId);

      const created = await db.blocks.get(event.blockId);
      if (created !== undefined) {
        setIndex((previous) => {
          const at = previous.findIndex((e) => e.blockId === blockId);
          const entry: BlockIndexEntry = {
            blockId: created.blockId,
            order: created.order,
            updatedAt: created.updatedAt,
            revisionCount: 0,
            length: created.text.length,
            deleted: false,
          };
          const next = [...previous];
          next.splice(at + 1, 0, entry);
          next[at] = { ...next[at]!, length: before.length };
          return next;
        });
      }

      setFocus({ blockId: event.blockId, caret: 0 });
      onChange?.();
    },
    [db, docId, onChange],
  );

  const mergeBack = useCallback(
    async (blockId: string, text: string) => {
      const at = index.findIndex((e) => e.blockId === blockId);
      const previousEntry = index[at - 1];
      if (previousEntry === undefined) return; // first block: nothing to merge into

      const previousBlock = await db.blocks.get(previousEntry.blockId);
      if (previousBlock === undefined) return;

      const joined = previousBlock.text + text;
      await updateBlock(db, docId, previousEntry.blockId, joined);
      await deleteBlock(db, docId, blockId);

      setTexts((prev) => {
        const next = new Map(prev);
        next.set(previousEntry.blockId, joined);
        next.delete(blockId);
        return next;
      });
      heights.current.invalidate(previousEntry.blockId);
      setIndex((prev) =>
        prev
          .filter((e) => e.blockId !== blockId)
          .map((e) => (e.blockId === previousEntry.blockId ? { ...e, length: joined.length } : e)),
      );

      // Caret lands exactly at the join, which is where the text the reader
      // was deleting used to begin.
      setFocus({ blockId: previousEntry.blockId, caret: previousBlock.text.length });
      onChange?.();
    },
    [db, docId, index, onChange],
  );

  const blur = useCallback(
    async (blockId: string, text: string) => {
      await commit(blockId, text);
      setFocus((current) => (current?.blockId === blockId ? null : current));
    },
    [commit],
  );

  const reportHeight = useCallback((blockId: string, height: number) => {
    heights.current.set(blockId, width.current, height);
  }, []);

  // -------------------------------------------------------------------------

  const total = virtualizer.getTotalSize();
  const measureRef = useMemo(() => virtualizer.measureElement, [virtualizer]);

  // One clock read per render feeds every bar's decay, so the whole document
  // ages against a single instant rather than each bar reading its own.
  const nowMs = (now ?? Date.now)();

  // Stable so the minimap — memoised on the index — does not redraw on every
  // scroll frame. The virtualiser instance is stable across renders.
  const jumpToIndex = useCallback(
    (i: number) => virtualizer.scrollToIndex(i, { align: 'center' }),
    [virtualizer],
  );

  if (loading) {
    return <div className="doc-empty">തുറക്കുന്നു…</div>;
  }

  if (index.length === 0) {
    return <div className="doc-empty">This document is empty. Import a file to begin.</div>;
  }

  return (
    <div className="doc-viewport">
      <div className="doc-scroll" ref={scrollRef}>
        <div className="doc-inner" style={{ height: `${total}px` }}>
          {items.map((item) => {
            const entry = index[item.index];
            if (entry === undefined) return null;
            const text = texts.get(entry.blockId);
            const focused = focus?.blockId === entry.blockId;
            const intensity = markIntensity(entry, nowMs);

            return (
              <div
                key={entry.blockId}
                data-index={item.index}
                ref={measureRef}
                className="doc-item"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                {intensity !== null && <MarginBar blockId={entry.blockId} intensity={intensity} />}
                {focused ? (
                  <BlockEditor
                    blockId={entry.blockId}
                    initialText={text ?? ''}
                    initialCaret={focus.caret}
                    onCommit={(id, value) => void commit(id, value)}
                    onSplit={(id, before, after) => void split(id, before, after)}
                    onMergeBack={(id, value) => void mergeBack(id, value)}
                    onBlur={(id, value) => void blur(id, value)}
                    onHeight={reportHeight}
                    typing={signals?.typing}
                  />
                ) : (
                  <BlockRow
                    blockId={entry.blockId}
                    text={text ?? ''}
                    onActivate={activate}
                    highlight={
                      highlight?.blockId === entry.blockId ? highlight.match : undefined
                    }
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
      <Minimap blocks={index} onJump={jumpToIndex} now={now} />
    </div>
  );
}
