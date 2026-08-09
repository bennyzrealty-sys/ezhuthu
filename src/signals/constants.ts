/**
 * Every tunable the attention model and the signal collector have, in one
 * module.
 *
 * ADR-0017 is explicit that the idle cutoff and the settle threshold are
 * guesses, and that revisiting them after real use is expected. They are here
 * rather than scattered across the collector so that revisiting them is a diff
 * to one file — and so that a reader can see the whole model's shape at once.
 *
 * None of these are user-visible settings. If one becomes one, it moves to
 * `settings` and this module keeps the default.
 */

/**
 * No keystroke, scroll or touch for this long stops dwell accrual for every
 * block (ADR-0017 gate 2). A phone face-up on a desk therefore banks at most
 * this much dwell after the writer walks away, instead of banking all night.
 *
 * A guess. Too short and a slow reader of a hard paragraph is treated as
 * absent; too long and the interruption still wins the resume strip.
 */
export const IDLE_CUTOFF_MS = 60_000;

/**
 * A block accrues nothing until it has been on screen this long (ADR-0017
 * gate 4). This is what separates scrolling-as-searching, where fifty blocks
 * cross the viewport in a second, from scrolling-as-reading.
 *
 * A guess, and the one most likely to be wrong: it is also the resolution at
 * which a fast reader's genuine attention starts being discarded.
 */
export const SETTLE_MS = 1_000;

/**
 * How often the collector samples what is on screen.
 *
 * Accrual is computed from timestamps, not tick counts, so this sets the
 * resolution of the model rather than its accuracy: a block half-way through
 * settling at a sample boundary accrues exactly the settled part. Sampling
 * costs one `querySelectorAll` and a rect per rendered row — a dozen of them,
 * because the document is virtualised — and never runs on the typing path.
 */
export const SAMPLE_INTERVAL_MS = 1_000;

/** Queued signals are written every this often, or on `visibilitychange`. */
export const FLUSH_INTERVAL_MS = 2_000;

/**
 * Upper bound on distinct queued entries between flushes. Entries coalesce by
 * (kind, block), so reaching this means a thousand distinct blocks were touched
 * inside two seconds — which is a bug, not a writer. Past it, new keys are
 * dropped and counted rather than allowed to grow: signals are non-critical and
 * the queue must never become the thing that runs the phone out of memory.
 */
export const MAX_QUEUED_SIGNALS = 1_000;

/**
 * Inter-keystroke gaps shorter than this are typing rhythm, not hesitation.
 * Gaps longer than `IDLE_CUTOFF_MS` are not hesitation either — the writer left
 * — and are discarded by the same reasoning that gates dwell.
 */
export const HESITATION_MIN_MS = 2_000;

/** Upward scroll of at least this much is deliberate, not a thumb wobble. */
export const SCROLLBACK_MIN_PX = 200;

/** Dwell after an upward scroll that makes it a reference check, not a passing glance. */
export const SCROLLBACK_DWELL_MS = 2_000;

/** Scroll movement below this between samples counts as settled. */
export const SCROLL_SETTLED_PX = 24;

/**
 * Signals older than this are deleted on startup. Their only readers are "the
 * last session" and "a recent window" (docs/SIGNALS.md), so nothing reads past
 * it. A genuine deletion — signals are telemetry, not the writer's work.
 */
export const SIGNAL_RETENTION_DAYS = 90;
