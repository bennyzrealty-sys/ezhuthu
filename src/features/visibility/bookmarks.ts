/**
 * Scroll-back auto-bookmarks (docs/SIGNALS.md, ADR-0018's cousin in Phase 6).
 *
 * Phase 4 records a `scrollback` signal whenever the writer scrolls up and
 * settles: the pattern of going back to check a reference — a character's name,
 * a fact established fifty pages ago. Nobody asked to bookmark those places, but
 * the returning IS the bookmark. This surfaces them.
 *
 * Ranked by how *often* a block was returned to, then by how long — a paragraph
 * checked ten times briefly is a stronger reference than one dwelled on once
 * (ADR-0017's spirit: attention, not pixels). Deleted blocks are dropped: a
 * bookmark to a paragraph that no longer exists is worse than none. Time is a
 * parameter, and nothing is stored — it is a query over the signal already
 * there, like every destination of the resume strip.
 */

import type { EzhuthuDB } from '../../db/schema';
import type { Block, DocId } from '../../db/types';
import { preview } from '../../text/segmenter';
import { aggregateByBlock } from '../../signals/queries';

/** Clusters of block text shown per bookmark — enough to recognise the place. */
const EXCERPT_CLUSTERS = 48;

export interface Bookmark {
  blockId: string;
  /** Cluster-safe preview — never `slice(0, n)` on Malayalam. */
  excerpt: string;
  /** How many times the writer scrolled back and settled here. */
  returns: number;
  /** Human-readable, in the bookmark's own terms. */
  detail: string;
}

export interface BookmarkOptions {
  /** Epoch ms. Only the last N days are considered "recent". */
  now?: number;
  /** How far back to look. */
  windowDays?: number;
  limit?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The blocks the writer keeps returning to, most-returned first.
 *
 * A window, like "most rewritten": a reference checked constantly last month is
 * not necessarily what is being written now, and an unbounded list of bookmarks
 * is a list nobody reads.
 */
export async function resolveBookmarks(
  db: EzhuthuDB,
  docId: DocId,
  options: BookmarkOptions = {},
): Promise<Bookmark[]> {
  const now = options.now ?? Date.now();
  const windowDays = options.windowDays ?? 30;
  const limit = options.limit ?? 6;

  const agg = await aggregateByBlock(db, docId, 'scrollback', {
    since: now - windowDays * DAY_MS,
  });
  if (agg.size === 0) return [];

  const blocks = (await db.blocks.bulkGet([...agg.keys()])).filter(
    (b): b is Block => b !== undefined && b.deletedAt === undefined,
  );

  return blocks
    .map((block) => ({ block, ...agg.get(block.blockId)! }))
    // Count first, then total dwell, then document order for a stable tiebreak.
    // `order` is a STRING, compared lexicographically (ADR-0007).
    .sort(
      (a, b) =>
        b.count - a.count ||
        b.total - a.total ||
        (a.block.order < b.block.order ? -1 : a.block.order > b.block.order ? 1 : 0),
    )
    .slice(0, limit)
    .map(({ block, count }) => ({
      blockId: block.blockId,
      excerpt: preview(block.text, EXCERPT_CLUSTERS),
      returns: count,
      detail: count === 1 ? 'returned to once' : `returned to ${count} times`,
    }));
}
