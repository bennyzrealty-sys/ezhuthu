import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EzhuthuDB } from '@/db/schema';
import { createDoc, deleteBlock, insertBlock, updateBlock } from '@/core/events';
import { visibleBlocks } from '@/core/fold';
import { replayFromEmpty } from '@/core/replay';
import { canUndo, undoLast } from '@/features/undo/apply';
import { inverseOf, nextUndoable } from '@/features/undo/undo';
import { eventFactory } from './helpers';

const DOC = 'doc-undo';
const T0 = 1_700_000_000_000;
const SESSION = 'ses-1';

let db: EzhuthuDB;
let clock = T0;

beforeEach(async () => {
  db = new EzhuthuDB(`undo-${Math.random().toString(36).slice(2)}`);
  await db.open();
  await createDoc(db, { docId: DOC, title: 'എഴുത്ത്', now: clock });
});

afterEach(async () => {
  await db.delete();
});

/** Live text of the document, straight from a replay of the log. */
async function documentText(): Promise<string[]> {
  return visibleBlocks(await replayFromEmpty(db, DOC)).map((b) => b.text);
}

/** The session every append in these tests carries. */
async function sessionOf(): Promise<string> {
  const first = await db.events.toCollection().first();
  return first!.sessionId;
}

describe('choosing what to undo', () => {
  it('has nothing to undo on an untouched document', () => {
    expect(nextUndoable([], SESSION)).toBeNull();
  });

  it('takes the most recent action of this session', () => {
    const f = eventFactory({ sessionId: SESSION });
    const a = f.make('insert', 'b1', { text: 'ഒന്ന്' });
    const b = f.make('update', 'b1', { text: 'രണ്ട്' });

    expect(nextUndoable([a, b], SESSION)).toEqual([b]);
  });

  it('leaves the work of another session alone', () => {
    // Undo is this launch of the app, not the manuscript's whole history
    // (ADR-0033).
    const mine = eventFactory({ sessionId: SESSION });
    const theirs = eventFactory({ sessionId: 'yesterday' });

    const old = theirs.make('insert', 'b1', { text: 'പഴയത്' });
    const recent = mine.make('update', 'b1', { text: 'പുതിയത്' }, { seq: 50 });

    expect(nextUndoable([old, recent], SESSION)).toEqual([recent]);
    // ...and once that is undone, there is nothing left to reach for.
    const undo = mine.make('update', 'b1', { text: 'പഴയത്' }, { seq: 51, payload: { text: 'പഴയത്', undoOf: recent.id } });
    expect(nextUndoable([old, recent, undo], SESSION)).toBeNull();
  });

  it('never undoes an undo', () => {
    const f = eventFactory({ sessionId: SESSION });
    const edit = f.make('update', 'b1', { text: 'രണ്ട്' });
    const undo = f.make('update', 'b1', { text: 'ഒന്ന്', undoOf: edit.id });

    expect(nextUndoable([edit, undo], SESSION)).toBeNull();
  });

  it('steps back through several actions, one press each', () => {
    const f = eventFactory({ sessionId: SESSION });
    const first = f.make('update', 'b1', { text: 'ഒന്ന്' });
    const second = f.make('update', 'b1', { text: 'രണ്ട്' });
    const third = f.make('update', 'b1', { text: 'മൂന്ന്' });

    const log = [first, second, third];
    expect(nextUndoable(log, SESSION)).toEqual([third]);

    log.push(f.make('update', 'b1', { text: 'രണ്ട്', undoOf: third.id }));
    expect(nextUndoable(log, SESSION)).toEqual([second]);

    log.push(f.make('update', 'b1', { text: 'ഒന്ന്', undoOf: second.id }));
    expect(nextUndoable(log, SESSION)).toEqual([first]);
  });

  it('takes a whole action, not the last event of it', () => {
    // A split is an update plus an insert. One key was pressed; one press must
    // take it back.
    const f = eventFactory({ sessionId: SESSION });
    const before = f.make('update', 'b1', { text: 'ഒന്ന്', groupId: 'split-1' });
    const created = f.make('insert', 'b2', { text: 'രണ്ട്', groupId: 'split-1' });

    expect(nextUndoable([before, created], SESSION)).toEqual([before, created]);
  });
});

describe('reversing one event', () => {
  const f = eventFactory({ sessionId: SESSION });

  it('reverses a creation with a soft delete that keeps the text', () => {
    const insert = f.make('insert', 'b1', { text: 'പുതിയ ഖണ്ഡിക.' });
    const inverse = inverseOf(insert, undefined);

    expect(inverse).toMatchObject({
      type: 'delete',
      blockId: 'b1',
      payload: { text: 'പുതിയ ഖണ്ഡിക.', undoOf: insert.id },
    });
  });

  it('reverses an edit back to the text before it', () => {
    const update = f.make('update', 'b1', { text: 'തിരുത്തിയത്' });
    expect(inverseOf(update, 'ആദ്യത്തേത്')).toMatchObject({
      type: 'update',
      payload: { text: 'ആദ്യത്തേത്', undoOf: update.id },
    });
  });

  it('refuses an edit whose earlier text the log does not hold', () => {
    // Better to do nothing than to write an empty paragraph over the work.
    const update = f.make('update', 'b1', { text: 'തിരുത്തിയത്' });
    expect(inverseOf(update, undefined)).toBeNull();
  });

  it('reverses a deletion by restoring in place', () => {
    const remove = f.make('delete', 'b1', { text: 'നീക്കിയത്' });
    expect(inverseOf(remove, 'നീക്കിയത്')).toMatchObject({
      type: 'insert',
      // No afterBlockId: back where it was, not appended at the end (ADR-0018).
      payload: { undoOf: remove.id },
    });
    expect(inverseOf(remove, 'നീക്കിയത്')!.payload.afterBlockId).toBeUndefined();
  });

  it('refuses a move, which does not record where it came from', () => {
    expect(inverseOf(f.make('move', 'b1', { afterBlockId: null }), 'ഒന്ന്')).toBeNull();
  });
});

