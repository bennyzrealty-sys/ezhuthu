/**
 * The batching writer, the collector's geometry, and reading signals back.
 *
 * The guarantee under test is the one docs/SIGNALS.md states first: telemetry
 * never competes with typing. Nothing here writes synchronously, the queue is
 * bounded, and a failed write costs a slightly worse resume suggestion rather
 * than a growing queue or an error reaching the app.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EzhuthuDB } from '@/db/schema';
import { SignalQueue } from '@/signals/queue';
import { SignalCollector, sampleRows } from '@/signals/collector';
import { pruneSignals, rankBlocks, totalsByBlock } from '@/signals/queries';
import { SETTLE_MS, SIGNAL_RETENTION_DAYS } from '@/signals/constants';

const DOC = 'doc-1';
const DAY_MS = 24 * 60 * 60 * 1000;

let db: EzhuthuDB;
let dbCounter = 0;

beforeEach(async () => {
  db = new EzhuthuDB(`ezhuthu-signals-${dbCounter++}`);
  await db.open();
});

afterEach(async () => {
  db.close();
  await db.delete();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

describe('the signal queue', () => {
  it('writes nothing until it is flushed', async () => {
    const queue = new SignalQueue(db, DOC, { flushIntervalMs: 60_000 });
    queue.add('backspace', 'a', 1);

    expect(await db.signals.count()).toBe(0);
    await queue.flush();
    expect(await db.signals.count()).toBe(1);
  });

  it('coalesces by kind and block', async () => {
    // A writer holding Backspace produces one row per flush window, not forty.
    const queue = new SignalQueue(db, DOC, { flushIntervalMs: 60_000, wallClock: () => 1_000 });
    for (let i = 0; i < 40; i++) queue.add('backspace', 'a', 1);
    queue.add('hesitation', 'a', 3_000);
    queue.add('backspace', 'b', 1);
    expect(queue.size).toBe(3);

    await queue.flush();
    const rows = await db.signals.toArray();
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.kind === 'backspace' && r.blockId === 'a')!.value).toBe(40);
    expect(rows.find((r) => r.kind === 'hesitation')!.value).toBe(3_000);
  });

  it('flushes on its own timer', async () => {
    // Only setTimeout. fake-indexeddb drives its own transactions through
    // setImmediate, so faking everything deadlocks the write we are waiting for.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const queue = new SignalQueue(db, DOC, { flushIntervalMs: 2_000 });
    queue.add('dwell', 'a', 4_000);

    await vi.advanceTimersByTimeAsync(2_100);
    expect(await db.signals.count()).toBe(1);
  });

  it('drops past its bound rather than growing', async () => {
    const queue = new SignalQueue(db, DOC, { flushIntervalMs: 60_000, maxEntries: 4 });
    for (let i = 0; i < 10; i++) queue.add('dwell', `b${i}`, 100);

    expect(queue.size).toBe(4);
    expect(queue.dropped).toBe(6);

    // Blocks already queued still coalesce — the bound is on distinct keys.
    queue.add('dwell', 'b0', 100);
    expect(queue.size).toBe(4);
    expect(queue.dropped).toBe(6);
  });

  it('drops a batch whose write fails instead of retrying it', async () => {
    const queue = new SignalQueue(db, DOC, { flushIntervalMs: 60_000 });
    const failing = vi.spyOn(db.signals, 'bulkAdd').mockRejectedValue(new Error('quota'));

    queue.add('dwell', 'a', 100);
    // The promise must resolve: an unhandled rejection from telemetry reaching
    // the app is the failure this is guarding against.
    await expect(queue.flush()).resolves.toBeUndefined();
    expect(queue.size).toBe(0);
    expect(queue.dropped).toBe(1);

    failing.mockRestore();
    queue.add('dwell', 'a', 100);
    await queue.flush();
    expect(await db.signals.count()).toBe(1);
  });

  it('flushes once when stopped, and writes nothing afterwards', async () => {
    const queue = new SignalQueue(db, DOC, { flushIntervalMs: 60_000 });
    queue.add('dwell', 'a', 100);
    await queue.stop();
    expect(await db.signals.count()).toBe(1);

    queue.add('dwell', 'a', 100);
    await queue.flush();
    expect(await db.signals.count()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

function rect(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 360,
    width: 360,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

/** A viewport 1,000px tall holding rows at fixed offsets. jsdom has no layout. */
function makeScroller(rows: Array<[blockId: string, top: number, height: number]>): HTMLElement {
  const scroller = document.createElement('div');
  scroller.getBoundingClientRect = () => rect(0, 1_000);
  Object.defineProperty(scroller, 'scrollTop', { value: 0, writable: true });

  for (const [blockId, top, height] of rows) {
    const row = document.createElement('div');
    row.dataset.blockId = blockId;
    row.getBoundingClientRect = () => rect(top, height);
    scroller.append(row);
  }
  document.body.append(scroller);
  return scroller;
}

