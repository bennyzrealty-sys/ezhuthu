/**
 * Backups (ADR-0013). The layer that actually survives eviction, so its
 * failure modes matter more than most.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EzhuthuDB } from '@/db/schema';
import { createDoc, deleteBlock, insertBlock, updateBlock } from '@/core/events';
import {
  backupFilename,
  backupUrgency,
  BACKUP_INTERVAL_MS,
  buildBackup,
  getBackupStatus,
  parseBackup,
  restoreBackup,
} from '@/db/persistence';
import { checkProjection } from '@/core/replay';
import { ML_SAMPLES } from './helpers';

let db: EzhuthuDB;
let counter = 0;
const DOC = 'doc-1';
const T0 = 1_700_000_000_000;

beforeEach(async () => {
  db = new EzhuthuDB(`ezhuthu-persist-${counter++}`);
  await db.open();
  await createDoc(db, { docId: DOC, title: 'നോവൽ', now: T0 });
});

afterEach(() => db.close());

describe('backup urgency', () => {
  it('treats a never-backed-up document as due, not ok', () => {
    expect(backupUrgency(null, T0)).toBe('due');
  });

  it('escalates with age', () => {
    expect(backupUrgency(T0, T0 + BACKUP_INTERVAL_MS / 2)).toBe('ok');
    expect(backupUrgency(T0, T0 + BACKUP_INTERVAL_MS * 2)).toBe('due');
    expect(backupUrgency(T0, T0 + BACKUP_INTERVAL_MS * 5)).toBe('overdue');
    expect(backupUrgency(T0, T0 + BACKUP_INTERVAL_MS * 30)).toBe('urgent');
  });
});

describe('backup status', () => {
  it('counts what a loss would actually cost', async () => {
    // "you would lose 340 edits" lands where "backup overdue" does not.
    for (let i = 0; i < 5; i++) await insertBlock(db, DOC, `block ${i}`, undefined, { now: T0 + i });

    const status = await getBackupStatus(db, DOC, T0 + 10);
    expect(status.unbackedEvents).toBe(5);
    expect(status.lastBackupAt).toBeNull();
    expect(status.urgency).toBe('due');
  });

  it('counts only events since the last backup', async () => {
    await insertBlock(db, DOC, 'before', undefined, { now: T0 });
    await db.docs.update(DOC, { lastBackupAt: T0 + 100 });
    await insertBlock(db, DOC, 'after', undefined, { now: T0 + 200 });

    const status = await getBackupStatus(db, DOC, T0 + 300);
    expect(status.unbackedEvents).toBe(1);
  });
});

describe('backup contents', () => {
  it('carries only the irreplaceable stores', async () => {
    const a = await insertBlock(db, DOC, ML_SAMPLES[0], undefined, { now: T0 });
    await updateBlock(db, DOC, a.blockId, ML_SAMPLES[1], { now: T0 + 1 });

    const backup = await buildBackup(db, T0 + 2);

    expect(backup.format).toBe('ezhuthu-backup');
    expect(backup.version).toBe(1);
    expect(backup.docs).toHaveLength(1);
    expect(backup.events).toHaveLength(2);
    // blocks and snapshots are derivable — including them would inflate the
    // file with data the log already holds (ADR-0001).
    expect(backup).not.toHaveProperty('blocks');
    expect(backup).not.toHaveProperty('snapshots');
  });

  it('orders events canonically', async () => {
    for (let i = 0; i < 10; i++) await insertBlock(db, DOC, `b${i}`);
    const backup = await buildBackup(db, T0);
    const seqs = backup.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
  });

  it('round-trips through JSON', async () => {
    await insertBlock(db, DOC, ML_SAMPLES[3], undefined, { now: T0 });
    const backup = await buildBackup(db, T0);
    const reparsed = parseBackup(JSON.stringify(backup));
    expect(reparsed).toEqual(backup);
  });

  it('rejects files that are not ezhuthu backups', () => {
    expect(() => parseBackup('{"format":"something-else"}')).toThrow(/not an ezhuthu backup/);
    expect(() => parseBackup('{"format":"ezhuthu-backup","version":99}')).toThrow(
      /unsupported backup version/,
    );
    expect(() => parseBackup('{"format":"ezhuthu-backup","version":1}')).toThrow(
      /missing docs or events/,
    );
  });

  it('builds a filename that survives Malayalam titles', () => {
    const name = backupFilename([{ title: 'എന്റെ നോവൽ' } as never], T0);
    expect(name).toMatch(/^ezhuthu-.+\.json$/);
    expect(name).not.toContain(' ');
    expect(name).not.toContain(':');
    /*
     * The whole title, not merely some Malayalam. Asserting only that a
     * Malayalam character survived is what let this through: vowel signs and
     * the virama are combining marks, so a keep-set of letters and digits
     * passed a test like that while writing എന-റ-ന-വൽ — every base consonant
     * intact and every mark replaced with a dash. Marks travel with their
     * cluster (Rule 1).
     */
    expect(name).toBe('ezhuthu-എന്റെ-നോവൽ-2023-11-14T22-13-20.json');
  });
});

