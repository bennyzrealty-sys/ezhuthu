import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EzhuthuDB } from '@/db/schema';
import { createDoc, insertBlock } from '@/core/events';
import { SNAPSHOT_INTERVAL } from '@/core/snapshots';
import { QUIET_AFTER_COMMIT_MS, SnapshotScheduler } from '@/features/timelapse/snapshotting';

const DOC = 'doc-anchors';
const T0 = 1_700_000_000_000;

let db: EzhuthuDB;

beforeEach(async () => {
  db = new EzhuthuDB(`anchors-${Math.random().toString(36).slice(2)}`);
  await db.open();
  await createDoc(db, { docId: DOC, title: 'എഴുത്ത്', now: T0 });
});

afterEach(async () => {
  await db.delete();
});

/**
 * Drives both gates by hand: the quiet period the writer has to leave, and the
 * idle slot the work then takes. Injected rather than faked with timers,
 * because vi.useFakeTimers() with its default toFake deadlocks anything that
 * waits on a Dexie write (see HANDOFF).
 */
function manualClock() {
  let waiting: { ms: number; work: () => void } | null = null;
  const idleQueue: Array<() => void> = [];

  return {
    delay: (ms: number, work: () => void) => {
      waiting = { ms, work };
      return () => {
        waiting = null;
      };
    },
    schedule: (work: () => void) => idleQueue.push(work),
    /** How long the pending attempt is waiting for, or null if none is. */
    get waitingMs(): number | null {
      return waiting?.ms ?? null;
    },
    get idleDepth(): number {
      return idleQueue.length;
    },
    /** The writer stops typing for long enough. */
    quiet(): void {
      const pending = waiting;
      waiting = null;
      pending?.work();
    },
    async flush(): Promise<void> {
      const pending = idleQueue.splice(0);
      for (const work of pending) work();
      // The work itself is async; let its transaction settle.
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

describe('scheduling anchors', () => {
  const scheduler = (docId = DOC) => {
    const clock = manualClock();
    return {
      clock,
      it: new SnapshotScheduler(db, docId, {
        schedule: clock.schedule,
        delay: clock.delay,
        now: () => T0,
      }),
    };
  };

  it('attempts nothing while the writer is still typing', async () => {
    const { clock, it: anchors } = scheduler();

    /*
     * The gap between two keystrokes IS idle, so idle alone is not a quiet
     * period. This is what the perf suite measured: without the debounce the
     * keystroke handler went from 0.95 ms median to 1.13-1.21 ms on the same
     * machine, because a commit mid-burst found a snapshot due and
     * requestIdleCallback handed it the space before the next keystroke.
     */
    for (let i = 0; i < 20; i += 1) anchors.request();

    expect(clock.waitingMs).toBe(QUIET_AFTER_COMMIT_MS);
    expect(clock.idleDepth).toBe(0);
  });

  it('asks for one piece of idle work once the writer stops', async () => {
    const { clock, it: anchors } = scheduler();

    for (let i = 0; i < 20; i += 1) anchors.request();
    clock.quiet();

    expect(clock.idleDepth).toBe(1);
  });

  it('writes nothing until the interval has passed', async () => {
    const { clock, it: anchors } = scheduler();

    await insertBlock(db, DOC, 'ഒന്നാം ഖണ്ഡിക.', undefined, { now: T0 });
    anchors.request();
    clock.quiet();
    await clock.flush();

    expect(await db.snapshots.count()).toBe(0);
  });

  it('writes an anchor once the log has moved far enough', async () => {
    const { clock, it: anchors } = scheduler();

    // Straight into the log: this test is about the scheduler, and appending
    // five hundred blocks one transaction at a time is a minute of nothing.
    await db.events.bulkAdd(
      Array.from({ length: SNAPSHOT_INTERVAL }, (_, i) => ({
        id: `seed-${i}`,
        seq: i + 1,
        ts: T0 + i,
        sessionId: 'seed',
        deviceId: 'seed',
        docId: DOC,
        blockId: `block-${i}`,
        type: 'insert' as const,
        payload: { text: `ഖണ്ഡിക ${i}` },
      })),
    );

    anchors.request();
    clock.quiet();
    await clock.flush();

    /*
     * Waited for, not read once. The idle callback starts the write and does
     * not return it, so a single read here races a replay of five hundred
     * events and fails only on a machine slow enough to lose — which is the
     * shape of every flake this project has had (see HANDOFF).
     */
    const snapshot = await vi.waitFor(async () => {
      const written = await db.snapshots.get([DOC, SNAPSHOT_INTERVAL]);
      expect(written).toBeDefined();
      return written!;
    });
    expect(snapshot.blocks).toHaveLength(SNAPSHOT_INTERVAL);
  });

  it('runs nothing after it has been stopped', async () => {
    const { clock, it: anchors } = scheduler();

    anchors.request();
    anchors.stop();
    clock.quiet();
    await clock.flush();
    anchors.request();

    expect(clock.waitingMs).toBeNull();
    expect(clock.idleDepth).toBe(0);
    expect(await db.snapshots.count()).toBe(0);
  });

  it('swallows a failure rather than surfacing it to the writer', async () => {
    const { clock, it: anchors } = scheduler('no-such-doc');

    anchors.request();
    clock.quiet();
    await expect(clock.flush()).resolves.toBeUndefined();
  });
});
