/**
 * Fold correctness. Everything downstream rests on this file.
 *
 * The property that matters most is equivalence: folding a log one event at a
 * time (the append path) and folding it in one batch (the replay path) must
 * produce identical state. If that ever fails, the `blocks` projection can
 * drift from the log and nothing the app displays is trustworthy.
 */

import { describe, expect, it } from 'vitest';
import {
  allBlocksInOrder,
  applyEvent,
  cloneState,
  emptyState,
  foldEvents,
  visibleBlocks,
} from '@/core/fold';
import type { BlockEvent, DocState } from '@/db/types';
import { eventFactory, makeRng, ML_SAMPLES } from './helpers';

function texts(state: DocState): string[] {
  return visibleBlocks(state).map((b) => b.text);
}

/** Comparable, order-sensitive shape of a state — for equality assertions. */
function shape(state: DocState) {
  return {
    seq: state.seq,
    order: state.order,
    blocks: allBlocksInOrder(state).map((b) => ({
      blockId: b.blockId,
      order: b.order,
      text: b.text,
      revisionCount: b.revisionCount,
      deletedAt: b.deletedAt,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
    })),
  };
}

describe('insert', () => {
  it('appends when afterBlockId is undefined', () => {
    const f = eventFactory();
    const s = foldEvents(emptyState('doc-1'), [
      f.make('insert', 'a', { text: 'one' }),
      f.make('insert', 'b', { text: 'two' }),
      f.make('insert', 'c', { text: 'three' }),
    ]);
    expect(texts(s)).toEqual(['one', 'two', 'three']);
  });

  it('places at the front when afterBlockId is null', () => {
    const f = eventFactory();
    const s = foldEvents(emptyState('doc-1'), [
      f.make('insert', 'a', { text: 'one' }),
      f.make('insert', 'b', { text: 'zero', afterBlockId: null }),
    ]);
    expect(texts(s)).toEqual(['zero', 'one']);
  });

  it('places between two blocks without touching either', () => {
    const f = eventFactory();
    const s = foldEvents(emptyState('doc-1'), [
      f.make('insert', 'a', { text: 'one' }),
      f.make('insert', 'c', { text: 'three' }),
    ]);
    const orderBefore = { a: s.blocks.get('a')!.order, c: s.blocks.get('c')!.order };

    applyEvent(s, f.make('insert', 'b', { text: 'two', afterBlockId: 'a' }));

    expect(texts(s)).toEqual(['one', 'two', 'three']);
    // The whole point of fractional indexing (ADR-0007): neighbours untouched.
    expect(s.blocks.get('a')!.order).toBe(orderBefore.a);
    expect(s.blocks.get('c')!.order).toBe(orderBefore.c);
  });

  it('survives many sequential inserts at the same position', () => {
    // Float midpoints exhaust f64 precision after ~50 of these and silently
    // collide. This is the regression that ADR-0007 exists to prevent, and it
    // is an ordinary afternoon of writing, not an edge case.
    const f = eventFactory();
    const s = foldEvents(emptyState('doc-1'), [
      f.make('insert', 'first', { text: 'first' }),
      f.make('insert', 'last', { text: 'last' }),
    ]);

    for (let i = 0; i < 500; i++) {
      applyEvent(s, f.make('insert', `mid-${i}`, { text: `mid-${i}`, afterBlockId: 'first' }));
    }

    const keys = allBlocksInOrder(s).map((b) => b.order);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual(keys);
    expect(visibleBlocks(s)).toHaveLength(502);
    expect(texts(s)[0]).toBe('first');
    expect(texts(s).at(-1)).toBe('last');
    // Newest-first, because each was inserted directly after `first`.
    expect(texts(s)[1]).toBe('mid-499');
  });

  it('rejects a duplicate insert for a live block', () => {
    const f = eventFactory();
    const s = foldEvents(emptyState('doc-1'), [f.make('insert', 'a', { text: 'one' })]);
    expect(() => applyEvent(s, f.make('insert', 'a', { text: 'again' }))).toThrow(/duplicate/);
  });

  it('rejects an afterBlockId that is not in the document', () => {
    const f = eventFactory();
    const s = emptyState('doc-1');
    expect(() =>
      applyEvent(s, f.make('insert', 'a', { text: 'x', afterBlockId: 'ghost' })),
    ).toThrow(/corrupt log/);
  });
});