describe('sampling what is on screen', () => {
  it('weights rendered rows by their distance from the viewport centre', () => {
    const scroller = makeScroller([
      ['top', 0, 100],
      ['centre', 450, 100],
      ['offscreen', 1_400, 100],
    ]);

    const visible = sampleRows(scroller);
    expect(visible.map((v) => v.blockId)).toEqual(['top', 'centre']);
    expect(visible[1]!.weight).toBe(1);
    expect(visible[0]!.weight).toBeLessThan(0.2);
  });
});

describe('the collector', () => {
  let collector: SignalCollector | null = null;

  afterEach(async () => {
    await collector?.stop();
    collector = null;
    document.body.replaceChildren();
  });

  it('accrues dwell for the block being read and writes it in one batch', async () => {
    const scroller = makeScroller([
      ['top', 0, 100],
      ['centre', 450, 100],
    ]);

    let clock = 0;
    collector = new SignalCollector(db, DOC, scroller, {
      autoStart: false,
      now: () => clock,
      wallClock: () => 1_700_000_000_000,
      flushIntervalMs: 60_000,
    });

    collector.sample();
    for (let i = 0; i < 10; i++) {
      clock += 1_000;
      collector.sample();
    }
    await collector.flush();

    const dwell = await totalsByBlock(db, DOC, 'dwell');
    expect(dwell.get('centre')).toBe(10_000 - SETTLE_MS);
    // On screen but not being read: it accrues, and far less.
    expect(dwell.get('top')!).toBeLessThan(dwell.get('centre')! / 5);
  });

  it('routes keystroke signals through the same queue', async () => {
    const scroller = makeScroller([['a', 450, 100]]);
    let clock = 0;
    collector = new SignalCollector(db, DOC, scroller, {
      autoStart: false,
      now: () => clock,
      flushIntervalMs: 60_000,
    });

    collector.typing.input('a', false);
    clock += 4_000;
    collector.typing.input('a', false);
    collector.typing.keyDown('a', 'Backspace', false);
    // Composing keystrokes reach the collector and must still count for nothing.
    collector.typing.keyDown('a', 'Backspace', true);

    await collector.flush();
    expect((await totalsByBlock(db, DOC, 'hesitation')).get('a')).toBe(4_000);
    expect((await totalsByBlock(db, DOC, 'backspace')).get('a')).toBe(1);
  });

  it('flushes when the document is hidden', async () => {
    const scroller = makeScroller([['a', 450, 100]]);
    let clock = 0;
    let hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });

    collector = new SignalCollector(db, DOC, scroller, {
      autoStart: false,
      now: () => clock,
      flushIntervalMs: 60_000,
    });

    collector.sample();
    clock += 5_000;

    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));

    // Nothing was flushed by a timer — 60s away — so anything in the store got
    // there because hiding wrote it. This is the flush that matters on a phone:
    // it is often the last code to run before the app is frozen.
    await collector.flush();
    expect((await totalsByBlock(db, DOC, 'dwell')).get('a')).toBe(5_000 - SETTLE_MS);
  });
});

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

describe('reading signals back', () => {
  const seed = async (rows: Array<[string, string, number, number, string]>) => {
    await db.signals.bulkAdd(
      rows.map(([blockId, kind, value, ts, sessionId]) => ({
        docId: DOC,
        blockId,
        kind: kind as 'dwell',
        value,
        ts,
        sessionId,
      })),
    );
  };

  it('ranks blocks by a signal, within one session', async () => {
    await seed([
      ['a', 'dwell', 4_000, 10, 'ses-1'],
      ['a', 'dwell', 3_000, 20, 'ses-1'],
      ['b', 'dwell', 9_000, 30, 'ses-0'],
      ['c', 'dwell', 5_000, 40, 'ses-1'],
    ]);

    const ranked = await rankBlocks(db, DOC, 'dwell', { sessionId: 'ses-1' });
    expect(ranked).toEqual([
      { blockId: 'a', value: 7_000 },
      { blockId: 'c', value: 5_000 },
    ]);
  });

  it('ignores other documents', async () => {
    await seed([['a', 'dwell', 4_000, 10, 'ses-1']]);
    await db.signals.add({
      docId: 'other',
      blockId: 'a',
      kind: 'dwell',
      value: 99_000,
      ts: 10,
      sessionId: 'ses-1',
    });

    expect((await totalsByBlock(db, DOC, 'dwell')).get('a')).toBe(4_000);
  });

  it('prunes past the retention window and keeps the rest', async () => {
    const now = 1_800_000_000_000;
    await seed([
      ['old', 'dwell', 1, now - (SIGNAL_RETENTION_DAYS + 1) * DAY_MS, 'ses-0'],
      ['edge', 'dwell', 1, now - (SIGNAL_RETENTION_DAYS - 1) * DAY_MS, 'ses-0'],
      ['fresh', 'dwell', 1, now - 1_000, 'ses-1'],
    ]);

    expect(await pruneSignals(db, { now })).toBe(1);
    expect((await db.signals.toArray()).map((r) => r.blockId).sort()).toEqual(['edge', 'fresh']);
  });
});
