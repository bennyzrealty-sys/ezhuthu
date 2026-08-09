/**
 * The append path and the guarantee it exists to provide: the `blocks`
 * projection is never out of step with the log, and when it is (a crash
 * between the two), that is detectable and repairable (ADR-0008).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EzhuthuDB, rebuildProjection } from '@/db/schema';
import {
  appendEvent,
  createDoc,
  deleteBlock,
  insertBlock,
  moveBlock,
  restoreBlock,
  updateBlock,
} from '@/core/events';
import {
  checkProjection,
  logHeadSeq,
  repairProjection,
  replayFromEmpty,
  replayTo,
} from '@/core/replay';
import { visibleBlocks } from '@/core/fold';
import type { BlockEvent } from '@/db/types';
import { ML_SAMPLES } from './helpers';

let db: EzhuthuDB;
let dbCounter = 0;
const DOC = 'doc-1';

beforeEach(async () => {
  db = new EzhuthuDB(`ezhuthu-test-${dbCounter++}`);
  await db.open();
  await createDoc(db, { docId: DOC, title: 'test', now: 1_000 });
});

afterEach(async () => {
  db.close();
});

async function orderedTexts(): Promise<string[]> {
  const blocks = await db.blocks.where('docId').equals(DOC).sortBy('order');
  return blocks.filter((b) => b.deletedAt === undefined).map((b) => b.text);
}

describe('appendEvent', () => {
  it('writes event, projection and watermark together', async () => {
    const event = await insertBlock(db, DOC, 'ഒന്ന്', undefined, { now: 2_000 });

    expect(await db.events.count()).toBe(1);
    expect(await db.blocks.count()).toBe(1);

    const doc = await db.docs.get(DOC);
    expect(doc!.lastAppliedSeq).toBe(event.seq);
    expect(doc!.seqCounter).toBe(event.seq + 1);
    expect((await checkProjection(db, DOC)).consistent).toBe(true);
  });

  it('allocates seq monotonically without gaps', async () => {
    const seqs: number[] = [];
    for (let i = 0; i < 20; i++) {
      seqs.push((await insertBlock(db, DOC, `block ${i}`)).seq);
    }
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('serialises concurrent appends rather than reusing a seq', async () => {
    // Two tabs on one document are two connections racing to allocate. The
    // counter is bumped inside the transaction, so they queue (ADR-0020).
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => insertBlock(db, DOC, `concurrent ${i}`)),
    );

    const events = await db.events.where('docId').equals(DOC).toArray();
    const seqs = events.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect((await checkProjection(db, DOC)).consistent).toBe(true);
    expect(await db.blocks.count()).toBe(25);
  });

  it('rejects an append to an unknown document', async () => {
    await expect(insertBlock(db, 'nope', 'text')).rejects.toThrow(/unknown document/);
  });
});

describe('editing flows', () => {
  it('inserts in document order', async () => {
    const a = await insertBlock(db, DOC, 'one');
    await insertBlock(db, DOC, 'three');
    await insertBlock(db, DOC, 'two', a.blockId);
    expect(await orderedTexts()).toEqual(['one', 'two', 'three']);
  });

  it('updates only the block it names', async () => {
    const a = await insertBlock(db, DOC, 'one');
    const b = await insertBlock(db, DOC, 'two');
    const before = await db.blocks.get(b.blockId);

    await updateBlock(db, DOC, a.blockId, 'edited');

    expect(await orderedTexts()).toEqual(['edited', 'two']);
    expect(await db.blocks.get(b.blockId)).toEqual(before);
    expect((await db.blocks.get(a.blockId))!.revisionCount).toBe(1);
  });

  it('omits prevText — it is derivable from the log (ADR-0012)', async () => {
    const a = await insertBlock(db, DOC, ML_SAMPLES[0]);
    await updateBlock(db, DOC, a.blockId, ML_SAMPLES[1]);

    const events = await db.events
      .where('[docId+blockId+seq]')
      .between([DOC, a.blockId, 0], [DOC, a.blockId, Infinity])
      .toArray();

    expect(events).toHaveLength(2);
    expect(events[1]!.payload.prevText).toBeUndefined();
    // ...and the previous text really is recoverable from the prior event.
    expect(events[0]!.payload.text).toBe(ML_SAMPLES[0]);
  });

  it('soft-deletes and keeps the text for restore', async () => {
    const a = await insertBlock(db, DOC, 'one');
    const b = await insertBlock(db, DOC, 'two');
    await insertBlock(db, DOC, 'three');

    const event = await deleteBlock(db, DOC, b.blockId);

    expect(await orderedTexts()).toEqual(['one', 'three']);
    expect(event.payload.text).toBe('two'); // delete carries full text
    const ghost = await db.blocks.get(b.blockId);
    expect(ghost!.deletedAt).toBeDefined();
    expect(ghost!.text).toBe('two');
    expect((await db.docs.get(DOC))!.blockCount).toBe(2);
    void a;
  });

  it('restores a deleted block to its original position', async () => {
    await insertBlock(db, DOC, 'one');
    const b = await insertBlock(db, DOC, 'two');
    await insertBlock(db, DOC, 'three');
    await deleteBlock(db, DOC, b.blockId);

    await restoreBlock(db, DOC, b.blockId);

    expect(await orderedTexts()).toEqual(['one', 'two', 'three']);
    expect((await db.docs.get(DOC))!.blockCount).toBe(3);
  });

  it('moves a block without rewriting its neighbours', async () => {
    const a = await insertBlock(db, DOC, 'one');
    const b = await insertBlock(db, DOC, 'two');
    const c = await insertBlock(db, DOC, 'three');
    const neighbourBefore = await db.blocks.get(b.blockId);

    await moveBlock(db, DOC, a.blockId, c.blockId);

    expect(await orderedTexts()).toEqual(['two', 'three', 'one']);
    expect(await db.blocks.get(b.blockId)).toEqual(neighbourBefore);
  });
});

describe('document counters', () => {
  it('tracks word and block counts incrementally', async () => {
    const a = await insertBlock(db, DOC, 'കടൽ ശാന്തമായിരുന്നു.'); // 2 words
    await insertBlock(db, DOC, 'അവൻ ഒരു software engineer ആണ്.'); // 5 words

    let doc = await db.docs.get(DOC);
    expect(doc!.blockCount).toBe(2);
    expect(doc!.wordCount).toBe(7);

    await updateBlock(db, DOC, a.blockId, 'ഒന്ന്'); // 2 → 1 word
    doc = await db.docs.get(DOC);
    expect(doc!.wordCount).toBe(6);

    await deleteBlock(db, DOC, a.blockId);
    doc = await db.docs.get(DOC);
    expect(doc!.blockCount).toBe(1);
    expect(doc!.wordCount).toBe(5);
  });

  it('agrees with a full rebuild from the log', async () => {
    const ids: string[] = [];
    for (const sample of ML_SAMPLES) {
      ids.push((await insertBlock(db, DOC, sample)).blockId);
    }
    await updateBlock(db, DOC, ids[1]!, 'ഒരു വാക്ക്');
    await deleteBlock(db, DOC, ids[3]!);

    const incremental = await db.docs.get(DOC);
    await rebuildProjection(db, DOC);
    const rebuilt = await db.docs.get(DOC);

    expect(rebuilt!.wordCount).toBe(incremental!.wordCount);
    expect(rebuilt!.blockCount).toBe(incremental!.blockCount);
  });
});

describe('projection consistency', () => {
  it('reports consistent after normal editing', async () => {
    for (let i = 0; i < 10; i++) await insertBlock(db, DOC, `block ${i}`);
    expect(await checkProjection(db, DOC)).toMatchObject({ consistent: true });
  });

  it('detects a projection left behind by a crash', async () => {
    const a = await insertBlock(db, DOC, 'one');

    // Simulate a crash landing between the event append and the block write:
    // the event is in the log, the projection never saw it.
    const orphan: BlockEvent = {
      id: 'orphan-1',
      seq: 99,
      ts: 5_000,
      sessionId: 'ses',
      deviceId: 'dev',
      docId: DOC,
      blockId: a.blockId,
      type: 'update',
      payload: { text: 'never applied' },
    };
    await db.events.add(orphan);

    const check = await checkProjection(db, DOC);
    expect(check.consistent).toBe(false);
    expect(check.headSeq).toBe(99);
    expect(check.watermark).toBe(a.seq);
    expect((await db.blocks.get(a.blockId))!.text).toBe('one');
  });

  it('repairs by replaying only the tail', async () => {
    const a = await insertBlock(db, DOC, 'one');
    await db.events.add({
      id: 'orphan-2',
      seq: 50,
      ts: 5_000,
      sessionId: 'ses',
      deviceId: 'dev',
      docId: DOC,
      blockId: a.blockId,
      type: 'update',
      payload: { text: 'recovered' },
    });

    const replayed = await repairProjection(db, DOC);

    expect(replayed).toBe(1);
    expect((await db.blocks.get(a.blockId))!.text).toBe('recovered');
    expect((await checkProjection(db, DOC)).consistent).toBe(true);
    // The counter must not hand out a seq the log already occupies.
    expect((await db.docs.get(DOC))!.seqCounter).toBeGreaterThan(50);
  });

  it('rebuilds the projection to exactly what the log implies', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push((await insertBlock(db, DOC, `b${i}`)).blockId);
    await updateBlock(db, DOC, ids[3]!, 'edited');
    await deleteBlock(db, DOC, ids[7]!);
    await moveBlock(db, DOC, ids[0]!, ids[5]!);

    const before = await orderedTexts();
    await db.blocks.clear(); // nuke the cache entirely
    await rebuildProjection(db, DOC);

    expect(await orderedTexts()).toEqual(before);
    expect((await checkProjection(db, DOC)).consistent).toBe(true);
  });
});

describe('replay', () => {
  it('matches the projection maintained incrementally', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 15; i++) ids.push((await insertBlock(db, DOC, `b${i}`)).blockId);
    await updateBlock(db, DOC, ids[2]!, 'x');
    await deleteBlock(db, DOC, ids[4]!);
    await restoreBlock(db, DOC, ids[4]!);
    await moveBlock(db, DOC, ids[9]!, null);

    const state = await replayFromEmpty(db, DOC);
    const fromReplay = visibleBlocks(state).map((b) => b.text);
    expect(fromReplay).toEqual(await orderedTexts());
  });

  it('reconstructs the document as it was at a past seq', async () => {
    const a = await insertBlock(db, DOC, 'first version');
    const afterInsert = await logHeadSeq(db, DOC);
    await updateBlock(db, DOC, a.blockId, 'second version');
    await updateBlock(db, DOC, a.blockId, 'third version');

    const past = await replayTo(db, DOC, afterInsert);
    expect(visibleBlocks(past).map((b) => b.text)).toEqual(['first version']);

    const now = await replayTo(db, DOC, await logHeadSeq(db, DOC));
    expect(visibleBlocks(now).map((b) => b.text)).toEqual(['third version']);
  });

  it('returns an empty document for seq 0', async () => {
    await insertBlock(db, DOC, 'text');
    const state = await replayTo(db, DOC, 0);
    expect(visibleBlocks(state)).toEqual([]);
  });
});

describe('appendEvent input validation', () => {
  it('rejects an afterBlockId that does not exist', async () => {
    await expect(
      appendEvent(db, {
        docId: DOC,
        blockId: 'new',
        type: 'insert',
        payload: { text: 'x', afterBlockId: 'ghost' },
      }),
    ).rejects.toThrow(/not found/);
  });

  it('leaves nothing behind when an append fails', async () => {
    await insertBlock(db, DOC, 'one');
    const before = {
      events: await db.events.count(),
      blocks: await db.blocks.count(),
      doc: await db.docs.get(DOC),
    };

    await expect(updateBlock(db, DOC, 'no-such-block', 'x')).rejects.toThrow();

    expect(await db.events.count()).toBe(before.events);
    expect(await db.blocks.count()).toBe(before.blocks);
    expect(await db.docs.get(DOC)).toEqual(before.doc);
  });
});
