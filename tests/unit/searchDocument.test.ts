/**
 * Search over the store (ADR-0015).
 *
 * These run against a real Dexie (fake-indexeddb) rather than a stub, because
 * the two properties that matter — that results come back in document order
 * and that soft-deleted blocks stay out of them — are properties of the index
 * and the cursor, not of the matcher.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EzhuthuDB } from '@/db/schema';
import { createDoc, deleteBlock, insertBlock, updateBlock } from '@/core/events';
import { importBlocks } from '@/features/io/import';
import { flattenMatches, searchDocument } from '@/features/search/searchDocument';
import { ZWNJ } from '@/text/normalize';

let db: EzhuthuDB;
let counter = 0;
const DOC = 'doc-1';

const SEQUENCE_CHILLU_N = 'അവന്‍';

beforeEach(async () => {
  db = new EzhuthuDB(`ezhuthu-search-${counter++}`);
  await db.open();
  await createDoc(db, { docId: DOC, now: 1_000 });
});

afterEach(() => db.close());

async function seed(texts: string[]): Promise<void> {
  await importBlocks(db, DOC, texts);
}

/** Blocks in document order. `order` is only indexed as [docId+order]. */
async function liveBlocks() {
  return db.blocks.where('[docId+order]').between([DOC, ''], [DOC, '\uffff']).toArray();
}

describe('searching the store', () => {
  it('finds a block that was never rendered', async () => {
    // The whole justification for ADR-0015: at 1,563 blocks the DOM holds ~12,
    // so a DOM-based search cannot see this one at all.
    const texts = Array.from({ length: 400 }, (_, i) => `ഖണ്ഡിക ${i}. കടൽ ശാന്തം.`);
    texts[377] = 'ഇവിടെ ഒരു അപൂർവ്വ വാക്ക് ഉണ്ട്.';
    await seed(texts);

    const result = await searchDocument(db, DOC, { needle: 'അപൂർവ്വ' });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]!.position).toBe(377);
    expect(result.blocksScanned).toBe(400);
  });

  it('returns hits in document order, not insertion order', async () => {
    await seed(['ഒന്ന് മഴ', 'രണ്ട്', 'മൂന്ന് മഴ']);

    // A block inserted between the first two takes an order key between them
    // (ADR-0007), so its position is 1 even though it was written last.
    await insertBlock(db, DOC, 'ഒന്നര മഴ', (await liveBlocks())[0]!.blockId);

    const result = await searchDocument(db, DOC, { needle: 'മഴ' });

    expect(result.hits.map((h) => h.position)).toEqual([0, 1, 3]);
    expect(result.hits.map((h) => h.excerpt.text)).toEqual([
      'ഒന്ന് മഴ',
      'ഒന്നര മഴ',
      'മൂന്ന് മഴ',
    ]);
  });

  it('finds a word typed in the other chillu form', async () => {
    // This is what the fold buys, seen end to end: what is on screen is
    // "അവൻ" either way, and only one of the two forms is in storage.
    await seed(['ഇന്ന്', `${SEQUENCE_CHILLU_N} വന്നു.`, 'നാളെ']);

    const result = await searchDocument(db, DOC, { needle: 'അവൻ' });

    expect(result.hits).toHaveLength(1);
    const { excerpt } = result.hits[0]!;
    expect(excerpt.text.slice(excerpt.matchStart, excerpt.matchEnd)).toBe(SEQUENCE_CHILLU_N);
  });

  it('still tells apart words differing only by ZWNJ', async () => {
    await seed([`കൽ${ZWNJ}പന നൽകി.`, 'കല്പന നൽകി.']);

    expect((await searchDocument(db, DOC, { needle: 'കല്പന' })).hits).toHaveLength(1);
    expect((await searchDocument(db, DOC, { needle: `കൽ${ZWNJ}പന` })).hits).toHaveLength(1);
  });

  it('counts every match, not every block', async () => {
    await seed(['മഴ മഴ മഴ', 'വെയിൽ', 'മഴ']);

    const result = await searchDocument(db, DOC, { needle: 'മഴ' });

    expect(result.hits).toHaveLength(2);
    expect(result.matchCount).toBe(4);
    expect(flattenMatches(result.hits)).toHaveLength(4);
  });

  it('reports nothing for an empty query rather than everything', async () => {
    await seed(['കടൽ', 'മഴ']);

    const result = await searchDocument(db, DOC, { needle: '' });

    expect(result.hits).toEqual([]);
    expect(result.blocksScanned).toBe(0);
  });
});

