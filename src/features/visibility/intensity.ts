/**
 * Edit intensity — the value behind the margin bar (ADR-0005) and the minimap
 * shading (ADR-0021). PURE: time is a parameter, there is no clock inside, and
 * no value it produces is ever stored (ADR-0006, CLAUDE.md rule 8).
 *
 * Two independent visual dimensions, packed into 4 px of horizontal space:
 *
 *   opacity     ← recency of the last edit, decayed in bands (ADR-0006)
 *   saturation  ← how many times the block has been revised (ADR-0005)
 *
 * Both are read from data the log already maintains — `updatedAt` and
 * `revisionCount` on the projection — so, like every other visibility feature,
 * this stores nothing of its own. Colour-blind safety comes free: the signal is
 * opacity and saturation of one hue, never hue itself.
 *
 * **The bar marks editing, not arrival.** A block with `revisionCount === 0`
 * gets no mark at all, even moments after an import set its `updatedAt` to now.
 * This is the same distinction the "last edited" resume destination draws with
 * the same filter (ADR-0027): an import writes two thousand blocks and edits
 * none of them, and lighting the whole document the instant it is brought in
 * says nothing about where the writer worked. The mark appears the first time a
 * block is actually revised.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/**
 * Recency bands (ADR-0006). Banded rather than a continuous exponential because
 * the bands map to how the writer thinks about his own work — "this session",
 * "today", "this week" — and because a handful of discrete values is far easier
 * to reason about and to test than a curve.
 *
 * Ordered nearest-first; the first band whose ceiling the age is under wins.
 * Anything past the last band has decayed to nothing, and a document reopened
 * after a month shows a clean slate, which is the point of decaying at all.
 */
const RECENCY_BANDS: readonly { readonly maxAge: number; readonly opacity: number }[] = [
  { maxAge: HOUR_MS, opacity: 1 },
  { maxAge: DAY_MS, opacity: 0.6 },
  { maxAge: WEEK_MS, opacity: 0.25 },
] as const;

/**
 * Revisions at which saturation reaches one half. The curve saturates rather
 * than clamping, so a paragraph revised forty times (ADR-0012 notes this is
 * ordinary for one fought over) still reads as more worked than one revised
 * eight times, without either pinning flat at full.
 */
export const SATURATION_HALF_AT = 4;

export interface Intensity {
  /** 0–1. Recency of the last edit, decayed. Never 0 here — see `markIntensity`. */
  opacity: number;
  /** 0–1. How many times the block was revised. */
  saturation: number;
}

export interface IntensityInput {
  /** Epoch ms of the last change to the block. */
  updatedAt: number;
  /** Count of `update` events (ADR-0012), maintained by the fold. */
  revisionCount: number;
}

/**
 * Opacity for an edit `age` ms old. Ages at or below zero — a clock that ran
 * backwards, `updatedAt` in the future — fall into the freshest band, which is
 * the safe direction to round: a bar that is briefly too bright is a smaller
 * error than one that vanishes.
 */
export function recencyOpacity(age: number): number {
  for (const band of RECENCY_BANDS) {
    if (age < band.maxAge) return band.opacity;
  }
  return 0;
}

/**
 * Saturation for a revision count. Monotonic, 0 at zero revisions, approaching
 * 1 without reaching it.
 */
export function revisionSaturation(revisionCount: number): number {
  if (revisionCount <= 0) return 0;
  return 1 - 1 / (1 + revisionCount / SATURATION_HALF_AT);
}

/**
 * The mark for one block, or `null` when there is nothing to draw — either the
 * block has never been revised, or its last edit has decayed out of the last
 * band. Returning `null` rather than a zero-opacity `Intensity` keeps every
 * caller from having to re-decide "is this worth a bar": the margin bar renders
 * nothing, and the minimap scores it zero.
 */
export function markIntensity(input: IntensityInput, now: number): Intensity | null {
  if (input.revisionCount <= 0) return null;
  const opacity = recencyOpacity(now - input.updatedAt);
  if (opacity <= 0) return null;
  return { opacity, saturation: revisionSaturation(input.revisionCount) };
}

/**
 * Collapse a mark to one scalar for ranking and for the minimap's per-bucket
 * maximum (ADR-0021). Recency dominates — the minimap answers "is there
 * anything recent here I should look at" — and revision depth refines the tie.
 * A weighting, not a measurement, in the sense of `centreWeight`.
 */
export function intensityScore(intensity: Intensity | null): number {
  if (intensity === null) return 0;
  return intensity.opacity * (0.6 + 0.4 * intensity.saturation);
}
