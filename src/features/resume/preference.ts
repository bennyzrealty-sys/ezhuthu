/**
 * Learned preference for the resume strip (ADR-0023).
 *
 * The brief asked for the strip to reorder itself by what the writer picks most.
 * ADR-0023 refused: reordering a four-item strip on a small sample moves the
 * target under a thumb that had just learned where it was, and it does so on
 * the most frequent interaction in the app. The learning still happens — it is
 * expressed as **which destination is the default**, not as where the buttons
 * are.
 *
 * Counts live in `settings`, which is the store for things that are neither
 * document data nor telemetry. They are not signals: a pick is an explicit
 * choice, not an observation, and it must survive the 90-day signal prune.
 */

import type { EzhuthuDB } from '../../db/schema';
import { RESUME_ORDER, type ResumeKind } from './destinations';

export const PICKS_KEY = 'resume.picks';

/**
 * Picks required before any destination is emphasised (ADR-0023).
 *
 * Below this the "favourite" is noise — two picks can make a destination look
 * like a habit — and an emphasis that moves every launch is worse than none.
 */
export const MIN_PICKS_FOR_DEFAULT = 5;

export type PickCounts = Partial<Record<ResumeKind, number>>;

export interface Preference {
  counts: PickCounts;
  total: number;
  /** The pre-selected destination, or null until the floor is cleared. */
  favourite: ResumeKind | null;
}

function isKind(value: string): value is ResumeKind {
  return (RESUME_ORDER as readonly string[]).includes(value);
}

/** Reads defensively: this is persisted state a future version may have changed. */
function parse(value: unknown): PickCounts {
  if (typeof value !== 'object' || value === null) return {};
  const counts: PickCounts = {};
  for (const [key, count] of Object.entries(value as Record<string, unknown>)) {
    if (isKind(key) && typeof count === 'number' && Number.isFinite(count) && count > 0) {
      counts[key] = Math.floor(count);
    }
  }
  return counts;
}

export function favouriteOf(counts: PickCounts): ResumeKind | null {
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  if (total < MIN_PICKS_FOR_DEFAULT) return null;

  // Ties break by the fixed order rather than by recency, so that a dead heat
  // does not make the default oscillate between launches — which is the exact
  // instability ADR-0023 exists to avoid, one level down.
  let best: ResumeKind | null = null;
  for (const kind of RESUME_ORDER) {
    const count = counts[kind] ?? 0;
    if (count > 0 && (best === null || count > (counts[best] ?? 0))) best = kind;
  }
  return best;
}

export async function loadPreference(db: EzhuthuDB): Promise<Preference> {
  const setting = await db.settings.get(PICKS_KEY);
  const counts = parse(setting?.value);
  return {
    counts,
    total: Object.values(counts).reduce((sum, n) => sum + n, 0),
    favourite: favouriteOf(counts),
  };
}

/**
 * Record one pick and return the preference as it now stands.
 *
 * Read-modify-write inside a transaction: two tabs both resuming at once is
 * unlikely and losing a count would be harmless, but the same shape outside a
 * transaction is the race ADR-0020 exists to prevent, and there is no reason to
 * write the sloppy version of it.
 */
export async function recordPick(db: EzhuthuDB, kind: ResumeKind): Promise<Preference> {
  return db.transaction('rw', db.settings, async () => {
    const setting = await db.settings.get(PICKS_KEY);
    const counts = parse(setting?.value);
    counts[kind] = (counts[kind] ?? 0) + 1;
    await db.settings.put({ key: PICKS_KEY, value: counts });
    return {
      counts,
      total: Object.values(counts).reduce((sum, n) => sum + n, 0),
      favourite: favouriteOf(counts),
    };
  });
}
