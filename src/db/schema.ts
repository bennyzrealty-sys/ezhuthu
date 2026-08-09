import Dexie, { type EntityTable, type Table } from 'dexie';
import type { Block, BlockEvent, Doc, DocId, Setting, Signal, Snapshot } from './types';
// Safe to import statically: core/ refers back to this module with `import
// type` only, so nothing here participates in a runtime cycle.
import { replayFromEmpty } from '../core/replay';
import { visibleBlocks } from '../core/fold';
import { countWordsInBlocks } from '../text/count';

/**
 * Dexie schema. See docs/DATA-MODEL.md for why each index exists.
 *
 * `events` and `docs` are the only irreplaceable stores. `blocks` and
 * `snapshots` are caches — dropping them costs a rebuild, never data. That is
 * why a backup contains only the first two (ADR-0013).
 */
export class EzhuthuDB extends Dexie {
  docs!: EntityTable<Doc, 'id'>;
  blocks!: EntityTable<Block, 'blockId'>;
  events!: EntityTable<BlockEvent, 'id'>;
  /** Compound primary key [docId+seq], so the key type is a tuple. */
  snapshots!: Table<Snapshot, [DocId, number]>;
  signals!: EntityTable<Signal, 'id'>;
  settings!: EntityTable<Setting, 'key'>;

  constructor(name = 'ezhuthu') {
    super(name);
    this.version(1).stores({
      docs: 'id, updatedAt',
      blocks: 'blockId, [docId+order], [docId+updatedAt], docId',
      // &[docId+seq+deviceId] is unique so a duplicate-seq bug surfaces as a
      // failed write rather than a silently corrupt log (ADR-0020).
      events: 'id, &[docId+seq+deviceId], [docId+seq], [docId+blockId+seq], ts',
      snapshots: '[docId+seq], docId, ts',
      signals: '++id, [docId+blockId], [docId+ts], ts',
      settings: 'key',
    });
  }
}

export const db = new EzhuthuDB();

/**
 * Rebuild the `blocks` projection from the log. Safe to call at any time —
 * that is the point of the projection being a cache (ADR-0008).
 *
 * This is one of the three legitimate whole-document writes (the others are
 * import and restore). It is a batch maintenance operation, not a code path
 * any editing flow may use.
 */
export async function rebuildProjection(db: EzhuthuDB, docId: string): Promise<void> {
  await db.transaction('rw', db.docs, db.blocks, db.events, async () => {
    const state = await replayFromEmpty(db, docId);
    const live = visibleBlocks(state);

    await db.blocks.where('docId').equals(docId).delete();
    await db.blocks.bulkAdd([...state.blocks.values()]);

    const doc = await db.docs.get(docId);
    await db.docs.update(docId, {
      lastAppliedSeq: state.seq,
      // Never move the counter backwards: a seq must not be reissued.
      seqCounter: Math.max(doc?.seqCounter ?? 0, state.seq + 1),
      blockCount: live.length,
      wordCount: countWordsInBlocks(live.map((b) => b.text)),
    });
  });
}
