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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { EzhuthuDB } from '../db/schema';
import type { BlockIndexEntry, DocId } from '../db/types';
import { deleteBlock, insertBlock, updateBlock } from '../core/events';
import { HeightCache } from './measure';
import { caretOffsetFromPoint } from './caret';
import { BlockRow } from './BlockRow';
import { BlockEditor } from './BlockEditor';

/** Blocks rendered beyond the viewport on each side. */
const OVERSCAN = 6;
/** Text is fetched for the visible range plus this margin. */
const TEXT_MARGIN = 24;

export interface DocumentViewProps {
  db: EzhuthuDB;
  docId: DocId;
  onChange?: () => void;
}

interface FocusTarget {
  blockId: string;
  caret: number;
}

export function DocumentView({ db, docId, onChange }: DocumentViewProps) {
  const [index, setIndex] = useState<BlockIndexEntry[]>([]);
  const [texts, setTexts] = useState<Map<string, string>>(new Map());
  const [focus, setFocus] = useState<FocusTarget | null>(null);
  const [loading, setLoading] = useState(true);

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

  if (loading) {
    return <div className="doc-empty">തുറക്കുന്നു…</div>;
  }

  if (index.length === 0) {
    return <div className="doc-empty">This document is empty. Import a file to begin.</div>;
  }

  return (
    <div className="doc-scroll" ref={scrollRef}>
      <div className="doc-inner" style={{ height: `${total}px` }}>
        {items.map((item) => {
          const entry = index[item.index];
          if (entry === undefined) return null;
          const text = texts.get(entry.blockId);
          const focused = focus?.blockId === entry.blockId;

          return (
            <div
              key={entry.blockId}
              data-index={item.index}
              ref={measureRef}
              className="doc-item"
              style={{ transform: `translateY(${item.start}px)` }}
            >
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
                />
              ) : (
                <BlockRow
                  blockId={entry.blockId}
                  text={text ?? ''}
                  onActivate={activate}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
