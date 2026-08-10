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
 * A word that changed by at most this much did not become a different word — it
 * became a correctly spelled version of the same one (ADR-0032).
 *
 * This is measured on the WORD, not on the paragraph, and the difference is the
 * whole point. A proportional threshold cannot separate a typo from a word
 * choice, because both are small next to the paragraph containing them: in real
 * Malayalam prose — 116 paragraphs of a narration script, averaging 145 grapheme
 * clusters — fixing അയാൾ and replacing കപ്പൽ with നൗക come out at 0.7% and 2.1%
 * of the paragraph. Any cutoff that drops the first drops the second, and the
 * second is exactly what ADR-0016 exists to collect.
 *
 * At the word, they are 1 cluster apart and 3 apart, and the question answers
 * itself.
 */
export const TRIVIAL_MAX_WORD_CLUSTERS = 1;
