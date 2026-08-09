/**
 * Import is a batch write that bypasses the per-event append path, so the
 * thing that matters is that it produces EXACTLY what replaying its own events
 * would. If those diverge, the projection is lying about an imported
 * manuscript and every downstream feature inherits the lie.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EzhuthuDB } from '@/db/schema';
import { createDoc, insertBlock } from '@/core/events';
import { importBlocks, importText, joinBlocks, splitIntoBlocks } from '@/features/io/import';
import { checkProjection, replayFromEmpty } from '@/core/replay';
import { visibleBlocks } from '@/core/fold';
import { ML_SAMPLES } from './helpers';

let db: EzhuthuDB;
let counter = 0;
const DOC = 'doc-1';

beforeEach(async () => {
  db = new EzhuthuDB(`ezhuthu-import-${counter++}`);
  await db.open();
  await createDoc(db, { docId: DOC, now: 1_000 });
});

afterEach(() => db.close());

describe('splitIntoBlocks', () => {
  it('splits on blank lines', () => {
    expect(splitIntoBlocks('one\n\ntwo\n\nthree')).toEqual(['one', 'two', 'three']);
  });

  it('treats runs of blank lines as one separator', () => {
    expect(splitIntoBlocks('one\n\n\n\ntwo')).toEqual(['one', 'two']);
  });

  it('keeps single newlines inside a block', () => {
    expect(splitIntoBlocks('line one\nline two\n\nnext')).toEqual(['line one\nline two', 'next']);
  });

  it('handles CRLF', () => {
    expect(splitIntoBlocks('one\r\n\r\ntwo')).toEqual(['one', 'two']);
  });

  it('drops empty blocks', () => {
    expect(splitIntoBlocks('\n\n\n')).toEqual([]);
    expect(splitIntoBlocks('')).toEqual([]);
  });

  it('round-trips', () => {
    const original = 'ഒന്നാം ഖണ്ഡിക.\n\nരണ്ടാം ഖണ്ഡിക.\n';
    expect(joinBlocks(splitIntoBlocks(original))).toBe(original);
  });

  it('does not normalise — bytes survive the split (ADR-0014)', () => {
    // The ZWJ chillu form must come out exactly as it went in, or import to
    // export is not byte-faithful.
    const zwjForm = 'അവന്‍';
    const [block] = splitIntoBlocks(zwjForm);
    expect(block).toBe(zwjForm);
    expect(block).not.toBe(zwjForm.normalize('NFC').replace(/ന്‍/, 'ൻ'));
  });
});

describe('importBlocks', () => {
  it('writes blocks in document order', async () => {
    await importBlocks(db, DOC, ['one', 'two', 'three'], { now: 2_000 });
    const blocks = await db.blocks.where('docId').equals(DOC).sortBy('order');
    expect(blocks.map((b) => b.text)).toEqual(['one', 'two', 'three']);
  });

  it('appends one event per block and leaves the watermark consistent', async () => {
    await importBlocks(db, DOC, ML_SAMPLES.slice(), { now: 2_000 });
    expect(await db.events.where('docId').equals(DOC).count()).toBe(ML_SAMPLES.length);
    expect((await checkProjection(db, DOC)).consistent).toBe(true);
  });

  it('agrees exactly with replaying its own events', async () => {
    // The load-bearing assertion for this module. `generateNKeysBetween`
    // appending is defined as repeated generateKeyBetween(previous, null),
    // which is what the fold does for a chain of inserts — so the batch
    // shortcut and the fold must agree. Proven, not argued.
    await importBlocks(db, DOC, ML_SAMPLES.slice(), { now: 2_000 });

    const projected = await db.blocks.where('docId').equals(DOC).sortBy('order');
    const replayed = visibleBlocks(await replayFromEmpty(db, DOC));

    expect(replayed.map((b) => b.blockId)).toEqual(projected.map((b) => b.blockId));
    expect(replayed.map((b) => b.order)).toEqual(projected.map((b) => b.order));
    expect(replayed.map((b) => b.text)).toEqual(projected.map((b) => b.text));
  });

  it('appends after existing blocks rather than displacing them', async () => {
    await insertBlock(db, DOC, 'existing', undefined, { now: 1_500 });
    await importBlocks(db, DOC, ['imported one', 'imported two'], { now: 2_000 });

    const blocks = await db.blocks.where('docId').equals(DOC).sortBy('order');
    expect(blocks.map((b) => b.text)).toEqual(['existing', 'imported one', 'imported two']);

    const replayed = visibleBlocks(await replayFromEmpty(db, DOC));
    expect(replayed.map((b) => b.text)).toEqual(blocks.map((b) => b.text));
  });

  it('keeps counters correct', async () => {
    await importBlocks(db, DOC, ['കടൽ ശാന്തമായിരുന്നു.', 'അവൻ ഒരു software engineer ആണ്.'], {
      now: 2_000,
    });
    const doc = await db.docs.get(DOC);
    expect(doc!.blockCount).toBe(2);
    expect(doc!.wordCount).toBe(7);
    expect(doc!.seqCounter).toBe(doc!.lastAppliedSeq + 1);
  });

  it('leaves a subsequent append working normally', async () => {
    await importBlocks(db, DOC, ['a', 'b'], { now: 2_000 });
    await insertBlock(db, DOC, 'typed by hand', undefined, { now: 3_000 });

    const blocks = await db.blocks.where('docId').equals(DOC).sortBy('order');
    expect(blocks.map((b) => b.text)).toEqual(['a', 'b', 'typed by hand']);
    expect((await checkProjection(db, DOC)).consistent).toBe(true);
  });

  it('does nothing for an empty list', async () => {
    const result = await importBlocks(db, DOC, [], { now: 2_000 });
    expect(result.blocksAdded).toBe(0);
    expect(await db.events.count()).toBe(0);
  });

  it('handles a document-sized import in one transaction', async () => {
    const texts = Array.from({ length: 1500 }, (_, i) => `${ML_SAMPLES[i % 5]!} ${i}`);
    const started = performance.now();
    await importText(db, DOC, texts.join('\n\n'), { now: 2_000 });
    const elapsed = performance.now() - started;

    expect(await db.blocks.where('docId').equals(DOC).count()).toBe(1500);
    expect((await checkProjection(db, DOC)).consistent).toBe(true);
    // One transaction, not 1,500. Generous bound — the point is that this is
    // not minutes.
    expect(elapsed).toBeLessThan(10_000);

    // Order keys stay short despite 1,500 sequential appends (ADR-0007).
    const blocks = await db.blocks.where('docId').equals(DOC).sortBy('order');
    expect(Math.max(...blocks.map((b) => b.order.length))).toBeLessThanOrEqual(6);
    expect(blocks.map((b) => b.order)).toEqual([...blocks.map((b) => b.order)].sort());
  });
});
