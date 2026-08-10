/**
 * Every threshold the corpus export has, in one module — the same arrangement
 * as `signals/constants.ts`, and for the same reason.
 *
 * ADR-0012 is explicit that these are export-time filters over an intact log:
 * nothing is discarded from storage, so changing a number here and re-running
 * the export produces a different corpus over the same history. That is the
 * whole point of compacting at export rather than on write, and it is why
 * these being guesses is acceptable in a way that a lossy write path would not
 * be.
 */

/**
 * Consecutive revisions of one block, in one session, no further apart than
 * this, are one act of revision (ADR-0012).
 *
 * The gap is measured between consecutive revisions, not across the whole run:
 * twenty minutes spent working over one paragraph is one revision, and picking
 * it up again after lunch is another. The editor commits on a 400 ms cadence,
 * so without this a single reworked sentence arrives as forty pairs that differ
 * by one character each — an artefact of our autosave, not forty decisions.
 */
export const COALESCE_WINDOW_MS = 5 * 60 * 1000;

/**
 * A change of at most this many grapheme clusters is a typo correction, not
 * style. Measured on the folded form, so re-encoding costs nothing (Rule 5).
 */
export const TRIVIAL_MAX_CLUSTERS = 1;

/**
 * Below this fraction of the paragraph changed — *and* with no word added or
 * removed — the pair is a correction rather than a rewrite.
 *
 * Both halves are needed. The fraction alone would drop a paragraph rewritten
 * one clause at a time; the word-boundary test alone would keep every accent
 * fix, since correcting a vowel sign adds and removes no words at all.
 *
 * Note what this measures is proportional, so the same edit is judged
 * differently in a sentence than in a page: one word swapped in a short
 * paragraph survives and the same swap inside a very long one does not. That is
 * deliberate — a corpus of sentence-level revision is what ADR-0016 is after —
 * but it is the threshold here with the least evidence behind it, and it has
 * never been run against a real manuscript.
 */
export const TRIVIAL_MAX_RATIO = 0.05;

/**
 * Cutoff handed to the distance function. Anything past it is a real change and
 * the exact figure is never used, so measuring it would be work spent to reach
 * the same verdict.
 */
export const DISTANCE_CUTOFF_CLUSTERS = 64;
