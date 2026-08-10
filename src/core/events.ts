/**
 * The append path. THE ONLY PLACE that writes document state.
 *
 * Every mutation performs four steps in ONE transaction (ADR-0008):
 *
 *   1. allocate seq   — bump the counter on the doc record (ADR-0020)
 *   2. append event   → events
 *   3. apply fold     → blocks
 *   4. advance        → docs.lastAppliedSeq
 *
 * All four commit or none do. Step 4 is the watermark that proves the `blocks`
 * projection is in step with the log; without it a crash between 2 and 3
 * leaves the document silently wrong, which is precisely the failure event
 * sourcing is supposed to make impossible.
 *
 * `db.blocks.put()` must never be called outside this module.
 */

import Dexie from 'dexie';
import type { EzhuthuDB } from '../db/schema';
import { getDeviceId, getSessionId, uuid } from '../db/ids';
import type {
  Block,
  BlockEvent,
  BlockEventPayload,
  BlockEventType,
  BlockId,
  Doc,
  DocId,
  DocState,
} from '../db/types';
import { applyEvent, emptyState } from './fold';
import { countWords } from '../text/count';

export interface AppendInput {
  docId: DocId;
  blockId: BlockId;
  type: BlockEventType;
  payload: BlockEventPayload;
  /** Injected for tests. Real callers omit it. */
  now?: number;
}

/**
 * Build a DocState containing only the blocks the fold needs to resolve this
 * event, so appending never reads the whole document.
 *
 * The fold is still the single definition of what an event means — we narrow
 * its input rather than reimplementing its logic. Fractional indexing
 * guarantees the only record that changes is the event's own block, so the
 * neighbours are needed for position resolution and nothing else.
 */
async function buildNeighbourState(
  db: EzhuthuDB,
  docId: DocId,
  input: AppendInput,
): Promise<DocState> {
  const state = emptyState(docId);
  const add = (b: Block | undefined): void => {
    if (b === undefined) return;
    state.blocks.set(b.blockId, b);
  };

  const byOrder = () =>
    db.blocks.where('[docId+order]').between([docId, Dexie.minKey], [docId, Dexie.maxKey]);

  const target = await db.blocks.get(input.blockId);
  add(target);

  const isRestoreInPlace =
    input.type === 'insert' && target !== undefined && input.payload.afterBlockId === undefined;

  if (input.type === 'update' || input.type === 'delete' || isRestoreInPlace) {
    // Position is untouched, so no neighbours are needed.
    state.order = target ? [target.blockId] : [];
    return state;
  }

  // insert / move: resolve position from the neighbours around `afterBlockId`.
  const after = input.payload.afterBlockId;
  const neighbours: Block[] = [];

  if (after === null) {
    const first = await byOrder().first();
    if (first) neighbours.push(first);
  } else if (after === undefined) {
    const last = await byOrder().last();
    if (last) neighbours.push(last);
  } else {
    const prev = await db.blocks.get(after);
    if (prev === undefined) {
      throw new Error(`append: afterBlockId ${after} not found in ${docId}`);
    }
    neighbours.push(prev);
    const succ = await db.blocks
      .where('[docId+order]')
      .above([docId, prev.order])
      .first();
    if (succ) neighbours.push(succ);
  }

  for (const n of neighbours) add(n);
  state.order = neighbours
    .filter((n) => n.blockId !== input.blockId)
    .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0))
    .map((n) => n.blockId);

  return state;
}

/**
 * Append one event and apply it. Returns the event that was written.
 *
 * Concurrency: `seq` is allocated by bumping `doc.seqCounter` inside this
 * transaction, so two tabs on the same document serialise on the `docs` lock
 * rather than racing to read the same maximum (ADR-0020).
 */
export async function appendEvent(db: EzhuthuDB, input: AppendInput): Promise<BlockEvent> {
  const ts = input.now ?? Date.now();

  return db.transaction('rw', db.docs, db.events, db.blocks, async () => {
    const doc = await db.docs.get(input.docId);
    if (doc === undefined) throw new Error(`append: unknown document ${input.docId}`);

    const seq = doc.seqCounter;

    const event: BlockEvent = {
      id: uuid(),
      seq,
      ts,
      sessionId: getSessionId(),
      deviceId: getDeviceId(),
      docId: input.docId,
      blockId: input.blockId,
      type: input.type,
      payload: input.payload,
    };

    const before = await db.blocks.get(input.blockId);
    const state = await buildNeighbourState(db, input.docId, input);

    await db.events.add(event);
    applyEvent(state, event);

    const after = state.blocks.get(input.blockId);
    if (after === undefined) {
      throw new Error(`append: fold produced no block for ${input.blockId}`);
    }
    await db.blocks.put(after);

    await db.docs.update(input.docId, {
      lastAppliedSeq: seq,
      seqCounter: seq + 1,
      updatedAt: ts,
      blockCount: doc.blockCount + blockCountDelta(before, after),
      wordCount: doc.wordCount + wordCountDelta(before, after),
    });

    return event;
  });
}

