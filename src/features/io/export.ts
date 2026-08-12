/**
 * Downloading the document itself.
 *
 * This is the plain answer to "give me my writing as a file", and until it was
 * asked for on a phone it did not exist. What did exist was a backup (the
 * whole event log as JSON — a restore file, not something anyone reads) and
 * the corpus (revision pairs as JSONL, and deliberately *empty* for a document
 * that has only been written, never revised — ADR-0030). Both are exports of
 * how the writing happened. Neither is the writing.
 *
 * The output is the exact input format `import.ts` accepts: paragraphs
 * separated by blank lines. `joinBlocks` is the documented inverse of
 * `splitIntoBlocks`, so a document exported and re-imported comes back
 * paragraph for paragraph and byte for byte — text is never normalised on
 * either leg (ADR-0014), which is what makes that true of Malayalam rather
 * than only of ASCII.
 */

import type { EzhuthuDB } from '../../db/schema';
import type { DocId } from '../../db/types';
import { downloadText, fileNameStem } from '../../ui/download';
import { joinBlocks } from './import';

export interface DocumentExport {
  text: string;
  blocks: number;
  characters: number;
}

/**
 * Read every live paragraph in document order and join it.
 *
 * Ordered by the `[docId+order]` index, which is the same lexicographic string
 * order the virtualiser reads (ADR-0007) — never a numeric sort, and never the
 * insertion order of the log. Soft-deleted blocks are skipped: a deletion the
 * writer made is not part of the manuscript, and it remains recoverable from
 * the log and from its ghost marker either way (ADR-0018).
 *
 * The whole document does pass through memory here, which the rule against
 * holding all block text (CLAUDE.md, docs/PERFORMANCE.md) otherwise forbids —
 * it is about the rendering and index paths, where the cost is paid on every
 * scroll. This is a deliberate one-shot batch, like import and the corpus
 * export, and it is bounded by the document rather than by history: 100k words
 * of Malayalam is on the order of a megabyte.
 */
export async function exportDocument(db: EzhuthuDB, docId: DocId): Promise<DocumentExport> {
  const texts: string[] = [];

  await db.blocks
    .where('[docId+order]')
    .between([docId, ''], [docId, '￿'])
    .each((block) => {
      if (block.deletedAt === undefined) texts.push(block.text);
    });

  const text = texts.length === 0 ? '' : joinBlocks(texts);
  return { text, blocks: texts.length, characters: text.length };
}

/**
 * ASCII, with the timestamp carrying the identity — the `download` attribute
 * discards a non-ASCII value whole and the file arrives called `download`
 * (ADR-0031). The Malayalam title is inside the file; the name is how the
 * writer tells two of them apart on a phone's Downloads screen.
 */
export function documentFilename(title: string, now: number): string {
  const stamp = new Date(now).toISOString().slice(0, 19).replaceAll(':', '-');
  const stem = fileNameStem(title);
  return stem === '' ? `ezhuthu-${stamp}.txt` : `ezhuthu-${stem}-${stamp}.txt`;
}

export function downloadDocument(filename: string, text: string): void {
  // charset=utf-8 is not decoration: without it a phone's viewer may guess
  // Latin-1 at a file that is entirely Malayalam.
  downloadText(filename, text, 'text/plain;charset=utf-8');
}
