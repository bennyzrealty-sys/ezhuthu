import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EzhuthuDB } from '@/db/schema';
import { createDoc, deleteBlock, insertBlock, updateBlock } from '@/core/events';
import { maybeWriteSnapshot } from '@/core/snapshots';
import { logHeadSeq, replayTo } from '@/core/replay';
import { allBlocksInOrder } from '@/core/fold';
import { PastDocument } from '@/features/timelapse/materialise';
import { SESSION_GAP_MS } from '@/features/timelapse/constants';

const DOC = 'doc-timelapse';
const T0 = 1_700_000_000_000;

let db: EzhuthuDB;

beforeEach(async () => {
  db = new EzhuthuDB(`timelapse-${Math.random().toString(36).slice(2)}`);
  await db.open();
  await createDoc(db, { docId: DOC, title: 'എഴുത്ത്', now: T0 });
});

afterEach(async () => {
  await db.delete();
});

describe('materialising a past state', () => {
  it('shows the document as it was, not as it is', async () => {
    const first = await insertBlock(db, DOC, 'ആദ്യ രൂപം.', undefined, { now: T0 });
    const afterInsert = await logHeadSeq(db, DOC);
    await updateBlock(db, DOC, first.blockId, 'തിരുത്തിയ രൂപം.', { now: T0 + 1_000 });

    const past = new PastDocument(db, DOC);

    await past.materialise(afterInsert);
    expect(past.window(0, 10).map((b) => b.text)).toEqual(['ആദ്യ രൂപം.']);

    await past.materialise(await logHeadSeq(db, DOC));
    expect(past.window(0, 10).map((b) => b.text)).toEqual(['തിരുത്തിയ രൂപം.']);
  });

  it('puts back a paragraph that has since been deleted', async () => {
    const a = await insertBlock(db, DOC, 'ഒന്നാം ഖണ്ഡിക.', undefined, { now: T0 });
    const b = await insertBlock(db, DOC, 'രണ്ടാം ഖണ്ഡിക.', a.blockId, { now: T0 });
    const both = await logHeadSeq(db, DOC);
    await deleteBlock(db, DOC, b.blockId, { now: T0 + 1_000 });

    const past = new PastDocument(db, DOC);

    await past.materialise(both);
    expect(past.window(0, 10)).toHaveLength(2);

    // ...and does not show it in the present, where it is gone. A ghost marker
    // is a feature of now (ADR-0018); the past is what was on the page.
    await past.materialise(await logHeadSeq(db, DOC));
    expect(past.window(0, 10).map((t) => t.text)).toEqual(['ഒന്നാം ഖണ്ഡിക.']);
  });

  it('counts words and blocks as they stood', async () => {
    await insertBlock(db, DOC, 'അവൻ ഒരു എഴുത്തുകാരൻ ആണ്.', undefined, { now: T0 });
    const one = await logHeadSeq(db, DOC);
    await insertBlock(db, DOC, 'അവൾ ഒരു കവി ആയിരുന്നു.', undefined, { now: T0 + 1_000 });

    const past = new PastDocument(db, DOC);

    expect(await past.materialise(one)).toEqual({ seq: one, blockCount: 1, wordCount: 4 });
    expect((await past.materialise(await logHeadSeq(db, DOC))).blockCount).toBe(2);
  });

  it('reads an empty document at seq 0', async () => {
    await insertBlock(db, DOC, 'ഒന്ന്', undefined, { now: T0 });

    const past = new PastDocument(db, DOC);
    expect(await past.materialise(0)).toMatchObject({ blockCount: 0, wordCount: 0 });
    expect(past.window(0, 10)).toEqual([]);
  });

  it('reaches the same state through a snapshot as without one', async () => {
    // The invariant that makes the ladder safe (ADR-0009): the anchor is an
    // optimisation and must never change the answer.
    for (let i = 0; i < 40; i += 1) {
      await insertBlock(db, DOC, `ഖണ്ഡിക ${i}`, undefined, { now: T0 + i });
    }
    const middle = 20;

    const withoutAnchor = new PastDocument(db, DOC);
    await withoutAnchor.materialise(middle);
    const before = withoutAnchor.window(0, 100);

    await db.snapshots.put({
      docId: DOC,
      seq: middle,
      ts: T0 + middle,
      blocks: allBlocksInOrder(await replayTo(db, DOC, middle)),
    });

    const withAnchor = new PastDocument(db, DOC);
    await withAnchor.materialise(middle);

    expect(withAnchor.window(0, 100)).toEqual(before);
  });

  it('is unaffected by a snapshot written at the head', async () => {
    for (let i = 0; i < 5; i += 1) {
      await insertBlock(db, DOC, `ഖണ്ഡിക ${i}`, undefined, { now: T0 + i });
    }
    await maybeWriteSnapshot(db, DOC, T0);

    const past = new PastDocument(db, DOC);
    await past.materialise(3);
    expect(past.window(0, 100)).toHaveLength(3);
  });
});

describe('windows onto a past state', () => {
  beforeEach(async () => {
    let previous: string | undefined;
    for (let i = 0; i < 30; i += 1) {
      const event = await insertBlock(db, DOC, `ഖണ്ഡിക ${i}`, previous, { now: T0 + i });
      previous = event.blockId;
    }
  });

  it('returns the slice it was asked for, in document order', async () => {
    const past = new PastDocument(db, DOC);
    await past.materialise(await logHeadSeq(db, DOC));

    expect(past.window(5, 3).map((b) => b.text)).toEqual(['ഖണ്ഡിക 5', 'ഖണ്ഡിക 6', 'ഖണ്ഡിക 7']);
  });

  it('clamps rather than throwing past the end', async () => {
    const past = new PastDocument(db, DOC);
    await past.materialise(await logHeadSeq(db, DOC));

    expect(past.window(28, 10)).toHaveLength(2);
    expect(past.window(9_999, 10)).toHaveLength(1);
    expect(past.window(-5, 2).map((b) => b.text)).toEqual(['ഖണ്ഡിക 0', 'ഖണ്ഡിക 1']);
    expect(past.window(0, 0)).toEqual([]);
  });

  it('never hands over the whole document', async () => {
    const past = new PastDocument(db, DOC);
    const summary = await past.materialise(await logHeadSeq(db, DOC));

    // The state is resident in the Worker; what crosses is a window.
    expect(summary.blockCount).toBe(30);
    expect(past.window(0, 10)).toHaveLength(10);
  });
});

describe('the timeline of a real log', () => {
  it('stops where the writer put the document down', async () => {
    const a = await insertBlock(db, DOC, 'ഒന്ന്', undefined, { now: T0 });
    await updateBlock(db, DOC, a.blockId, 'ഒന്നും രണ്ടും', { now: T0 + 1_000 });
    await updateBlock(db, DOC, a.blockId, 'ഒന്നും രണ്ടും മൂന്നും', {
      now: T0 + SESSION_GAP_MS * 3,
    });

    const timeline = await new PastDocument(db, DOC).timeline();

    expect(timeline.sessions).toBe(2);
    expect(timeline.headSeq).toBe(await logHeadSeq(db, DOC));
    expect(timeline.stops.at(-1)!.seq).toBe(timeline.headSeq);
  });

  it('has nothing to show for a document with no events', async () => {
    const timeline = await new PastDocument(db, DOC).timeline();
    expect(timeline.stops).toEqual([]);
  });
});
