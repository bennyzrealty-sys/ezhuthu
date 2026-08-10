/**
 * The four resume destinations (ADR-0023).
 *
 * Requirement 1 of the whole project: on open, return the writer to where he
 * was working — not to the cursor, which is wherever a thumb last landed, but
 * to where his *attention* was. Four answers, because no single one is right
 * often enough to be the only one offered:
 *
 * | Destination | Source |
 * |---|---|
 * | last edited     | the block most recently changed, from the projection |
 * | last read       | the deepest block dwelled on last session (ADR-0026) |
 * | longest dwelled | the highest gated dwell last session (ADR-0017) |
 * | most rewritten  | the highest `revisionCount` in a recent window |
 *
 * Two of the four are read from the log's projection and two from signals.
 * Nothing is stored for this feature: it is four queries over tables that
 * already exist, which is the argument ARCHITECTURE.md makes for event sourcing
 * stated as code.
 *
 * Time is a parameter throughout (CLAUDE.md rule 8).
 */

import type { EzhuthuDB } from '../../db/schema';
import type { Block, BlockId, DocId } from '../../db/types';
import { getSessionId } from '../../db/ids';
import { preview } from '../../text/segmenter';
import { totalsByBlock } from '../../signals/queries';

/**
 * How far back "most rewritten" looks.
 *
 * Without a window this destination is a monument: the paragraph that was hard
 * to write in March keeps winning in August, long after the writer stopped
 * caring about it. A guess, like the ADR-0017 constants, and revisable for the
 * same reason.
 */
export const REWRITE_WINDOW_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Clusters of block text shown on a destination, enough to recognise the place. */
const EXCERPT_CLUSTERS = 48;

export type ResumeKind = 'lastEdited' | 'lastRead' | 'longestDwelled' | 'mostRewritten';

/**
 * Fixed order (ADR-0023). Reordering by frequency moves the target under a
 * thumb that had learned where it was, on the most frequent interaction in the
 * app. Preference is expressed as the default, not as the layout.
 */
export const RESUME_ORDER: readonly ResumeKind[] = [
  'lastEdited',
  'lastRead',
  'longestDwelled',
  'mostRewritten',
] as const;

export const RESUME_LABELS: Record<ResumeKind, string> = {
  lastEdited: 'Last edited',
  lastRead: 'Last read',
  longestDwelled: 'Longest dwelled',
  mostRewritten: 'Most rewritten',
};

export interface ResumeDestination {
  kind: ResumeKind;
  blockId: BlockId;
  /** Cluster-safe preview of the block — never `slice(0, n)` on Malayalam. */
  excerpt: string;
  /** Why this block won, in the destination's own terms. */
  detail: string;
}

export interface ResolveOptions {
  /** Epoch ms. Injected so "5 minutes ago" is testable. */
  now?: number;
  /** The current session, whose signals are NOT "last session". */
  sessionId?: string;
  rewriteWindowDays?: number;
}

/**
 * Resolve every destination that has an answer.
 *
 * Runs at open, off the first-paint path — the strip appears when it has
 * something to offer, and the document is already readable behind it.
 */
export async function resolveDestinations(
  db: EzhuthuDB,
  docId: DocId,
  options: ResolveOptions = {},
): Promise<ResumeDestination[]> {
  const now = options.now ?? Date.now();
  const sessionId = options.sessionId ?? getSessionId();

  const [edited, rewritten, dwellPair] = await Promise.all([
    lastEdited(db, docId, now),
    mostRewritten(db, docId, now, options.rewriteWindowDays ?? REWRITE_WINDOW_DAYS),
    fromLastSession(db, docId, sessionId),
  ]);

  const found = new Map<ResumeKind, ResumeDestination>();
  if (edited) found.set('lastEdited', edited);
  if (rewritten) found.set('mostRewritten', rewritten);
  if (dwellPair.lastRead) found.set('lastRead', dwellPair.lastRead);
  if (dwellPair.longestDwelled) found.set('longestDwelled', dwellPair.longestDwelled);

  // Fixed order, always — the caller renders absent slots rather than closing
  // the gap, so that positions do not move between launches.
  return RESUME_ORDER.map((kind) => found.get(kind)).filter(
    (d): d is ResumeDestination => d !== undefined,
  );
}

/**
 * The most recently changed block that has actually been *edited*.
 *
 * `revisionCount > 0` is what makes this destination mean something after an
 * import: an import inserts two thousand blocks and updates none of them, so
 * without the filter "last edited" is whichever paragraph the importer happened
 * to write last — a place the writer has never been.
 *
 * Streams in reverse over `[docId+updatedAt]` and stops at the first match, so
 * the usual cost is one record.
 */
