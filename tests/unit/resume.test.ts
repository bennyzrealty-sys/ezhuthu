/**
 * The four resume destinations (ADR-0023, ADR-0026).
 *
 * These run against a real log — blocks arrive through `insertBlock` and
 * `updateBlock` with an injected clock — because every destination is a query
 * over state the append path maintains, and seeding `blocks` directly would
 * test a projection nothing produced.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EzhuthuDB } from '@/db/schema';
import { createDoc, deleteBlock, insertBlock, updateBlock } from '@/core/events';
import {
  RESUME_ORDER,
  lastSessionId,
  resolveDestinations,
  type ResumeKind,
} from '@/features/resume/destinations';
import type { Signal } from '@/db/types';

const DOC = 'doc-1';
const T0 = 1_700_000_000_000;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

let db: EzhuthuDB;
let dbCounter = 0;

beforeEach(async () => {
  db = new EzhuthuDB(`ezhuthu-resume-${dbCounter++}`);
  await db.open();
  await createDoc(db, { docId: DOC, title: 'test', now: T0 });
});

afterEach(async () => {
  db.close();
  await db.delete();
});

/** Import-shaped seed: n blocks, inserted and never edited. */
async function seedBlocks(n: number, now = T0): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const event = await insertBlock(db, DOC, `ഖണ്ഡിക ${i} — കടൽ ശാന്തമായിരുന്നു.`, undefined, {
      now: now + i,
    });
    ids.push(event.blockId);
  }
  return ids;
}

async function dwellSignal(
  blockId: string,
  value: number,
  ts: number,
  sessionId: string,
): Promise<void> {
  const signal: Signal = { docId: DOC, blockId, ts, sessionId, kind: 'dwell', value };
  await db.signals.add(signal);
}

const kindsOf = (destinations: { kind: ResumeKind }[]) => destinations.map((d) => d.kind);

describe('last edited', () => {
  it('offers nothing after an import', async () => {
    /*
     * An import inserts two thousand blocks and updates none of them. Without
     * the revisionCount filter this destination becomes "whichever paragraph
     * the importer wrote last" — a place the writer has never been, offered as
     * where he was working.
     */
    await seedBlocks(5);
    const found = await resolveDestinations(db, DOC, { now: T0 + MINUTE, sessionId: 'ses-now' });
    expect(kindsOf(found)).toEqual([]);
  });

  it('offers the most recently edited block', async () => {
    const ids = await seedBlocks(3);
    await updateBlock(db, DOC, ids[0]!, 'ആദ്യത്തേത് തിരുത്തി.', { now: T0 + 10 * MINUTE });
    await updateBlock(db, DOC, ids[2]!, 'മൂന്നാമത്തേത് തിരുത്തി.', { now: T0 + 20 * MINUTE });

    const found = await resolveDestinations(db, DOC, { now: T0 + 25 * MINUTE });
    const edited = found.find((d) => d.kind === 'lastEdited')!;
    expect(edited.blockId).toBe(ids[2]);
    expect(edited.excerpt).toContain('മൂന്നാമത്തേത്');
    expect(edited.detail).toBe('edited 5 minutes ago');
  });

  it('does not offer a block that has been deleted', async () => {
    const ids = await seedBlocks(2);
    await updateBlock(db, DOC, ids[0]!, 'ഒന്ന് തിരുത്തി.', { now: T0 + MINUTE });
    await updateBlock(db, DOC, ids[1]!, 'രണ്ട് തിരുത്തി.', { now: T0 + 2 * MINUTE });
    await deleteBlock(db, DOC, ids[1]!, { now: T0 + 3 * MINUTE });

    const found = await resolveDestinations(db, DOC, { now: T0 + 4 * MINUTE });
    expect(found.find((d) => d.kind === 'lastEdited')!.blockId).toBe(ids[0]);
  });
});

describe('most rewritten', () => {
  it('picks the highest revision count inside the window', async () => {
    const ids = await seedBlocks(3);
    for (let i = 0; i < 2; i++) {
      await updateBlock(db, DOC, ids[0]!, `ഒന്ന് ${i}`, { now: T0 + i * MINUTE });
    }
    for (let i = 0; i < 6; i++) {
      await updateBlock(db, DOC, ids[1]!, `രണ്ട് ${i}`, { now: T0 + i * MINUTE });
    }

    const found = await resolveDestinations(db, DOC, { now: T0 + 10 * MINUTE });
    const rewritten = found.find((d) => d.kind === 'mostRewritten')!;
    expect(rewritten.blockId).toBe(ids[1]);
    expect(rewritten.detail).toBe('6 revisions');
  });

  it('forgets a paragraph that was hard to write months ago', async () => {
    // Without a window this destination is a monument: the block fought over in
    // March keeps winning in August, long after it stopped being the work.
    const ids = await seedBlocks(2);
    for (let i = 0; i < 20; i++) {
      await updateBlock(db, DOC, ids[0]!, `പഴയത് ${i}`, { now: T0 + i });
    }
    await updateBlock(db, DOC, ids[1]!, 'ഇന്നത്തേത്', { now: T0 + 30 * DAY });

    const found = await resolveDestinations(db, DOC, { now: T0 + 30 * DAY + MINUTE });
    const rewritten = found.find((d) => d.kind === 'mostRewritten')!;
    expect(rewritten.blockId).toBe(ids[1]);
    expect(rewritten.detail).toBe('1 revision');
  });
});

