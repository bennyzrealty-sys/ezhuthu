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
import { deleteBlock, insertBlock, restoreBlock, updateBlock } from '../core/events';
import { uuid } from '../db/ids';
import { HeightCache } from './measure';
import { caretOffsetFromPoint } from './caret';
import { BlockRow } from './BlockRow';
import { BlockEditor, type BlockEditorHandle } from './BlockEditor';
import { MarginBar } from './MarginBar';
import { Minimap } from './Minimap';
import { Seam } from './Seam';
import { markIntensity } from '../features/visibility/intensity';
import { computeSeams, type Seams } from '../features/visibility/seams';
import {
  DEFAULT_FEEDBACK,
  EditedRegionPulse,
  haptic,
  VISUAL_PULSE_MS,
  type FeedbackSettings,
} from '../features/visibility/feedback';
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
  /**
   * Commit whatever is in the focused editor, and report it.
   *
   * Everything outside this component reads the `blocks` projection, and the
   * paragraph being typed into is not in it: the editor holds the draft in a
   * ref for `IDLE_COMMIT_MS` so that typing costs no render. Any command that
   * reads the whole document — Download, Back up, Export corpus — therefore
   * sees the text as it was up to 400ms ago unless it asks first. When the
   * commit had not happened at all (a paragraph begun and downloaded inside
   * the same second) what it sees is an EMPTY paragraph, which is how a
   * download of freshly written work arrived empty.
   *
   * Returns the draft even when it could not be committed, which happens only
   * mid-composition (rule 6): a file must still contain what is on screen.
   * Resolves to `null` when nothing is focused.
   */
  flushPendingEdit: () => Promise<{ blockId: string; text: string } | null>;
  /**
   * Re-read the document from the store.
   *
   * For changes this view did not make — undo is the one that exists (ADR-0033).
   * The index and the text window are this component's state, so a change
   * appended from the toolbar is invisible here until they are re-read. Cheaper
   * and far less disruptive than remounting, which is what import does: this
   * keeps the scroll position, and the reader is looking at the paragraph that
   * just changed back.
   */
  reload: () => void;
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
  /** Scroll-past feedback (ADR-0022). Off by default. */
  feedback?: FeedbackSettings;
  ref?: RefObject<DocumentViewHandle | null>;
}

interface FocusTarget {
  blockId: string;
  caret: number;
}