describe('update', () => {
  it('replaces text and increments revisionCount', () => {
    const f = eventFactory();
    const s = foldEvents(emptyState('doc-1'), [
      f.make('insert', 'a', { text: ML_SAMPLES[0] }),
      f.make('update', 'a', { text: ML_SAMPLES[1] }),
      f.make('update', 'a', { text: ML_SAMPLES[2] }),
    ]);
    const block = s.blocks.get('a')!;
    expect(block.text).toBe(ML_SAMPLES[2]);
    expect(block.revisionCount).toBe(2);
    expect(block.updatedAt).toBeGreaterThan(block.createdAt);
  });

  it('does not move the block', () => {
    const f = eventFactory();
    const s = foldEvents(emptyState('doc-1'), [
      f.make('insert', 'a', { text: 'one' }),
      f.make('insert', 'b', { text: 'two' }),
    ]);
    const orderBefore = s.blocks.get('a')!.order;
    applyEvent(s, f.make('update', 'a', { text: 'edited' }));
    expect(s.blocks.get('a')!.order).toBe(orderBefore);
    expect(texts(s)).toEqual(['edited', 'two']);
  });

  it('rejects an update to an unknown block', () => {
    const f = eventFactory();
    expect(() => applyEvent(emptyState('doc-1'), f.make('update', 'nope', { text: 'x' }))).toThrow(
      /corrupt log/,
    );
  });
});

describe('delete and restore', () => {
  it('soft-deletes: record, text and position all survive', () => {
    const f = eventFactory();
    const s = foldEvents(emptyState('doc-1'), [
      f.make('insert', 'a', { text: 'one' }),
      f.make('insert', 'b', { text: 'two' }),
      f.make('insert', 'c', { text: 'three' }),
    ]);
    const orderBefore = s.blocks.get('b')!.order;

    applyEvent(s, f.make('delete', 'b', { text: 'two' }));

    expect(texts(s)).toEqual(['one', 'three']);
    const ghost = s.blocks.get('b')!;
    expect(ghost.deletedAt).toBeDefined();
    expect(ghost.text).toBe('two'); // still recoverable (ADR-0018)
    expect(ghost.order).toBe(orderBefore);
    expect(allBlocksInOrder(s)).toHaveLength(3);
  });

  it('restores in place when no position is given', () => {
    const f = eventFactory();
    const s = foldEvents(emptyState('doc-1'), [
      f.make('insert', 'a', { text: 'one' }),
      f.make('insert', 'b', { text: 'two' }),
      f.make('insert', 'c', { text: 'three' }),
      f.make('delete', 'b', { text: 'two' }),
    ]);
    applyEvent(s, f.make('insert', 'b', {}));
    expect(texts(s)).toEqual(['one', 'two', 'three']);
    expect(s.blocks.get('b')!.deletedAt).toBeUndefined();
  });

  it('restores to an explicit position when one is given', () => {
    const f = eventFactory();
    const s = foldEvents(emptyState('doc-1'), [
      f.make('insert', 'a', { text: 'one' }),
      f.make('insert', 'b', { text: 'two' }),
      f.make('insert', 'c', { text: 'three' }),
      f.make('delete', 'b', { text: 'two' }),
    ]);
    applyEvent(s, f.make('insert', 'b', { afterBlockId: 'c' }));
    expect(texts(s)).toEqual(['one', 'three', 'two']);
  });

  it('records a merge on the deleted block so it leaves no ghost (ADR-0028)', () => {
    const f = eventFactory();
    const s = foldEvents(emptyState('doc-1'), [
      f.make('insert', 'a', { text: 'one' }),
      f.make('insert', 'b', { text: 'two' }),
    ]);
    // A deliberate delete carries no mergedInto; a merge names the neighbour.
    applyEvent(s, f.make('delete', 'b', { text: 'two', mergedInto: 'a' }));
    expect(s.blocks.get('b')!.meta.mergedInto).toBe('a');
  });

  it('a deliberate delete carries no merge marker', () => {
    const f = eventFactory();
    const s = foldEvents(emptyState('doc-1'), [
      f.make('insert', 'a', { text: 'one' }),
      f.make('insert', 'b', { text: 'two' }),
    ]);
    applyEvent(s, f.make('delete', 'b', { text: 'two' }));
    expect(s.blocks.get('b')!.meta.mergedInto).toBeUndefined();
  });
});

describe('move', () => {
  it('repositions without changing text or revision count', () => {
    const f = eventFactory();
    const s = foldEvents(emptyState('doc-1'), [
      f.make('insert', 'a', { text: 'one' }),
      f.make('insert', 'b', { text: 'two' }),
      f.make('insert', 'c', { text: 'three' }),
    ]);
    applyEvent(s, f.make('move', 'a', { afterBlockId: 'c' }));
    expect(texts(s)).toEqual(['two', 'three', 'one']);
    expect(s.blocks.get('a')!.revisionCount).toBe(0);
  });

  it('moves to the front', () => {
    const f = eventFactory();
    const s = foldEvents(emptyState('doc-1'), [
      f.make('insert', 'a', { text: 'one' }),
      f.make('insert', 'b', { text: 'two' }),
      f.make('insert', 'c', { text: 'three' }),
    ]);
    applyEvent(s, f.make('move', 'c', { afterBlockId: null }));
    expect(texts(s)).toEqual(['three', 'one', 'two']);
  });
});