/** Live blocks only — a soft-deleted block is not part of the document. */
function blockCountDelta(before: Block | undefined, after: Block): number {
  const wasLive = before !== undefined && before.deletedAt === undefined;
  const isLive = after.deletedAt === undefined;
  return (isLive ? 1 : 0) - (wasLive ? 1 : 0);
}

/**
 * Per-block delta only. Recounting the document would be a whole-document
 * read on every keystroke commit.
 */
function wordCountDelta(before: Block | undefined, after: Block): number {
  const wasLive = before !== undefined && before.deletedAt === undefined;
  const isLive = after.deletedAt === undefined;
  const previous = wasLive ? countWords(before.text) : 0;
  const current = isLive ? countWords(after.text) : 0;
  return current - previous;
}

export interface CreateDocInput {
  title?: string;
  docId?: DocId;
  now?: number;
}

export async function createDoc(db: EzhuthuDB, input: CreateDocInput = {}): Promise<Doc> {
  const ts = input.now ?? Date.now();
  const doc: Doc = {
    id: input.docId ?? uuid(),
    title: input.title ?? '',
    createdAt: ts,
    updatedAt: ts,
    seqCounter: 1,
    lastAppliedSeq: 0,
    blockCount: 0,
    wordCount: 0,
  };
  await db.docs.add(doc);
  return doc;
}

/**
 * The document, created if it is not there yet.
 *
 * Check-then-create outside a transaction is a race by construction — the same
 * shape as reading max(seq) before appending, which ADR-0020 exists to
 * prevent. Two callers both see nothing and both `add`, and the loser gets a
 * ConstraintError. In this app the two callers are the effect that opens the
 * document and whatever the user does first, so the window is exactly the
 * first moments of a fresh install.
 *
 * The transaction's lock on `docs` serialises them, and the second caller
 * finds the record the first one wrote.
 */
export async function openDoc(db: EzhuthuDB, input: CreateDocInput = {}): Promise<Doc> {
  return db.transaction('rw', db.docs, async () => {
    const id = input.docId;
    const existing = id === undefined ? undefined : await db.docs.get(id);
    return existing ?? (await createDoc(db, input));
  });
}

// ---------------------------------------------------------------------------
// Convenience wrappers. Every editing flow goes through these.
// ---------------------------------------------------------------------------

/**
 * `afterBlockId`: `null` = first in document, `undefined` = append at end,
 * a blockId = immediately after that block.
 */
export async function insertBlock(
  db: EzhuthuDB,
  docId: DocId,
  text: string,
  afterBlockId?: BlockId | null,
  opts: { blockId?: BlockId; now?: number } = {},
): Promise<BlockEvent> {
  return appendEvent(db, {
    docId,
    blockId: opts.blockId ?? uuid(),
    type: 'insert',
    payload: { text, afterBlockId },
    now: opts.now,
  });
}

/**
 * `prevText` is deliberately not stored: the preceding event for this block
 * already holds it, and duplicating it roughly doubles the log (ADR-0012).
 * The corpus exporter reconstructs pairs by walking [docId+blockId+seq].
 */
export async function updateBlock(
  db: EzhuthuDB,
  docId: DocId,
  blockId: BlockId,
  text: string,
  opts: { now?: number } = {},
): Promise<BlockEvent> {
  return appendEvent(db, {
    docId,
    blockId,
    type: 'update',
    payload: { text },
    now: opts.now,
  });
}

/**
 * Soft delete. The full text goes into the payload — this is the one place
 * ADR-0012's omission rule does not apply, because ghost-marker restore reads
 * it directly and a deletion is the event we can least afford to lose.
 *
 * `mergedInto` marks the deletion as the second half of a merge (ADR-0028): the
 * text survives in that block, so this deletion must not leave a restorable
 * ghost. A deliberate delete omits it, and that is what a ghost marker shows.
 */
export async function deleteBlock(
  db: EzhuthuDB,
  docId: DocId,
  blockId: BlockId,
  opts: { now?: number; mergedInto?: BlockId } = {},
): Promise<BlockEvent> {
  const block = await db.blocks.get(blockId);
  if (block === undefined) throw new Error(`delete: unknown block ${blockId}`);
  return appendEvent(db, {
    docId,
    blockId,
    type: 'delete',
    payload: { text: block.text, mergedInto: opts.mergedInto },
    now: opts.now,
  });
}

/** Restore a soft-deleted block — an `insert` naming an existing block (ADR-0018). */
export async function restoreBlock(
  db: EzhuthuDB,
  docId: DocId,
  blockId: BlockId,
  afterBlockId?: BlockId | null,
  opts: { now?: number } = {},
): Promise<BlockEvent> {
  return appendEvent(db, {
    docId,
    blockId,
    type: 'insert',
    payload: { afterBlockId },
    now: opts.now,
  });
}

export async function moveBlock(
  db: EzhuthuDB,
  docId: DocId,
  blockId: BlockId,
  afterBlockId: BlockId | null,
  opts: { now?: number } = {},
): Promise<BlockEvent> {
  return appendEvent(db, {
    docId,
    blockId,
    type: 'move',
    payload: { afterBlockId },
    now: opts.now,
  });
}
