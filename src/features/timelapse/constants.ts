/**
 * The time-lapse tunables, in one module — as with `signals/constants.ts` and
 * the corpus thresholds, so that revisiting them is a diff to one file.
 */

/**
 * A pause longer than this ends a writing session.
 *
 * Sessions are what the scrub's stops are built from, because "the state the
 * document was left in" is the interesting past state and the middle of a
 * sentence is not. Distinct from `sessionId`, which changes on every app
 * launch: a writer who leaves the tab open overnight keeps one sessionId across
 * two days of work, and a writer who reloads twice in a minute makes three.
 * Neither is a session in the sense that matters here.
 */
export const SESSION_GAP_MS = 30 * 60 * 1000;

/**
 * Upper bound on stops. Past this the slider has more positions than a thumb
 * can address and every extra one costs a replay to visit.
 */
export const MAX_STOPS = 240;

/**
 * Blocks handed to the main thread in one window.
 *
 * The materialised past state stays in the Worker; only a window of it crosses
 * the boundary, so the memory rule holds for history exactly as it does for the
 * present (docs/PERFORMANCE.md).
 */
export const WINDOW_BLOCKS = 60;