describe('order index integrity', () => {
  it('keeps state.order sorted by Block.order after every event', () => {
    const f = eventFactory();
    const s = emptyState('doc-1');
    const events = [
      f.make('insert', 'a', { text: '1' }),
      f.make('insert', 'b', { text: '2' }),
      f.make('insert', 'c', { text: '3', afterBlockId: 'a' }),
      f.make('insert', 'd', { text: '4', afterBlockId: null }),
      f.make('move', 'a', { afterBlockId: 'b' }),
      f.make('delete', 'c', { text: '3' }),
      f.make('insert', 'c', {}),
      f.make('move', 'd', { afterBlockId: 'b' }),
    ];

    for (const event of events) {
      applyEvent(s, event);
      const keys = s.order.map((id) => s.blocks.get(id)!.order);
      expect([...keys].sort()).toEqual(keys);
      expect(new Set(s.order).size).toBe(s.order.length);
      expect(s.order.length).toBe(s.blocks.size);
    }
  });
});

// ---------------------------------------------------------------------------
// The property that everything else depends on
// ---------------------------------------------------------------------------

/** A random but always-valid event sequence. */
function randomLog(seed: number, count: number): BlockEvent[] {
  const rng = makeRng(seed);
  const f = eventFactory();
  const events: BlockEvent[] = [];
  const live: string[] = [];
  const deleted: string[] = [];
  let nextId = 0;

  const pick = (arr: string[]): string => arr[Math.floor(rng() * arr.length)]!;

  while (events.length < count) {
    const roll = rng();

    if (live.length === 0 || roll < 0.35) {
      const id = `b${nextId++}`;
      const where = live.length === 0 || rng() < 0.4 ? undefined : rng() < 0.2 ? null : pick(live);
      events.push(f.make('insert', id, { text: ML_SAMPLES[nextId % ML_SAMPLES.length]!, afterBlockId: where }));
      live.push(id);
    } else if (roll < 0.7) {
      events.push(f.make('update', pick(live), { text: `rev-${events.length}` }));
    } else if (roll < 0.82 && live.length > 1) {
      const id = pick(live);
      events.push(f.make('delete', id, { text: 'gone' }));
      live.splice(live.indexOf(id), 1);
      deleted.push(id);
    } else if (roll < 0.92 && deleted.length > 0) {
      const id = pick(deleted);
      const where = rng() < 0.5 ? undefined : live.length ? pick(live) : null;
      events.push(f.make('insert', id, { afterBlockId: where }));
      deleted.splice(deleted.indexOf(id), 1);
      live.push(id);
    } else if (live.length > 1) {
      const id = pick(live);
      const others = live.filter((x) => x !== id);
      events.push(f.make('move', id, { afterBlockId: rng() < 0.2 ? null : pick(others) }));
    }
  }
  return events;
}

describe('incremental and batch folding are equivalent', () => {
  const seeds = [1, 7, 42, 1337, 99991, 20260809];

  for (const seed of seeds) {
    it(`produces identical state for seed ${seed}`, () => {
      const events = randomLog(seed, 300);

      // Batch: what replay does.
      const batch = foldEvents(emptyState('doc-1'), events);

      // Incremental: what the append path does, one event at a time.
      let incremental = emptyState('doc-1');
      for (const event of events) {
        incremental = applyEvent(incremental, event);
      }

      expect(shape(incremental)).toEqual(shape(batch));
    });
  }

  it('is deterministic across repeated runs of the same log', () => {
    const events = randomLog(4242, 400);
    const a = foldEvents(emptyState('doc-1'), events);
    const b = foldEvents(emptyState('doc-1'), events);
    expect(shape(a)).toEqual(shape(b));
  });

  it('resuming from a mid-log clone matches folding the whole log', () => {
    // This is the repair path: state at the watermark, then replay the tail.
    const events = randomLog(5150, 300);
    const split = 173;

    const full = foldEvents(emptyState('doc-1'), events);

    const partial = foldEvents(emptyState('doc-1'), events.slice(0, split));
    const resumed = foldEvents(cloneState(partial), events.slice(split));

    expect(shape(resumed)).toEqual(shape(full));
  });
});

describe('cloneState', () => {
  it('isolates the clone from later mutation', () => {
    const f = eventFactory();
    const original = foldEvents(emptyState('doc-1'), [f.make('insert', 'a', { text: 'one' })]);
    const copy = cloneState(original);

    applyEvent(original, f.make('update', 'a', { text: 'changed' }));

    expect(copy.blocks.get('a')!.text).toBe('one');
    expect(original.blocks.get('a')!.text).toBe('changed');
  });
});
