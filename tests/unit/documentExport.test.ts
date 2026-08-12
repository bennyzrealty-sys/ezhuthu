/**
 * Downloading the document — the export a writer actually asks for, as
 * distinct from the backup (the log) and the corpus (revision pairs).
 *
 * The byte-faithfulness test is the load-bearing one: it is the README's claim
 * about this app's data, and it is only true because neither leg normalises
 * (ADR-0014).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EzhuthuDB } from '@/db/schema';
import { createDoc, deleteBlock, insertBlock, updateBlock } from '@/core/events';
import { documentFilename, exportDocument } from '@/features/io/export';
import { importText, splitIntoBlocks } from '@/features/io/import';

let db: EzhuthuDB;
let counter = 0;
const DOC = 'doc-1';

beforeEach(async () => {
  db = new EzhuthuDB(`ezhuthu-export-${counter++}`);
  await db.open();
  await createDoc(db, { docId: DOC, now: 1_000 });
});

afterEach(() => db.close());

describe('exporting the document', () => {
  it('returns the paragraphs in document order, not insertion order', async () => {
    const second = await insertBlock(db, DOC, 'രണ്ട്');
    // Inserted last, but positioned first: order is a string key, and the
    // export must read it, not the log.
    await insertBlock(db, DOC, 'ഒന്ന്', null);
    await insertBlock(db, DOC, 'മൂന്ന്', second.blockId);

    const { text, blocks } = await exportDocument(db, DOC);
    expect(blocks).toBe(3);
    expect(text).toBe('ഒന്ന്\n\nരണ്ട്\n\nമൂന്ന്\n');
  });

  it('is byte-faithful through import and back out', async () => {
    // The claim the README makes about this app's data. Chillu in both its
    // atomic and ZWJ forms, a ZWNJ, and mixed scripts — normalising on either
    // leg would silently rewrite the manuscript (ADR-0014).
    const original =
      'അവൻ പറഞ്ഞു.\n\nഅവന്‍ വന്നു — ZWJ chillu.\n\n' +
      'ന്‌മ carries a ZWNJ.\n\nHe is a software engineer ആണ്.\n';

    await importText(db, DOC, original);

    const { text } = await exportDocument(db, DOC);
    expect(text).toBe(original);
    // ...and the round trip is idempotent, which is the property that matters
    // when a writer exports, re-imports, and exports again.
    expect(splitIntoBlocks(text)).toEqual(splitIntoBlocks(original));
  });

  it('exports what was edited, not what was first written', async () => {
    const block = await insertBlock(db, DOC, 'ആദ്യ രൂപം');
    await updateBlock(db, DOC, block.blockId, 'തിരുത്തിയ രൂപം');

    expect((await exportDocument(db, DOC)).text).toBe('തിരുത്തിയ രൂപം\n');
  });

  it('leaves deleted paragraphs out', async () => {
    // Recoverable from the log and from the ghost marker (ADR-0018); not part
    // of the manuscript the writer is downloading.
    await insertBlock(db, DOC, 'നിലനിൽക്കുന്നു');
    const gone = await insertBlock(db, DOC, 'ഇല്ലാതാക്കി');
    await deleteBlock(db, DOC, gone.blockId);

    const { text, blocks } = await exportDocument(db, DOC);
    expect(blocks).toBe(1);
    expect(text).toBe('നിലനിൽക്കുന്നു\n');
  });

  it('says nothing rather than a stray newline for an empty document', async () => {
    expect(await exportDocument(db, DOC)).toEqual({ text: '', blocks: 0, characters: 0 });
  });
});

describe('the file name', () => {
  const now = Date.UTC(2026, 7, 11, 19, 44, 5);

  it('is ASCII even when the title is not, or the browser discards it', () => {
    // ADR-0031: a non-ASCII `download` value is dropped whole and the file
    // arrives called `download`, with no extension.
    const name = documentFilename('എന്റെ നോവൽ', now);
    expect(name).toBe('ezhuthu-2026-08-11T19-44-05.txt');
    expect(name).toMatch(/^[\x20-\x7E]+$/);
  });

  it('keeps a title that survives the ASCII rule', () => {
    expect(documentFilename('Chapter One', now)).toBe('ezhuthu-Chapter-One-2026-08-11T19-44-05.txt');
  });

  it('is stamped, so two downloads on one day do not collide', () => {
    const a = documentFilename('', now);
    const b = documentFilename('', now + 61_000);
    expect(a).not.toBe(b);
  });
});