async function lastEdited(
  db: EzhuthuDB,
  docId: DocId,
  now: number,
): Promise<ResumeDestination | undefined> {
  const block = await db.blocks
    .where('[docId+updatedAt]')
    .between([docId, 0], [docId, Number.MAX_SAFE_INTEGER])
    .reverse()
    .filter((b) => b.deletedAt === undefined && b.revisionCount > 0)
    .first();

  if (block === undefined) return undefined;
  return {
    kind: 'lastEdited',
    blockId: block.blockId,
    excerpt: preview(block.text, EXCERPT_CLUSTERS),
    detail: `edited ${relativeTime(now - block.updatedAt)}`,
  };
}

/**
 * The most-revised block among those touched inside the window.
 *
 * Streamed with `each` rather than collected: the window can cover every block
 * in the document — an import touches all of them — and holding that array
 * would put the whole manuscript in memory, which is the one thing
 * docs/PERFORMANCE.md forbids outright.
 */
async function mostRewritten(
  db: EzhuthuDB,
  docId: DocId,
  now: number,
  windowDays: number,
): Promise<ResumeDestination | undefined> {
  let best: Block | undefined;

  await db.blocks
    .where('[docId+updatedAt]')
    .between([docId, now - windowDays * DAY_MS], [docId, Number.MAX_SAFE_INTEGER])
    .each((block) => {
      if (block.deletedAt !== undefined || block.revisionCount < 1) return;
      if (best === undefined || block.revisionCount > best.revisionCount) best = block;
    });

  if (best === undefined) return undefined;
  return {
    kind: 'mostRewritten',
    blockId: best.blockId,
    excerpt: preview(best.text, EXCERPT_CLUSTERS),
    detail: `${best.revisionCount} revision${best.revisionCount === 1 ? '' : 's'}`,
  };
}

interface SessionDestinations {
  lastRead?: ResumeDestination;
  longestDwelled?: ResumeDestination;
}

/**
 * The two destinations that come from last session's dwell.
 *
 * One query serves both: the same set of blocks is ranked by accrued dwell for
 * one and by document order for the other.
 */
async function fromLastSession(
  db: EzhuthuDB,
  docId: DocId,
  currentSessionId: string,
): Promise<SessionDestinations> {
  const previous = await lastSessionId(db, docId, currentSessionId);
  if (previous === undefined) return {};

  const dwell = await totalsByBlock(db, docId, 'dwell', { sessionId: previous });
  if (dwell.size === 0) return {};

  const blocks = (await db.blocks.bulkGet([...dwell.keys()])).filter(
    (b): b is Block => b !== undefined && b.deletedAt === undefined,
  );
  if (blocks.length === 0) return {};

  let deepest = blocks[0]!;
  let longest = blocks[0]!;
  for (const block of blocks) {
    // `order` is a STRING and is compared lexicographically. Comparing it
    // numerically anywhere is a bug (ADR-0007).
    if (block.order > deepest.order) deepest = block;
    if ((dwell.get(block.blockId) ?? 0) > (dwell.get(longest.blockId) ?? 0)) longest = block;
  }

  return {
    lastRead: {
      kind: 'lastRead',
      blockId: deepest.blockId,
      excerpt: preview(deepest.text, EXCERPT_CLUSTERS),
      detail: 'furthest you got last session',
    },
    longestDwelled: {
      kind: 'longestDwelled',
      blockId: longest.blockId,
      excerpt: preview(longest.text, EXCERPT_CLUSTERS),
      detail: `${duration(dwell.get(longest.blockId) ?? 0)} of attention`,
    },
  };
}

/**
 * The most recent session that is not this one.
 *
 * "Last session" cannot be "the newest sessionId in the store", because this
 * launch starts writing signals immediately and would become its own answer —
 * offering the writer the paragraph he is looking at right now.
 */
export async function lastSessionId(
  db: EzhuthuDB,
  docId: DocId,
  currentSessionId: string,
): Promise<string | undefined> {
  const row = await db.signals
    .where('[docId+ts]')
    .between([docId, 0], [docId, Number.MAX_SAFE_INTEGER])
    .reverse()
    .filter((s) => s.sessionId !== currentSessionId)
    .first();
  return row?.sessionId;
}

/** "4 min", "45 s" — attention, in units a person recognises. */
function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  return `${Math.round(minutes / 60)} h`;
}

/** "just now", "5 minutes ago", "yesterday" — never a timestamp. */
function relativeTime(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}
