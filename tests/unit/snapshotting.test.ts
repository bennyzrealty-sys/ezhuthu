import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EzhuthuDB } from '@/db/schema';
import { createDoc, insertBlock } from '@/core/events';
import { SNAPSHOT_INTERVAL } from '@/core/snapshots';
import { SnapshotScheduler } from '@/features/timelapse/snapshotting';

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

/** Collects the idle work instead of running it, so a test can time it. */
function manualIdle() {
  const queue: Array<() => void> = [];
  return {
    schedule: (work: () => void) => queue.push(work),
    get depth() {
      return queue.length;
    },
    async flush(): Promise<void> {
      const pending = queue.splice(0);
      for (const work of pending) work();
      // The work itself is async; let its transaction settle.
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

describe('scheduling anchors', () => {
  it('asks once however many commits arrive', async () => {
    const idle = manualIdle();
    const scheduler = new SnapshotScheduler(db, DOC, { schedule: idle.schedule, now: () => T0 });

    // A paragraph being typed commits repeatedly. Each commit asks; only one
    // piece of work should be queued.
    for (let i = 0; i < 20; i += 1) scheduler.request();
    expect(idle.depth).toBe(1);

    await idle.flush();
    scheduler.request();
    expect(idle.depth).toBe(1);
  });

  it('writes nothing until the interval has passed', async () => {
    const idle = manualIdle();
    const scheduler = new SnapshotScheduler(db, DOC, { schedule: idle.schedule, now: () => T0 });

    await insertBlock(db, DOC, 'ഒന്നാം ഖണ്ഡിക.', undefined, { now: T0 });
    scheduler.request();
    await idle.flush();

    expect(await db.snapshots.count()).toBe(0);
  });

  it('writes an anchor once the log has moved far enough', async () => {
    const idle = manualIdle();
    const scheduler = new SnapshotScheduler(db, DOC, { schedule: idle.schedule, now: () => T0 });

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

    scheduler.request();
    await idle.flush();

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
    const idle = manualIdle();
    const scheduler = new SnapshotScheduler(db, DOC, { schedule: idle.schedule, now: () => T0 });

    scheduler.request();
    scheduler.stop();
    await idle.flush();
    scheduler.request();

    expect(idle.depth).toBe(0);
    expect(await db.snapshots.count()).toBe(0);
  });

  it('swallows a failure rather than surfacing it to the writer', async () => {
    const idle = manualIdle();
    // No such document: maybeWriteSnapshot will throw inside the idle callback,
    // where nothing is waiting to catch it.
    const scheduler = new SnapshotScheduler(db, 'no-such-doc', {
      schedule: idle.schedule,
      now: () => T0,
    });

    scheduler.request();
    await expect(idle.flush()).resolves.toBeUndefined();
  });
});