describe('restore', () => {
  it('rebuilds the document from the log alone', async () => {
    const a = await insertBlock(db, DOC, 'one', undefined, { now: T0 });
    await insertBlock(db, DOC, 'two', undefined, { now: T0 + 1 });
    await updateBlock(db, DOC, a.blockId, 'one edited', { now: T0 + 2 });
    const backup = await buildBackup(db, T0 + 3);

    // A fresh device: nothing but the backup file.
    const fresh = new EzhuthuDB(`ezhuthu-restore-${counter++}`);
    await fresh.open();
    const result = await restoreBackup(fresh, parseBackup(JSON.stringify(backup)));

    expect(result.eventsAdded).toBe(3);
    expect(result.eventsSkipped).toBe(0);

    const blocks = await fresh.blocks.where('docId').equals(DOC).sortBy('order');
    expect(blocks.map((b) => b.text)).toEqual(['one edited', 'two']);
    expect((await checkProjection(fresh, DOC)).consistent).toBe(true);
    expect((await fresh.docs.get(DOC))!.wordCount).toBe(3);
    fresh.close();
  });

  it('is idempotent — restoring twice changes nothing', async () => {
    await insertBlock(db, DOC, 'one', undefined, { now: T0 });
    await insertBlock(db, DOC, 'two', undefined, { now: T0 + 1 });
    const backup = await buildBackup(db, T0 + 2);

    const fresh = new EzhuthuDB(`ezhuthu-restore-${counter++}`);
    await fresh.open();
    await restoreBackup(fresh, backup);
    const second = await restoreBackup(fresh, backup);

    expect(second.eventsAdded).toBe(0);
    expect(second.eventsSkipped).toBe(2);
    expect(await fresh.blocks.count()).toBe(2);
    fresh.close();
  });

  it('merges into a device that has since been written to', async () => {
    // The case that actually happens: you restore onto a device that already
    // has work on it. Nothing may be silently dropped.
    await insertBlock(db, DOC, 'shared', undefined, { now: T0 });
    const backup = await buildBackup(db, T0 + 1);

    await insertBlock(db, DOC, 'written after the backup', undefined, { now: T0 + 2 });
    const result = await restoreBackup(db, backup);

    expect(result.eventsSkipped).toBe(1);
    expect(result.eventsAdded).toBe(0);
    const texts = (await db.blocks.where('docId').equals(DOC).sortBy('order')).map((b) => b.text);
    expect(texts).toContain('written after the backup');
    expect(texts).toContain('shared');
  });

  it('never lets the seq counter reissue an occupied seq', async () => {
    await insertBlock(db, DOC, 'one', undefined, { now: T0 });
    await insertBlock(db, DOC, 'two', undefined, { now: T0 + 1 });
    const backup = await buildBackup(db, T0 + 2);
    const highestSeq = Math.max(...backup.events.map((e) => e.seq));

    const fresh = new EzhuthuDB(`ezhuthu-restore-${counter++}`);
    await fresh.open();
    await restoreBackup(fresh, backup);

    expect((await fresh.docs.get(DOC))!.seqCounter).toBeGreaterThan(highestSeq);

    // And a subsequent append must not collide with restored history.
    const next = await insertBlock(fresh, DOC, 'after restore', undefined, { now: T0 + 5 });
    expect(next.seq).toBeGreaterThan(highestSeq);
    expect((await checkProjection(fresh, DOC)).consistent).toBe(true);
    fresh.close();
  });

  it('restores soft-deleted blocks as ghosts, not as live text', async () => {
    const a = await insertBlock(db, DOC, 'kept', undefined, { now: T0 });
    const b = await insertBlock(db, DOC, 'cut', undefined, { now: T0 + 1 });
    await deleteBlock(db, DOC, b.blockId, { now: T0 + 2 });
    const backup = await buildBackup(db, T0 + 3);

    const fresh = new EzhuthuDB(`ezhuthu-restore-${counter++}`);
    await fresh.open();
    await restoreBackup(fresh, backup);

    const all = await fresh.blocks.where('docId').equals(DOC).sortBy('order');
    expect(all).toHaveLength(2);
    expect(all.filter((x) => x.deletedAt === undefined).map((x) => x.text)).toEqual(['kept']);
    // The deleted text survives the round trip, so ghost markers still work.
    expect(all.find((x) => x.blockId === b.blockId)!.text).toBe('cut');
    expect((await fresh.docs.get(DOC))!.blockCount).toBe(1);
    void a;
    fresh.close();
  });
});
