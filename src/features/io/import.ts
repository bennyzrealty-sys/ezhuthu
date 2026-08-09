/**
 * Import — one of the three sanctioned whole-document writes (the others are
 * restore-from-backup and projection rebuild). Everything else appends one
 * event touching one block.
 *
 * Importing a 100,000-word manuscript through the normal append path would be
 * ~2,000 separate transactions and take minutes. This does it in one, which
 * means constructing blocks directly rather than routing each through
 * `applyEvent`.
 *
 * That is a deliberate exception, and it is load-bearing that the shortcut
 * produces EXACTLY what replaying the same events would. `generateNKeysBetween`
 * appending is defined as repeated `generateKeyBetween(previous, null)`, which
 * is precisely what the fold does for a chain of inserts — so the two agree by
 * construction, and `tests/unit/import.test.ts` asserts it against a real
 * replay rather than trusting the argument.
 */

import type { EzhuthuDB } from '../../db/schema';
import { getDeviceId, getSessionId, uuid } from '../../db/ids';
import type { Block, BlockEvent, DocId } from '../../db/types';
import { generateNKeysBetween } from '../../core/order';
import { countWords } from '../../text/count';

/**
 * Split plain text into blocks on blank lines.
 *
 * Text is NOT normalised on the way in — storage keeps the bytes that arrived,
 * so import → export stays byte-faithful (ADR-0014). Trailing whitespace
 * inside a paragraph is preserved for the same reason; only the blank-line
 * separators are consumed.
 */
export function splitIntoBlocks(text: string): string[] {
  return text
    .split(/\r?\n[ \t]*\r?\n/)
    .map((block) => block.replace(/^\r?\n+|\r?\n+$/g, ''))
    .filter((block) => block.trim() !== '');
}

/** Rejoin blocks into the same plain text. Inverse of splitIntoBlocks. */
export function joinBlocks(texts: readonly string[]): string {
  return texts.join('\n\n') + '\n';
}

export interface ImportResult {
  blocksAdded: number;
  wordsAdded: number;
  firstSeq: number;
  lastSeq: number;
}

/**
 * Append many blocks to the end of a document in one transaction.
 *
 * Events are still written — one `insert` per block, chained by
 * `afterBlockId` — so history is complete and the import is as replayable and
 * as undoable as anything typed by hand.
 */
export async function importBlocks(
  db: EzhuthuDB,
  docId: DocId,
  texts: readonly string[],
  opts: { now?: number } = {},
): Promise<ImportResult> {
  if (texts.length === 0) {
    return { blocksAdded: 0, wordsAdded: 0, firstSeq: 0, lastSeq: 0 };
  }

  const ts = opts.now ?? Date.now();
  const deviceId = getDeviceId();
  const sessionId = getSessionId();

  return db.transaction('rw', db.docs, db.events, db.blocks, async () => {
    const doc = await db.docs.get(docId);
    if (doc === undefined) throw new Error(`import: unknown document ${docId}`);

    const last = await db.blocks
      .where('[docId+order]')
      .between([docId, ''], [docId, '￿'])
      .last();

    const orderKeys = generateNKeysBetween(last?.order ?? null, null, texts.length);

    const events: BlockEvent[] = [];
    const blocks: Block[] = [];
    let seq = doc.seqCounter;
    let previousBlockId = last?.blockId;
    let wordsAdded = 0;

    for (const [i, text] of texts.entries()) {
      const blockId = uuid();
      events.push({
        id: uuid(),
        seq,
        ts,
        sessionId,
        deviceId,
        docId,
        blockId,
        type: 'insert',
        // The chain of intents a replay will follow. `undefined` for the first
        // when the document was empty, meaning "append at end".
        payload: { text, afterBlockId: previousBlockId },
      });
      blocks.push({
        blockId,
        docId,
        order: orderKeys[i]!,
        text,
        createdAt: ts,
        updatedAt: ts,
        revisionCount: 0,
        meta: {},
      });
      wordsAdded += countWords(text);
      previousBlockId = blockId;
      seq += 1;
    }

    await db.events.bulkAdd(events);
    await db.blocks.bulkAdd(blocks);

    const lastSeq = seq - 1;
    await db.docs.update(docId, {
      seqCounter: seq,
      lastAppliedSeq: lastSeq,
      updatedAt: ts,
      blockCount: doc.blockCount + blocks.length,
      wordCount: doc.wordCount + wordsAdded,
    });

    return {
      blocksAdded: blocks.length,
      wordsAdded,
      firstSeq: events[0]!.seq,
      lastSeq,
    };
  });
}

/** Convenience: split plain text and import it. */
export async function importText(
  db: EzhuthuDB,
  docId: DocId,
  text: string,
  opts: { now?: number } = {},
): Promise<ImportResult> {
  return importBlocks(db, docId, splitIntoBlocks(text), opts);
}