describe('last session', () => {
  it('ignores this session, which is writing signals as it asks', async () => {
    // "The newest sessionId in the store" would be this launch, and the answer
    // would be the paragraph on screen right now.
    const ids = await seedBlocks(3);
    await dwellSignal(ids[0]!, 40_000, T0 + 1, 'ses-old');
    await dwellSignal(ids[1]!, 90_000, T0 + 2, 'ses-now');

    expect(await lastSessionId(db, DOC, 'ses-now')).toBe('ses-old');

    const found = await resolveDestinations(db, DOC, { now: T0 + MINUTE, sessionId: 'ses-now' });
    expect(found.find((d) => d.kind === 'longestDwelled')!.blockId).toBe(ids[0]);
  });

  it('offers the deepest block dwelled on, by document order', async () => {
    const ids = await seedBlocks(12);
    // Dwelled out of order, and the deepest is not the one with the most dwell.
    await dwellSignal(ids[10]!, 5_000, T0 + 1, 'ses-old');
    await dwellSignal(ids[2]!, 90_000, T0 + 2, 'ses-old');

    const found = await resolveDestinations(db, DOC, { now: T0 + MINUTE, sessionId: 'ses-now' });
    expect(found.find((d) => d.kind === 'lastRead')!.blockId).toBe(ids[10]);
    expect(found.find((d) => d.kind === 'longestDwelled')!.blockId).toBe(ids[2]);
  });

  it('compares order lexicographically, not numerically', async () => {
    /*
     * The keys of a twelve-block document include one whose numeric reading
     * and whose string reading disagree; sorting them as numbers puts the
     * wrong paragraph forward. ADR-0007 is the whole reason `order` is a
     * string, and this destination is a place that is easy to get wrong.
     */
    const ids = await seedBlocks(12);
    const blocks = await db.blocks.bulkGet(ids);
    const orders = blocks.map((b) => b!.order);
    const lexicographic = [...orders].sort();
    const numeric = [...orders].sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')));
    expect(lexicographic).not.toEqual(numeric);

    await dwellSignal(ids[9]!, 1_000, T0 + 1, 'ses-old');
    await dwellSignal(ids[11]!, 1_000, T0 + 2, 'ses-old');

    const found = await resolveDestinations(db, DOC, { now: T0 + MINUTE, sessionId: 'ses-now' });
    expect(found.find((d) => d.kind === 'lastRead')!.blockId).toBe(ids[11]);
  });

  it('skips a block that has been deleted since', async () => {
    const ids = await seedBlocks(3);
    await dwellSignal(ids[2]!, 90_000, T0 + 1, 'ses-old');
    await dwellSignal(ids[0]!, 10_000, T0 + 2, 'ses-old');
    await deleteBlock(db, DOC, ids[2]!, { now: T0 + MINUTE });

    const found = await resolveDestinations(db, DOC, { now: T0 + 2 * MINUTE, sessionId: 'ses-now' });
    expect(found.find((d) => d.kind === 'longestDwelled')!.blockId).toBe(ids[0]);
  });

  it('reports dwell in units a person recognises', async () => {
    const ids = await seedBlocks(1);
    await dwellSignal(ids[0]!, 4 * MINUTE, T0 + 1, 'ses-old');
    const found = await resolveDestinations(db, DOC, { now: T0 + MINUTE, sessionId: 'ses-now' });
    expect(found.find((d) => d.kind === 'longestDwelled')!.detail).toBe('4 min of attention');
  });
});

describe('the strip as a whole', () => {
  it('returns destinations in the fixed order regardless of what resolved', async () => {
    const ids = await seedBlocks(4);
    await updateBlock(db, DOC, ids[3]!, 'തിരുത്തി.', { now: T0 + MINUTE });
    await dwellSignal(ids[1]!, 30_000, T0 + 1, 'ses-old');

    const found = await resolveDestinations(db, DOC, { now: T0 + 2 * MINUTE, sessionId: 'ses-now' });
    expect(kindsOf(found)).toEqual(['lastEdited', 'lastRead', 'longestDwelled', 'mostRewritten']);

    // ...and the order is the declared one, not the order they were computed in.
    expect(kindsOf(found)).toEqual(RESUME_ORDER.filter((k) => kindsOf(found).includes(k)));
  });

  it('offers nothing on a fresh document', async () => {
    expect(await resolveDestinations(db, DOC, { now: T0 })).toEqual([]);
  });
});