export function DocumentView({
  db,
  docId,
  onChange,
  now,
  feedback = DEFAULT_FEEDBACK,
  ref,
}: DocumentViewProps) {
  const [index, setIndex] = useState<BlockIndexEntry[]>([]);
  const [seams, setSeams] = useState<Seams>({ before: new Map(), trailing: [] });
  const [texts, setTexts] = useState<Map<string, string>>(new Map());
  const [focus, setFocus] = useState<FocusTarget | null>(null);
  /**
   * The focused editor, for the one thing that has to reach into it: taking
   * the draft it is holding before something reads the document as a whole.
   */
  const editor = useRef<BlockEditorHandle | null>(null);
  const [loading, setLoading] = useState(true);
  const [highlight, setHighlight] = useState<RevealTarget | null>(null);
  const [signals, setSignals] = useState<SignalCollector | null>(null);
  /** The block whose margin bar is mid visual-pulse (ADR-0022). */
  const [pulseId, setPulseId] = useState<string | null>(null);

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

    // Seams need the deleted blocks the live index drops — computed from the
    // same ordered read so a deletion never costs a second query (ADR-0018).
    setSeams(
      computeSeams(
        blocks.map((b) => ({
          blockId: b.blockId,
          deleted: b.deletedAt !== undefined,
          merged: b.meta?.mergedInto !== undefined,
          length: b.text.length,
        })),
      ),
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
  // Scroll-past feedback (ADR-0022)
  // -------------------------------------------------------------------------

  /*
   * A haptic tick and/or a visual pulse as an edited region crosses the centre.
   * Read through refs so the passive scroll listener is installed once and never
   * re-subscribes on an index or setting change.
   *
   * The centre block is found from the virtualiser's offsets — content-relative,
   * like scrollTop — so this forces no layout on the scroll path, and the whole
   * body is skipped when neither feedback is on. The pulse decision and the
   * throttle live in EditedRegionPulse (ADR-0022: ≤ 1 per 300 ms).
   */
  const feedbackRef = useRef(feedback);
  feedbackRef.current = feedback;
  const indexRef = useRef(index);
  indexRef.current = index;
  const clockRef = useRef<() => number>(now ?? Date.now);
  clockRef.current = now ?? Date.now;
  const regionPulse = useRef(new EditedRegionPulse());
  const pulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;

    let lastProcessed = 0;
    const onScroll = (): void => {
      const settings = feedbackRef.current;
      if (!settings.haptics && !settings.visualPulse) return;

      const at = clockRef.current();
      // Coarser than a frame: crossing a paragraph does not need 60 Hz.
      if (at - lastProcessed < 100) return;
      lastProcessed = at;

      const centre = element.scrollTop + element.clientHeight / 2;
      const item = virtualizer
        .getVirtualItems()
        .find((it) => centre >= it.start && centre < it.start + it.size);
      const entry = item === undefined ? undefined : indexRef.current[item.index];
      const edited =
        entry !== undefined && markIntensity(entry, at) !== null ? entry.blockId : undefined;

      if (!regionPulse.current.shouldPulse(edited, at)) return;

      if (settings.haptics) haptic();
      if (settings.visualPulse && edited !== undefined) {
        setPulseId(edited);
        if (pulseTimer.current !== null) clearTimeout(pulseTimer.current);
        pulseTimer.current = setTimeout(() => setPulseId(null), VISUAL_PULSE_MS);
      }
    };

    element.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      element.removeEventListener('scroll', onScroll);
      if (pulseTimer.current !== null) clearTimeout(pulseTimer.current);
    };
  }, [virtualizer, ready]);

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
      // One action, two events: a shared id is what lets undo take the split
      // back in a single press rather than two (ADR-0033).
      const groupId = uuid();
      await updateBlock(db, docId, blockId, before, { groupId });
      const event = await insertBlock(db, docId, after, blockId, { groupId });

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

  /**
   * Add a paragraph at the end and put the caret in it.
   *
   * This is how writing *starts*. The editor opens by tapping an existing
   * paragraph (BlockRow), which a fresh install does not have — so before this
   * existed, an empty document could only be filled by importing a file, and
   * the answer to "let me write something" was that there was nowhere to put
   * it. Found on a real phone, five minutes after the first install.
   *
   * An already-empty last paragraph is focused rather than followed by a
   * second one. Two taps on the affordance are one intention, and the log is
   * permanent (rule 1): a paragraph the writer never typed in should not be an
   * event, let alone two.
   */
  const appendParagraph = useCallback(async () => {
    const last = index[index.length - 1];
    if (last !== undefined && last.length === 0) {
      setFocus({ blockId: last.blockId, caret: 0 });
      return;
    }

    // No `afterBlockId` — append at the end (core/events.ts). The order key it
    // is given sorts after every existing one, so appending to the index here
    // agrees with what a reload would produce.
    const event = await insertBlock(db, docId, '');
    const created = await db.blocks.get(event.blockId);
    if (created === undefined) return;

    setTexts((previous) => new Map(previous).set(created.blockId, ''));
    setIndex((previous) => [
      ...previous,
      {
        blockId: created.blockId,
        order: created.order,
        updatedAt: created.updatedAt,
        revisionCount: 0,
        length: 0,
        deleted: false,
      },
    ]);
    setFocus({ blockId: created.blockId, caret: 0 });
    onChange?.();
  }, [db, docId, index, onChange]);

  const mergeBack = useCallback(
    async (blockId: string, text: string) => {
      const at = index.findIndex((e) => e.blockId === blockId);
      const previousEntry = index[at - 1];
      if (previousEntry === undefined) return; // first block: nothing to merge into

      const previousBlock = await db.blocks.get(previousEntry.blockId);
      if (previousBlock === undefined) return;

      const joined = previousBlock.text + text;
      const groupId = uuid();
      await updateBlock(db, docId, previousEntry.blockId, joined, { groupId });
      // A merge, not a deletion: the text is now in the previous block, so this
      // leaves no ghost (ADR-0028).
      await deleteBlock(db, docId, blockId, { mergedInto: previousEntry.blockId, groupId });

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
      async flushPendingEdit() {
        const pending = editor.current?.flush();
        if (pending === undefined) return null;
        // Composition is the one case a commit is refused (rule 6, ADR-0010).
        // The draft is still returned, so a file written now shows what the
        // writer can see; the IME's own compositionend reschedules the commit.
        if (!pending.composing) await commit(pending.blockId, pending.text);
        return { blockId: pending.blockId, text: pending.text };
      },
      reload() {
        // Drop the cached text as well as the index: undo changes the words in
        // a block the window is already holding, and a stale entry there would
        // show the reader the text they just took back.
        setTexts(new Map());
        setFocus(null);
        void loadIndex();
      },
    }),
    [index, virtualizer, loadIndex, commit],
  );

  /*
   * Commit the draft when the app goes away.
   *
   * The editor holds up to `IDLE_COMMIT_MS` of typing in a ref so that a
   * keystroke costs no render (BlockEditor rule 1). On a phone that window is
   * where work is lost: a writer types a line and swipes the app away, and the
   * process is frozen — or discarded outright — before the timer runs. There is
   * no unload event that can be relied on to write asynchronously, but
   * `visibilitychange` fires BEFORE the freeze on every platform this app
   * targets, which is why the signals queue already flushes there
   * (signals/collector.ts). Telemetry about the writing had this and the
   * writing itself did not.
   *
   * `pagehide` as well, for the one case visibility does not cover: a
   * navigation away from a still-visible page.
   *
   * A composing IME is left alone (rule 6). Nothing else here can refuse.
   */
  useEffect(() => {
    const flush = () => {
      const pending = editor.current?.flush();
      if (pending === undefined || pending.composing) return;
      void commit(pending.blockId, pending.text);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
    };
  }, [commit]);

  const reportHeight = useCallback((blockId: string, height: number) => {
    heights.current.set(blockId, width.current, height);
  }, []);

  // -------------------------------------------------------------------------
  // Deletion and ghost markers (ADR-0018)
  // -------------------------------------------------------------------------

  /**
   * A deliberate deletion of the focused block. This is the one that leaves a
   * ghost — no `mergedInto`, so its text is genuinely gone from the document
   * and the seam is how it is found again. The index and seams are recomputed
   * from the log rather than patched, because a deletion changes which live
   * block a seam attaches to, which is exactly what `computeSeams` decides.
   */
  const removeBlock = useCallback(
    async (blockId: string) => {
      setFocus((current) => (current?.blockId === blockId ? null : current));
      await deleteBlock(db, docId, blockId);
      await loadIndex();
      onChange?.();
    },
    [db, docId, loadIndex, onChange],
  );

  const restoreGhost = useCallback(
    async (blockId: string) => {
      // No `afterBlockId`: the block kept its order key through the soft delete,
      // so it returns to the seam it left (ADR-0018 restore-in-place).
      await restoreBlock(db, docId, blockId);
      await loadIndex();
      onChange?.();
    },
    [db, docId, loadIndex, onChange],
  );

  const getGhostText = useCallback(
    async (blockId: string) => (await db.blocks.get(blockId))?.text ?? '',
    [db],
  );

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
    return (
      <div className="doc-empty">
        <p>This document is empty.</p>
        <button
          type="button"
          className="primary"
          data-testid="start-writing"
          onClick={() => void appendParagraph()}
        >
          Start writing
        </button>
        <p className="note">…or Import to bring in a .txt or .md file.</p>
      </div>
    );
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
            const seamBefore = seams.before.get(entry.blockId);
            const isLast = item.index === index.length - 1;

            return (
              <div
                key={entry.blockId}
                data-index={item.index}
                ref={measureRef}
                className="doc-item"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                {seamBefore !== undefined && (
                  <Seam ghosts={seamBefore} getText={getGhostText} onRestore={restoreGhost} />
                )}
                <div className="doc-block">
                  {intensity !== null && (
                    <MarginBar
                      blockId={entry.blockId}
                      intensity={intensity}
                      pulsing={pulseId === entry.blockId}
                    />
                  )}
                  {focused ? (
                    <>
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
                        handleRef={editor}
                      />
                      <button
                        type="button"
                        className="block-delete"
                        data-testid="block-delete"
                        aria-label="Delete this paragraph"
                        // Mouse down, not click: a click would blur the editor
                        // first, committing and clearing focus before this ran.
                        onMouseDown={(e) => {
                          e.preventDefault();
                          void removeBlock(entry.blockId);
                        }}
                      >
                        Delete
                      </button>
                    </>
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
                {isLast && seams.trailing.length > 0 && (
                  <Seam ghosts={seams.trailing} getText={getGhostText} onRestore={restoreGhost} />
                )}
              </div>
            );
          })}
        </div>
        {/*
         * A place to write at the end of the document, outside the virtualised
         * container so it is not an item and cannot confuse the height math.
         * Enter at the end of the last paragraph does the same thing, but that
         * needs a caret placed exactly at the end of a paragraph on a phone —
         * fine as the writing gesture, useless as the way back in after a
         * reload.
         *
         * A click here blurs any focused editor first, which commits it. That
         * ordering is wanted: the paragraph being left is saved before the new
         * one arrives.
         */}
        <button
          type="button"
          className="doc-append"
          data-testid="append-paragraph"
          onClick={() => void appendParagraph()}
        >
          + New paragraph
        </button>
      </div>
      <Minimap blocks={index} onJump={jumpToIndex} now={now} />
    </div>
  );
}