describe('soft-deleted blocks', () => {
  it('are excluded from results', async () => {
    // ADR-0018 keeps the record and its text so a restore can put it back.
    // Every query over blocks has to filter it out; forgetting here would
    // resurrect deleted paragraphs into the search results.
    await seed(['കടൽ ഒന്ന്', 'കടൽ രണ്ട്', 'കടൽ മൂന്ന്']);
    const blocks = await liveBlocks();
    await deleteBlock(db, DOC, blocks[1]!.blockId);

    const result = await searchDocument(db, DOC, { needle: 'കടൽ' });

    expect(result.hits).toHaveLength(2);
    expect(result.hits.map((h) => h.excerpt.text)).toEqual(['കടൽ ഒന്ന്', 'കടൽ മൂന്ന്']);
    expect(result.blocksScanned).toBe(2);
  });

  it('do not shift the positions the virtualiser scrolls to', async () => {
    // The index the virtualiser renders excludes deleted blocks, so positions
    // must be counted the same way. Counting the deleted one would send every
    // later result to the wrong paragraph.
    await seed(['ഒന്ന്', 'രണ്ട്', 'മൂന്ന് കടൽ']);
    const blocks = await liveBlocks();
    await deleteBlock(db, DOC, blocks[0]!.blockId);

    const result = await searchDocument(db, DOC, { needle: 'കടൽ' });

    expect(result.hits[0]!.position).toBe(1);
  });
});

describe('limits', () => {
  it('caps the hits and says so', async () => {
    await seed(Array.from({ length: 40 }, (_, i) => `ഖണ്ഡിക ${i} കടൽ`));

    const result = await searchDocument(db, DOC, { needle: 'കടൽ', limit: 10 });

    expect(result.hits).toHaveLength(10);
    expect(result.truncated).toBe(true);
    // The total is still honest: capping what is rendered must not make the
    // count under-report, or "10 results" is a lie about the document.
    expect(result.matchCount).toBe(40);
    expect(result.blocksScanned).toBe(40);
  });

  it('is not truncated when everything fits', async () => {
    await seed(['കടൽ', 'മഴ']);

    const result = await searchDocument(db, DOC, { needle: 'കടൽ', limit: 10 });

    expect(result.truncated).toBe(false);
  });
});

describe('live edits', () => {
  it('sees text committed a moment ago', async () => {
    // The projection is written in the same transaction as the event
    // (ADR-0008), so a search immediately after a commit cannot race it.
    await seed(['ഒന്ന്', 'രണ്ട്']);
    const blocks = await liveBlocks();
    await updateBlock(db, DOC, blocks[1]!.blockId, 'രണ്ട് — ഒരു പുതിയ വാക്യം കടൽ');

    const result = await searchDocument(db, DOC, { needle: 'പുതിയ' });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]!.position).toBe(1);
  });
});

describe('cancellation', () => {
  it('scans nothing when the signal is already aborted', async () => {
    await seed(Array.from({ length: 50 }, () => 'കടൽ ശാന്തം'));

    const controller = new AbortController();
    controller.abort();

    const result = await searchDocument(db, DOC, { needle: 'കടൽ', signal: controller.signal });

    expect(result.aborted).toBe(true);
    expect(result.blocksScanned).toBe(0);
  });

  it('stops mid-document when the query changes under it', async () => {
    /*
     * The case that matters — a keystroke arriving while a scan of a 100k-word
     * manuscript is in flight — and the one a pre-aborted signal cannot show.
     * A real AbortController cannot be fired at a chosen point in a synchronous
     * cursor, so the signal is a stub that flips after a few reads. Anything
     * this reaches only ever reads `.aborted`.
     */
    await seed(Array.from({ length: 50 }, () => 'കടൽ ശാന്തം'));

    let reads = 0;
    const signal = {
      get aborted() {
        reads += 1;
        return reads > 5;
      },
    } as AbortSignal;

    const result = await searchDocument(db, DOC, { needle: 'കടൽ', signal });

    expect(result.aborted).toBe(true);
    expect(result.blocksScanned).toBeGreaterThan(0);
    // The point: it did not read the other forty-odd blocks first.
    expect(result.blocksScanned).toBeLessThan(20);
  });

  it('reports a complete scan as complete', async () => {
    await seed(Array.from({ length: 5 }, () => 'കടൽ ശാന്തം'));

    const result = await searchDocument(db, DOC, {
      needle: 'കടൽ',
      signal: new AbortController().signal,
    });

    expect(result.aborted).toBe(false);
    expect(result.blocksScanned).toBe(5);
  });
});
