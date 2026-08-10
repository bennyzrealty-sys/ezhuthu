/**
 * The fold. This is the single definition of what an event MEANS.
 *
 * Both write paths use it: incrementally when appending one event, and in
 * batch when replaying. Because they share this function, "the projection
 * drifted from the log" is not a class of bug that can exist — and
 * tests/unit/fold.test.ts asserts exactly that equivalence over randomised
 * sequences.
 *
 * PURE. No Dexie, no React, no DOM, no Date.now(). Everything comes from the
 * event. This is what lets replay run in a Worker (ADR-0009).
 *
 * On mutation: applyEvent mutates the state it is given and returns it, rather
 * than producing a new object. Replaying 200,000 events with structural
 * sharing would allocate far more than the memory budget allows. Callers that
 * need isolation call cloneState() first.
 */

import type { Block, BlockEvent, BlockId, DocId, DocState } from '../db/types';
import { generateKeyBetween } from './order';

export function emptyState(docId: DocId): DocState {
  return { docId, blocks: new Map(), order: [], seq: 0 };
}

export function cloneState(state: DocState): DocState {
  return {
    docId: state.docId,
    blocks: new Map([...state.blocks].map(([id, b]) => [id, { ...b, meta: { ...b.meta } }])),
    order: [...state.order],
    seq: state.seq,
  };
}

/** Blocks in document order, soft-deleted ones excluded. The only way to read for render. */
export function visibleBlocks(state: DocState): Block[] {
  const out: Block[] = [];
  for (const id of state.order) {
    const b = state.blocks.get(id);
    if (b && b.deletedAt === undefined) out.push(b);
  }
  return out;
}

/** Blocks in document order, including soft-deleted. For export and ghost markers. */
export function allBlocksInOrder(state: DocState): Block[] {
  const out: Block[] = [];
  for (const id of state.order) {
    const b = state.blocks.get(id);
    if (b) out.push(b);
  }
  return out;
}

/** Index in `state.order` at which a block with this order key belongs. */
function lowerBound(state: DocState, orderKey: string): number {
  let lo = 0;
  let hi = state.order.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const other = state.blocks.get(state.order[mid]!);
    if (other !== undefined && other.order < orderKey) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function insertIntoOrder(state: DocState, blockId: BlockId, orderKey: string): void {
  state.order.splice(lowerBound(state, orderKey), 0, blockId);
}

function removeFromOrder(state: DocState, blockId: BlockId): void {
  const i = state.order.indexOf(blockId);
  if (i >= 0) state.order.splice(i, 1);
}

/**
 * Resolve an `afterBlockId` intent to a concrete order key (ADR-0007).
 *
 *   null       → first in document
 *   undefined  → append at end
 *   a blockId  → immediately after that block
 *
 * Deterministic given the same state, which is why replay reproduces identical
 * keys and why the event stores intent rather than the resolved key.
 */
function resolveOrderKey(
  state: DocState,
  afterBlockId: BlockId | null | undefined,
  excluding?: BlockId,
): string {
  const positions = excluding ? state.order.filter((id) => id !== excluding) : state.order;

  const keyAt = (i: number): string | null => {
    const id = positions[i];
    if (id === undefined) return null;
    return state.blocks.get(id)?.order ?? null;
  };

  if (afterBlockId === null) {
    return generateKeyBetween(null, keyAt(0));
  }
  if (afterBlockId === undefined) {
    return generateKeyBetween(keyAt(positions.length - 1), null);
  }
  const idx = positions.indexOf(afterBlockId);
  if (idx === -1) {
    throw new Error(
      `fold: afterBlockId ${afterBlockId} not found in document ${state.docId} — corrupt log`,
    );
  }
  return generateKeyBetween(keyAt(idx), keyAt(idx + 1));
}

/**
 * Apply one event. Mutates and returns `state`.
 *
 * Throws on events that cannot be meaningful (updating a block that does not
 * exist, inserting a blockId that is already live). These indicate a corrupt
 * log, and failing loudly beats silently producing a wrong document.
 */
export function applyEvent(state: DocState, event: BlockEvent): DocState {
  if (event.docId !== state.docId) {
    throw new Error(`fold: event for doc ${event.docId} applied to state for ${state.docId}`);
  }

  switch (event.type) {
    case 'insert': {
      const existing = state.blocks.get(event.blockId);

      // An insert naming an existing, soft-deleted block is a RESTORE
      // (ADR-0018). This is how ghost markers bring text back without needing
      // a fifth event type.
      if (existing !== undefined) {
        if (existing.deletedAt === undefined) {
          throw new Error(`fold: duplicate insert for live block ${event.blockId}`);
        }
        // On restore, an absent `afterBlockId` means "put it back where it
        // was" — the block kept its order key through the soft delete, so the
        // text returns to the seam it left (ADR-0018). An explicit
        // afterBlockId (including null) repositions instead.
        //
        // Note this differs from a fresh insert, where absent means "append at
        // end". Each is the useful default for its case.
        const orderKey =
          event.payload.afterBlockId === undefined
            ? existing.order
            : resolveOrderKey(state, event.payload.afterBlockId, event.blockId);
        removeFromOrder(state, event.blockId);
        existing.deletedAt = undefined;
        existing.order = orderKey;
        existing.updatedAt = event.ts;
        if (event.payload.text !== undefined) existing.text = event.payload.text;
        insertIntoOrder(state, event.blockId, orderKey);
        break;
      }

      const orderKey = resolveOrderKey(state, event.payload.afterBlockId);
      const block: Block = {
        blockId: event.blockId,
        docId: event.docId,
        order: orderKey,
        text: event.payload.text ?? '',
        createdAt: event.ts,
        updatedAt: event.ts,
        revisionCount: 0,
        meta: {},
      };
      state.blocks.set(event.blockId, block);
      insertIntoOrder(state, event.blockId, orderKey);
      break;
    }

    case 'update': {
      const block = state.blocks.get(event.blockId);
      if (block === undefined) {
        throw new Error(`fold: update for unknown block ${event.blockId} — corrupt log`);
      }
      block.text = event.payload.text ?? '';
      block.updatedAt = event.ts;
      block.revisionCount += 1;
      break;
    }

    case 'delete': {
      const block = state.blocks.get(event.blockId);
      if (block === undefined) {
        throw new Error(`fold: delete for unknown block ${event.blockId} — corrupt log`);
      }
      // Soft delete. Record and text stay, position stays (ADR-0018).
      block.deletedAt = event.ts;
      block.updatedAt = event.ts;
      // A merge records where its text went, so ghost markers can tell a merge
      // apart from a deliberate deletion and not offer to restore text that is
      // already living in the neighbour (ADR-0028).
      if (event.payload.mergedInto !== undefined) {
        block.meta.mergedInto = event.payload.mergedInto;
      }
      break;
    }

    case 'move': {
      const block = state.blocks.get(event.blockId);
      if (block === undefined) {
        throw new Error(`fold: move for unknown block ${event.blockId} — corrupt log`);
      }
      removeFromOrder(state, event.blockId);
      const orderKey = resolveOrderKey(state, event.payload.afterBlockId, event.blockId);
      block.order = orderKey;
      block.updatedAt = event.ts;
      insertIntoOrder(state, event.blockId, orderKey);
      break;
    }
  }

  if (event.seq > state.seq) state.seq = event.seq;
  return state;
}

/** Fold a batch. Events must already be sorted by compareEvents. */
export function foldEvents(state: DocState, events: readonly BlockEvent[]): DocState {
  for (const event of events) applyEvent(state, event);
  return state;
}
