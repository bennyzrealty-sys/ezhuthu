import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EzhuthuDB } from '@/db/schema';
import { createDoc, deleteBlock, insertBlock, updateBlock } from '@/core/events';
import { importBlocks } from '@/features/io/import';
import { corpusFilename, exportCorpus, toJsonl } from '@/features/io/corpus/export';
import { COALESCE_WINDOW_MS } from '@/features/io/corpus/constants';
import { ZWJ } from '@/text/normalize';

const DOC = 'doc-corpus';

let db: EzhuthuDB;
let clock = 1_700_000_000_000;

/** Distinct enough to break a coalescing run. */
const later = (minutes: number): number => (clock += minutes * 60_000);

beforeEach(async () => {
  db = new EzhuthuDB(`corpus-${Math.random().toString(36).slice(2)}`);
  await db.open();
  await createDoc(db, { docId: DOC, title: 'എഴുത്ത്', now: clock });
});

afterEach(async () => {
  await db.delete();
});

/** Every record in an exported corpus. */
function records(jsonl: string): Array<Record<string, unknown>> {
  return jsonl
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('exporting the corpus', () => {
  it('is empty for a document that was only ever imported', async () => {
    // Import writes one insert per block and no updates. Nothing was revised,
    // so there is nothing to learn from it.
    await importBlocks(db, DOC, ['ഒന്നാം ഖണ്ഡിക.', 'രണ്ടാം ഖണ്ഡിക.'], { now: clock });
    const { jsonl, stats } = await exportCorpus(db, DOC);

    expect(jsonl).toBe('');
    expect(stats.blocks).toBe(2);
    expect(stats.revisions).toBe(0);
    expect(stats.emitted).toBe(0);
  });

  it('reconstructs before from the log rather than from the payload', async () => {
    const insert = await insertBlock(db, DOC, 'കടൽ ശാന്തമായിരുന്നു.', undefined, { now: clock });
    await updateBlock(db, DOC, insert.blockId, 'കടൽ ഇളകിമറിഞ്ഞു, ആകാശം ഇരുണ്ടു.', {
      now: later(10),
    });

    // The update carries no prevText — that is the point of ADR-0012.
    const stored = await db.events
      .where('[docId+blockId+seq]')
      .between([DOC, insert.blockId, 0], [DOC, insert.blockId, Infinity])
      .toArray();
    expect(stored.some((e) => e.payload.prevText !== undefined)).toBe(false);

    const { jsonl } = await exportCorpus(db, DOC);
    const [pair] = records(jsonl);

    expect(pair).toEqual({
      before: 'കടൽ ശാന്തമായിരുന്നു.',
      after: 'കടൽ ഇളകിമറിഞ്ഞു, ആകാശം ഇരുണ്ടു.',
      ts: expect.any(Number),
      revisionIndex: 1,
    });
  });

  it('carries no identifier of any kind', async () => {
    const insert = await insertBlock(db, DOC, 'അവൻ ഒരു എഴുത്തുകാരൻ ആണ്.', undefined, { now: clock });
    await updateBlock(db, DOC, insert.blockId, 'അവൻ വാക്കുകൾ കൊണ്ട് ജീവിക്കുന്ന ഒരാളാണ്.', {
      now: later(10),
    });

    const { jsonl } = await exportCorpus(db, DOC);
    for (const record of records(jsonl)) {
      expect(Object.keys(record).sort()).toEqual(['after', 'before', 'revisionIndex', 'ts']);
    }
    expect(jsonl).not.toContain(insert.blockId);
    expect(jsonl).not.toContain(DOC);
  });

  it('collapses an editing burst and splits at the window', async () => {
    const insert = await insertBlock(db, DOC, 'ഒന്ന്', undefined, { now: clock });
    // One burst: four commits a few seconds apart.
    for (const text of ['ഒന്നും', 'ഒന്നും രണ്ടും', 'ഒന്നും രണ്ടും മൂന്നും കൂടി ചേർന്നു']) {
      await updateBlock(db, DOC, insert.blockId, text, { now: (clock += 4_000) });
    }
    // Back after a break.
    await updateBlock(db, DOC, insert.blockId, 'ഒന്നും രണ്ടും മൂന്നും നാലും ഒരുമിച്ചു ചേർന്നു', {
      now: (clock += COALESCE_WINDOW_MS * 2),
    });

    const { jsonl, stats } = await exportCorpus(db, DOC);
    const pairs = records(jsonl);

    expect(stats.revisions).toBe(4);
    expect(stats.pairs).toBe(2);
    expect(pairs).toHaveLength(2);
    expect(pairs[0]!.before).toBe('ഒന്ന്');
    expect(pairs[0]!.after).toBe('ഒന്നും രണ്ടും മൂന്നും കൂടി ചേർന്നു');
    expect(pairs[1]!.before).toBe('ഒന്നും രണ്ടും മൂന്നും കൂടി ചേർന്നു');
    expect(pairs[1]!.revisionIndex).toBe(2);
  });

  it('drops a re-encoding and says so', async () => {
    const insert = await insertBlock(db, DOC, 'അവൻ വന്നു.', undefined, { now: clock });
    await updateBlock(db, DOC, insert.blockId, `അവന്${ZWJ} വന്നു.`, { now: later(10) });

    const { jsonl, stats } = await exportCorpus(db, DOC);

    expect(jsonl).toBe('');
    expect(stats.pairs).toBe(1);
    expect(stats.emitted).toBe(0);
    expect(stats.dropped.unchanged).toBe(1);
  });

  it('keeps the history of a paragraph that was later deleted', async () => {
    const insert = await insertBlock(db, DOC, 'ഒരു പഴയ ഖണ്ഡിക ഇവിടെ ഉണ്ടായിരുന്നു.', undefined, {
      now: clock,
    });
    await updateBlock(db, DOC, insert.blockId, 'ഒരു പഴയ ഖണ്ഡിക ഇവിടെ നിന്ന് മാറ്റി എഴുതി.', {
      now: later(10),
    });
    await deleteBlock(db, DOC, insert.blockId, { now: later(10) });

    const { jsonl, stats } = await exportCorpus(db, DOC);

    // The revision happened; the deletion is what produces no pair.
    expect(records(jsonl)).toHaveLength(1);
    expect(stats.blocks).toBe(1);
  });

  it('emits in log order across blocks, not by block id', async () => {
    const a = await insertBlock(db, DOC, 'ആദ്യത്തെ ഖണ്ഡിക ഇവിടെ.', undefined, { now: clock });
    const b = await insertBlock(db, DOC, 'രണ്ടാമത്തെ ഖണ്ഡിക ഇവിടെ.', a.blockId, { now: clock });

    await updateBlock(db, DOC, b.blockId, 'രണ്ടാമത്തെ ഖണ്ഡിക പുതുക്കി എഴുതിയിരിക്കുന്നു.', {
      now: later(10),
    });
    await updateBlock(db, DOC, a.blockId, 'ആദ്യത്തെ ഖണ്ഡിക പിന്നീട് മാറ്റി എഴുതിയിരിക്കുന്നു.', {
      now: later(10),
    });

    const pairs = records((await exportCorpus(db, DOC)).jsonl);
    expect(pairs.map((p) => p.before)).toEqual([
      'രണ്ടാമത്തെ ഖണ്ഡിക ഇവിടെ.',
      'ആദ്യത്തെ ഖണ്ഡിക ഇവിടെ.',
    ]);
  });

  it('exports only the document it was asked for', async () => {
    await createDoc(db, { docId: 'other', title: 'other', now: clock });
    const mine = await insertBlock(db, DOC, 'എന്റെ ഖണ്ഡിക ഇവിടെ ഉണ്ട്.', undefined, { now: clock });
    const theirs = await insertBlock(db, 'other', 'മറ്റൊരു ഖണ്ഡിക അവിടെ ഉണ്ട്.', undefined, {
      now: clock,
    });
    await updateBlock(db, DOC, mine.blockId, 'എന്റെ ഖണ്ഡിക മാറ്റി എഴുതിയിരിക്കുന്നു.', {
      now: later(10),
    });
    await updateBlock(db, 'other', theirs.blockId, 'മറ്റൊരു ഖണ്ഡിക മാറ്റി എഴുതിയിരിക്കുന്നു.', {
      now: later(10),
    });

    const { jsonl, stats } = await exportCorpus(db, DOC);
    expect(stats.blocks).toBe(1);
    expect(jsonl).not.toContain('മറ്റൊരു');
  });

  it('writes one record per line and ends with a newline', async () => {
    const insert = await insertBlock(db, DOC, 'ഒന്നാമത്തെ വാചകം ഇവിടെ.', undefined, { now: clock });
    await updateBlock(db, DOC, insert.blockId, 'ഒന്നാമത്തെ വാചകം മാറ്റി എഴുതി.', { now: later(10) });
    await updateBlock(db, DOC, insert.blockId, 'ഒന്നാമത്തെ വാചകം വീണ്ടും മാറ്റി എഴുതി.', {
      now: later(10),
    });

    const { jsonl } = await exportCorpus(db, DOC);
    expect(jsonl.endsWith('\n')).toBe(true);
    expect(jsonl.trimEnd().split('\n')).toHaveLength(2);
    // Malayalam is emitted as itself, not as \u escapes — the file is meant to
    // be readable.
    expect(jsonl).toContain('ഒന്നാമത്തെ');
  });
});

describe('corpus files', () => {
  it('serialises nothing to an empty string, not a bare newline', () => {
    expect(toJsonl([])).toBe('');
  });

  it('names the file after the moment, and the title where it survives', () => {
    // ASCII only, and for a measured reason — see fileNameStem in ui/download.
    expect(corpusFilename('എഴുത്ത്', Date.UTC(2026, 7, 10, 9, 30, 0))).toBe(
      'ezhuthu-corpus-2026-08-10T09-30-00.jsonl',
    );
    expect(corpusFilename('My Novel', Date.UTC(2026, 7, 10, 9, 30, 0))).toBe(
      'ezhuthu-corpus-My-Novel-2026-08-10T09-30-00.jsonl',
    );
  });

  it('survives a title made entirely of characters a filesystem dislikes', () => {
    expect(corpusFilename('///', 0)).toBe('ezhuthu-corpus-1970-01-01T00-00-00.jsonl');
    expect(corpusFilename('', 0)).toBe('ezhuthu-corpus-1970-01-01T00-00-00.jsonl');
  });
});
