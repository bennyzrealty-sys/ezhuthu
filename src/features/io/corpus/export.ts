/**
 * The edit-corpus export (ADR-0016).
 *
 * Because the log keeps every revision (ADR-0001), normal writing accumulates a
 * complete record of how this writer improves a Malayalam sentence. Editors
 * throw that away because they save documents instead of decisions. Malayalam is
 * a low-resource language and this material does not otherwise exist.
 *
 * A batch operation, and the second of the two in this phase. Cost is not the
 * constraint; being able to change the thresholds and re-run over full history
 * is, which is why every judgement lives in the pure modules beside this one and
 * this file only walks the store.
 *
 * ONE cursor, not one query per block. The `[docId+blockId+seq]` index that
 * ADR-0012 asked for orders events by block and then by seq, so a single pass
 * delivers each block's history contiguously and in order — and holds only the
 * block currently being walked. 1,563 separate range queries would produce the
 * same corpus for roughly the same reason a per-keystroke recount produces the
 * same word count.
 *
 * PRIVACY. This writes a file to the user's device and does nothing else. There
 * is no upload, no share target and no identifier in the output: the record is
 * `{before, after, ts, revisionIndex}` exactly, with no block, document or
 * device id. It is the user's asset and it leaves the device only if he moves
 * it (ADR-0016).
 */

import Dexie from 'dexie';
import type { EzhuthuDB } from '../../../db/schema';
import type { BlockEvent, BlockId, DocId } from '../../../db/types';
import { downloadText, fileNameStem } from '../../../ui/download';
import type { EditPair, OrderedEditPair } from './pairs';
import { coalesceRevisions, revisionsForBlock } from './pairs';
import { emptyTally, filterTrivial, type TrivialTally } from './triviality';

export interface CorpusStats {
  /** Blocks whose history was walked, including soft-deleted ones. */
  blocks: number;
  /** Revisions found before session coalescing. */
  revisions: number;
  /** Acts of revision after coalescing. */
  pairs: number;
  /** Pairs in the file. */
  emitted: number;
  /** What the triviality filter dropped, by reason. */
  dropped: TrivialTally;
}

export interface CorpusExport {
  jsonl: string;
  stats: CorpusStats;
}

export interface CorpusOptions {
  /** Session-coalescing window. Defaults to COALESCE_WINDOW_MS. */
  windowMs?: number;
}

/** One JSONL record, in the field order ADR-0016 documents. */
export function toJsonlLine(pair: EditPair): string {
  return JSON.stringify({
    before: pair.before,
    after: pair.after,
    ts: pair.ts,
    revisionIndex: pair.revisionIndex,
  });
}

export function toJsonl(pairs: readonly EditPair[]): string {
  return pairs.length === 0 ? '' : `${pairs.map(toJsonlLine).join('\n')}\n`;
}

/**
 * Walk the whole log for a document and build its corpus.
 *
 * Soft-deleted blocks are included. Their revisions happened, and a paragraph
 * being cut later says nothing about how it was written — the deletion itself
 * is what produces no pair (see pairs.ts).
 */
export async function exportCorpus(
  db: EzhuthuDB,
  docId: DocId,
  options: CorpusOptions = {},
): Promise<CorpusExport> {
  const stats: CorpusStats = {
    blocks: 0,
    revisions: 0,
    pairs: 0,
    emitted: 0,
    dropped: emptyTally(),
  };

  const kept: OrderedEditPair[] = [];

  // Only the block currently being walked is resident. A manuscript's whole
  // history does not fit in memory and does not need to.
  let batch: BlockEvent[] = [];
  let blockId: BlockId | null = null;

  const finishBlock = (): void => {
    if (batch.length === 0) return;
    stats.blocks += 1;

    const revisions = revisionsForBlock(batch);
    stats.revisions += revisions.length;

    const pairs = coalesceRevisions(revisions, options);
    stats.pairs += pairs.length;

    const result = filterTrivial(pairs, stats.dropped);
    kept.push(...result.kept);

    batch = [];
  };

  /*
   * Bounded with a real low key rather than `Dexie.minKey`. minKey is
   * -Infinity, which is not a valid IndexedDB key inside a compound bound —
   * `[docId, minKey, minKey]` throws DataError rather than matching everything,
   * and it does so at the store, so it fails identically in the browser and
   * under fake-indexeddb. The empty string sorts below any blockId and 0 below
   * any seq, which is what minKey was meant to express.
   */
  await db.events
    .where('[docId+blockId+seq]')
    .between([docId, '', 0], [docId, '\uffff', Dexie.maxKey])
    .each((event) => {
      if (event.blockId !== blockId) {
        finishBlock();
        blockId = event.blockId;
      }
      batch.push(event);
    });
  finishBlock();

  // Emitted in the log's own order, so the file reads as the writer's history
  // rather than as an arbitrary walk of block ids. Sorted by `(seq, deviceId)`
  // like everything else — never by `ts`, which is a wall clock (ADR-0020).
  kept.sort((a, b) => a.seq - b.seq);
  stats.emitted = kept.length;

  return { jsonl: toJsonl(kept), stats };
}

/** As with backups: the stamp identifies it, the title joins in if it can. */
export function corpusFilename(title: string, now: number): string {
  const stamp = new Date(now).toISOString().slice(0, 19).replaceAll(':', '-');
  const stem = fileNameStem(title);
  return stem === '' ? `ezhuthu-corpus-${stamp}.jsonl` : `ezhuthu-corpus-${stem}-${stamp}.jsonl`;
}

/**
 * Hand the file to the browser — the only thing the corpus does with it, and
 * the only thing it does at all beyond reading the log.
 */
export function downloadCorpus(filename: string, jsonl: string): void {
  downloadText(filename, jsonl, 'application/x-ndjson');
}