describe('undoing against a real log', () => {
  it('puts an edited paragraph back', async () => {
    const block = await insertBlock(db, DOC, 'കടൽ ശാന്തമായിരുന്നു.', undefined, { now: clock });
    await updateBlock(db, DOC, block.blockId, 'കടൽ ഇളകിമറിഞ്ഞു.', { now: clock + 1_000 });
    expect(await documentText()).toEqual(['കടൽ ഇളകിമറിഞ്ഞു.']);

    const outcome = await undoLast(db, DOC, await sessionOf());

    expect(outcome.undone).toBe(1);
    expect(await documentText()).toEqual(['കടൽ ശാന്തമായിരുന്നു.']);
  });

  it('appends rather than rewriting — the log keeps both', async () => {
    // Rule 1, and the reason the scrub and every backup still work afterwards.
    const block = await insertBlock(db, DOC, 'ഒന്ന്', undefined, { now: clock });
    await updateBlock(db, DOC, block.blockId, 'രണ്ട്', { now: clock + 1_000 });
    const before = await db.events.count();

    await undoLast(db, DOC, await sessionOf());

    expect(await db.events.count()).toBe(before + 1);
    const texts = (await db.events.toArray()).map((e) => e.payload.text);
    expect(texts).toContain('രണ്ട്');
  });

  it('steps back through a burst of edits, one press at a time', async () => {
    const block = await insertBlock(db, DOC, 'ഒന്ന്', undefined, { now: clock });
    for (const [i, text] of ['രണ്ട്', 'മൂന്ന്', 'നാല്'].entries()) {
      await updateBlock(db, DOC, block.blockId, text, { now: clock + (i + 1) * 1_000 });
    }
    const session = await sessionOf();

    await undoLast(db, DOC, session);
    expect(await documentText()).toEqual(['മൂന്ന്']);
    await undoLast(db, DOC, session);
    expect(await documentText()).toEqual(['രണ്ട്']);
    await undoLast(db, DOC, session);
    expect(await documentText()).toEqual(['ഒന്ന്']);
  });

  it('brings a deleted paragraph back where it was', async () => {
    const a = await insertBlock(db, DOC, 'ഒന്നാം.', undefined, { now: clock });
    const b = await insertBlock(db, DOC, 'രണ്ടാം.', a.blockId, { now: clock });
    await insertBlock(db, DOC, 'മൂന്നാം.', b.blockId, { now: clock });
    await deleteBlock(db, DOC, b.blockId, { now: clock + 1_000 });
    expect(await documentText()).toEqual(['ഒന്നാം.', 'മൂന്നാം.']);

    await undoLast(db, DOC, await sessionOf());

    // In the middle, not appended at the end.
    expect(await documentText()).toEqual(['ഒന്നാം.', 'രണ്ടാം.', 'മൂന്നാം.']);
  });

  it('takes back a whole split with one press', async () => {
    const block = await insertBlock(db, DOC, 'ഒന്നും രണ്ടും', undefined, { now: clock });
    const group = 'split-1';
    await updateBlock(db, DOC, block.blockId, 'ഒന്നും', { now: clock + 1_000, groupId: group });
    await insertBlock(db, DOC, 'രണ്ടും', block.blockId, { now: clock + 1_000, groupId: group });
    expect(await documentText()).toEqual(['ഒന്നും', 'രണ്ടും']);

    const outcome = await undoLast(db, DOC, await sessionOf());

    expect(outcome.undone).toBe(2);
    expect(await documentText()).toEqual(['ഒന്നും രണ്ടും']);
  });

  it('removes a paragraph that undo created', async () => {
    await insertBlock(db, DOC, 'നിലവിലുള്ളത്', undefined, { now: clock });
    const added = await insertBlock(db, DOC, 'പുതിയത്', undefined, { now: clock + 1_000 });
    expect(await documentText()).toHaveLength(2);

    await undoLast(db, DOC, await sessionOf());

    expect(await documentText()).toEqual(['നിലവിലുള്ളത്']);
    // Soft-deleted, so the text is still in the record (ADR-0018).
    expect((await db.blocks.get(added.blockId))!.text).toBe('പുതിയത്');
  });

  it('reports honestly when there is nothing left to undo', async () => {
    const session = await sessionOf().catch(() => 'none');
    expect(await undoLast(db, DOC, session)).toMatchObject({ undone: 0 });
    expect(await canUndo(db, DOC, session)).toBe(false);
  });

  it('knows when there is something to undo', async () => {
    await insertBlock(db, DOC, 'ഒന്ന്', undefined, { now: clock });
    const session = await sessionOf();

    expect(await canUndo(db, DOC, session)).toBe(true);
    await undoLast(db, DOC, session);
    expect(await canUndo(db, DOC, session)).toBe(false);
  });

  it('leaves the projection consistent with the log', async () => {
    const block = await insertBlock(db, DOC, 'ഒന്ന്', undefined, { now: clock });
    await updateBlock(db, DOC, block.blockId, 'രണ്ട്', { now: clock + 1_000 });
    await undoLast(db, DOC, await sessionOf());

    const doc = (await db.docs.get(DOC))!;
    const stored = await db.blocks.where('docId').equals(DOC).toArray();
    const replayed = visibleBlocks(await replayFromEmpty(db, DOC));

    expect(stored.filter((b) => b.deletedAt === undefined).map((b) => b.text)).toEqual(
      replayed.map((b) => b.text),
    );
    expect(doc.wordCount).toBe(1);
  });
});
