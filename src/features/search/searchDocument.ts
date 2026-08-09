/**
 * Search the document, one block at a time (ADR-0015).
 *
 * The DOM holds ~12 of 1,563 blocks, so browser find-in-page and anything
 * built on it are not a partial solution to finding text in this document —
 * they are the wrong solution, structurally incapable of seeing 99% of it.
 * This walks the `blocks` store instead, so it works identically regardless of
 * where the reader has scrolled to.
 *
 * It is a cursor, not a `toArray()`. The whole point of the virtualiser is
 * that the document is never resident; pulling every block into an array to
 * filter it would undo that in a single call, and at 100,000 words it is the
 * memory budget outright.
 */

import type { EzhuthuDB } from '../../db/schema';
import type { BlockId, DocId, OrderKey } from '../../db/types';
import {
  compileQuery,
  countMatches,
  excerptAround,
  findMatches,
  hasMatch,
  type CompiledQuery,
  type Excerpt,
  type Match,
  type SearchQuery,
} from '../../text/search';

export interface SearchHit {
  blockId: BlockId;
  order: OrderKey;
  /**
   * Position among the document's live blocks, in reading order. This is what
   * the virtualiser scrolls to — it indexes by position, not by id.
   */
  position: number;
  /** Matches within this block, in document order. */
  matches: Match[];
  /** Text around the first match, for the result row. */
  excerpt: Excerpt;
}

export interface SearchOutcome {
  hits: SearchHit[];
  /** Matches across the whole document, including any past the hit limit. */
  matchCount: number;
  /** Live blocks examined. Equal to the document's block count when complete. */
  blocksScanned: number;
  /** More blocks matched than `limit`; `matchCount` still counts them all. */
  truncated: boolean;
  /**
   * The scan was cancelled part-way, so every field above describes a prefix
   * of the document. Callers must discard rather than display it — a partial
   * scan rendered as a finished one silently under-reports.
   */
  aborted: boolean;
}

export interface SearchOptions extends SearchQuery {
  /**
   * Maximum blocks reported. A search for "ഒരു" in a manuscript legitimately
   * matches a thousand paragraphs, and rendering a thousand rows is slower and
   * less useful than rendering the first hundred.
   */
  limit?: number;
  /** Clusters of context either side of the match in the excerpt. */
  excerptRadius?: number;
  /** Abort an in-flight search when the query changes under it. */
  signal?: AbortSignal;
}

const DEFAULT_LIMIT = 100;

export const EMPTY_OUTCOME: SearchOutcome = {
  hits: [],
  matchCount: 0,
  blocksScanned: 0,
  truncated: false,
  aborted: false,
};

export async function searchDocument(
  db: EzhuthuDB,
  docId: DocId,
  options: SearchOptions,
): Promise<SearchOutcome> {
  const query = compileQuery(options);
  if (query === null) return EMPTY_OUTCOME;

  const limit = options.limit ?? DEFAULT_LIMIT;
  const radius = options.excerptRadius;

  const hits: SearchHit[] = [];
  let matchCount = 0;
  let blocksScanned = 0;
  let position = 0;
  let truncated = false;

  const aborted = () => options.signal?.aborted === true;

  await db.blocks
    .where('[docId+order]')
    // '￿' as the upper bound: Block.order is a string compared
    // lexicographically (ADR-0007), so this is "every order key for this doc".
    .between([docId, ''], [docId, '￿'])
    // `until` is how a Dexie cursor stops early. Throwing out of the `each`
    // callback does not: the iteration is already scheduled, so the callback
    // still runs for every remaining record and only the returned promise
    // rejects — which is scanning the whole document and then reporting a
    // failure, the worst of both.
    .until(aborted)
    .each((block) => {
      // Soft-deleted blocks keep their record and their text so a restore can
      // put them back (ADR-0018). They are not in the document, so they are
      // not in its search results either — and they must not advance
      // `position`, which counts the same live blocks the virtualiser renders.
      if (block.deletedAt !== undefined) return;

      const at = position;
      position += 1;
      blocksScanned += 1;

      // The cheap test first: it folds the text but builds no offset map, and
      // on any real query the overwhelming majority of blocks fail it.
      if (!hasMatch(block.text, query)) return;

      if (hits.length >= limit) {
        // Keep counting past the limit. Capping what is rendered must not make
        // the total under-report, or the count is a lie about the document.
        matchCount += countMatches(block.text, query);
        truncated = true;
        return;
      }

      const matches = findMatches(block.text, query);
      matchCount += matches.length;
      hits.push({
        blockId: block.blockId,
        order: block.order,
        position: at,
        matches,
        excerpt: excerptAround(block.text, matches[0]!, radius),
      });
    });

  return { hits, matchCount, blocksScanned, truncated, aborted: aborted() };
}

/**
 * Every match in the document, flattened — hit 1 of 47 and so on.
 *
 * Kept separate from `searchDocument` rather than folded into it because the
 * result list wants blocks and next/previous wants matches, and conflating the
 * two makes "47 results" ambiguous about what it is counting.
 */
export function flattenMatches(hits: SearchHit[]): Array<{ hit: SearchHit; match: Match }> {
  return hits.flatMap((hit) => hit.matches.map((match) => ({ hit, match })));
}

export type { CompiledQuery, Excerpt, Match };
