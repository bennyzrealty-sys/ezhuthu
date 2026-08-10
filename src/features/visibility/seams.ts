/**
 * Where the ghost markers go (ADR-0018). PURE — a function of the ordered block
 * list, no DOM, no database.
 *
 * A deletion leaves nothing to mark: the block is gone, so there is no margin
 * beside it to shade. The seam is the discovery mechanism — a thin marker at the
 * join where blocks were removed — and it is the whole feature, because deleted
 * text is recoverable from the log in principle but a writer would never know to
 * go looking for it.
 *
 * This walks the document in order (soft-deleted blocks included, which is why
 * they keep their position in the fold) and attaches each run of deleted blocks
 * to the live block that follows it — or, past the last live block, to a
 * trailing seam. Consecutive deletions collapse into one seam (ADR-0018):
 * three paragraphs cut at once is one join, not three markers.
 *
 * A merge is not a deletion and leaves no seam (ADR-0028). Its text lives on in
 * the neighbour it merged into, so a ghost of it would offer to restore text the
 * reader can already see, and restoring would duplicate it.
 */

export interface OrderedBlock {
  blockId: string;
  /** Soft-deleted: has a `deletedAt`. */
  deleted: boolean;
  /** Deleted as the second half of a merge (`meta.mergedInto` set). Not a ghost. */
  merged: boolean;
  /** Character length, for the seam's "N paragraphs" summary without loading text. */
  length: number;
}

export interface Ghost {
  blockId: string;
  length: number;
}

export interface Seams {
  /** Ghosts sitting immediately before a live block, keyed by that block's id. */
  before: Map<string, Ghost[]>;
  /** Ghosts past the last live block — a deletion at the very end. */
  trailing: Ghost[];
}

export function computeSeams(blocks: readonly OrderedBlock[]): Seams {
  const before = new Map<string, Ghost[]>();
  let run: Ghost[] = [];

  for (const block of blocks) {
    if (block.deleted) {
      // A merge is invisible here; it neither shows nor breaks a run, so two
      // deletions with a merge between them still collapse to one seam.
      if (block.merged) continue;
      run.push({ blockId: block.blockId, length: block.length });
      continue;
    }
    if (run.length > 0) {
      before.set(block.blockId, run);
      run = [];
    }
  }

  return { before, trailing: run };
}
