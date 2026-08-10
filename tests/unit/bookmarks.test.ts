/**
 * Scroll-back auto-bookmarks. Run against a real store: signals are seeded as
 * rows and blocks arrive through the append path, so the query is exercised over
 * state the app actually produces.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EzhuthuDB } from '@/db/schema';
import { createDoc, deleteBlock, insertBlock } from '@/core/events';
import { resolveBookmarks } from '@/features/visibility/bookmarks';
import type { Signal } from '@/db/types';

const DOC = 'doc-1';
const T0 = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

let db: EzhuthuDB;
let counter = 0;

beforeEach(async () => {
  db = new EzhuthuDB(`ezhuthu-bookmarks-${counter++}`);
  await db.open();
  await createDoc(db, { docId: DOC, title: 'test', now: T0 });
});

afterEach(async () => {
  db.close();
  await db.delete();
});

async function seedBlocks(n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const event = await insertBlock(db, DOC, `ഖണ്ഡിക ${i}`, undefined, { now: T0 + i });
    ids.push(event.blockId);
  }
  return ids;
}

async function scrollback(blockId: string, ms: number, ts: number): Promise<void> {
  const signal: Signal = { docId: DOC, blockId, ts, sessionId: 'ses', kind: 'scrollback', value: ms };
  await db.signals.add(signal);
}

describe('resolveBookmarks', () => {
  it('offers nothing when the writer never scrolled back', async () => {
    await seedBlocks(3);
    expect(await resolveBookmarks(db, DOC, { now: T0 + DAY })).toEqual([]);
  });

  it('ranks by how often a block was returned to, not how long', async () => {
    const ids = await seedBlocks(3);
    // Block 0: one long return. Block 1: three short returns.
    await scrollback(ids[0]!, 60_000, T0 + 1);
    await scrollback(ids[1]!, 3_000, T0 + 2);
    await scrollback(ids[1]!, 3_000, T0 + 3);
    await scrollback(ids[1]!, 3_000, T0 + 4);

    const marks = await resolveBookmarks(db, DOC, { now: T0 + DAY });
    expect(marks.map((m) => m.blockId)).toEqual([ids[1], ids[0]]);
    expect(marks[0]!.returns).toBe(3);
    expect(marks[0]!.detail).toBe('returned to 3 times');
    expect(marks[1]!.detail).toBe('returned to once');
  });

  it('drops a block that has since been deleted', async () => {
    const ids = await seedBlocks(2);
    await scrollback(ids[1]!, 5_000, T0 + 1);
    await scrollback(ids[0]!, 5_000, T0 + 2);
    await deleteBlock(db, DOC, ids[1]!, { now: T0 + 10 });

    const marks = await resolveBookmarks(db, DOC, { now: T0 + DAY });
    expect(marks.map((m) => m.blockId)).toEqual([ids[0]]);
  });

  it('forgets a reference checked constantly outside the window', async () => {
    const ids = await seedBlocks(2);
    // Old, heavily-returned; and recent, lightly-returned.
    for (let i = 0; i < 5; i++) await scrollback(ids[0]!, 4_000, T0 + i);
    await scrollback(ids[1]!, 4_000, T0 + 40 * DAY);

    const marks = await resolveBookmarks(db, DOC, { now: T0 + 40 * DAY + 1, windowDays: 30 });
    expect(marks.map((m) => m.blockId)).toEqual([ids[1]]);
  });

  it('excerpts on grapheme clusters and honours the limit', async () => {
    const ids = await seedBlocks(4);
    for (let i = 0; i < ids.length; i++) await scrollback(ids[i]!, (i + 1) * 1000, T0 + i);

    const marks = await resolveBookmarks(db, DOC, { now: T0 + DAY, limit: 2 });
    expect(marks).toHaveLength(2);
    expect(marks[0]!.excerpt).toContain('ഖണ്ഡിക');
  });
});
