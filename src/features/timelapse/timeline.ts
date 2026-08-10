/**
 * Where the scrub can stop.
 *
 * The log is not a useful timeline on its own. Its positions are events, and
 * events are not evenly distributed in time or in interest: an import puts
 * 1,563 of them at one instant, an afternoon of writing puts a few hundred over
 * four hours, and the six months between two drafts put none at all. A slider
 * over seq would spend most of its travel inside a single paste, and a slider
 * over `ts` would spend most of its travel in an empty summer.
 *
 * So the slider addresses *stops*: the moments the document was left in a state
 * worth looking at. One at the end of every writing session, and enough inside
 * a long session that a single sitting is still scrubbable.
 *
 * PURE, and time is a parameter — there is no `Date.now()` here, which is what
 * lets the tests drive a year of writing in a millisecond.
 */

import { EVENTS_PER_STOP, MAX_STOPS, SESSION_GAP_MS } from './constants';

/** What the timeline needs from an event. Never the payload. */
export interface EventSample {
  seq: number;
  ts: number;
  sessionId: string;
}

export interface TimelineStop {
  /** Materialise the document at this seq to see this stop. */
  seq: number;
  /** When the writer left it here. Display only; it orders nothing. */
  ts: number;
  /** Events between the previous stop and this one. */
  events: number;
  /** True when this is the last stop of a writing session. */
  endsSession: boolean;
}

export interface Timeline {
  /** Ascending by seq. Empty for a document with no history. */
  stops: TimelineStop[];
  /** Distinct writing sessions found. */
  sessions: number;
  /** The present. Equal to the last stop's seq when there are any stops. */
  headSeq: number;
}

export const EMPTY_TIMELINE: Timeline = { stops: [], sessions: 0, headSeq: 0 };

export interface TimelineOptions {
  sessionGapMs?: number;
  eventsPerStop?: number;
  maxStops?: number;
}

/**
 * Build the stops for a log.
 *
 * Samples must be in log order. They are not sorted here: they come from a
 * cursor over `[docId+seq]`, and re-sorting a hundred thousand of them to
 * restate what the index already guarantees is work for nothing.
 */
export function buildTimeline(
  samples: readonly EventSample[],
  options: TimelineOptions = {},
): Timeline {
  const sessionGapMs = options.sessionGapMs ?? SESSION_GAP_MS;
  const eventsPerStop = options.eventsPerStop ?? EVENTS_PER_STOP;
  const maxStops = options.maxStops ?? MAX_STOPS;

  if (samples.length === 0) return EMPTY_TIMELINE;

  const candidates: TimelineStop[] = [];
  let sessions = 1;
  let sinceStop = 0;

  for (const [i, sample] of samples.entries()) {
    sinceStop += 1;
    const next = samples[i + 1];

    /*
     * A session ends when the next event is a different sessionId or comes
     * after a long enough pause. `ts` is a wall clock and can move backwards,
     * so a negative gap is treated as no gap rather than as a session
     * boundary — a clock correction is not the writer walking away.
     */
    const endsSession =
      next === undefined || next.sessionId !== sample.sessionId || next.ts - sample.ts > sessionGapMs;

    if (endsSession || sinceStop >= eventsPerStop) {
      candidates.push({ seq: sample.seq, ts: sample.ts, events: sinceStop, endsSession });
      sinceStop = 0;
    }
    if (endsSession && next !== undefined) sessions += 1;
  }

  return { stops: thin(candidates, maxStops), sessions, headSeq: samples.at(-1)!.seq };
}

/**
 * Reduce to at most `limit` stops, evenly.
 *
 * The last stop is kept unconditionally: it is the present, and a scrub that
 * cannot be dragged back to now is a trap. Session ends are preferred over
 * mid-session stops when both fall in the same slot, because a stop the writer
 * chose is worth more than one the counter produced.
 */
function thin(stops: readonly TimelineStop[], limit: number): TimelineStop[] {
  if (stops.length <= limit || limit < 1) return [...stops];

  const kept: TimelineStop[] = [];
  const slot = stops.length / limit;

  for (let i = 0; i < limit; i += 1) {
    const from = Math.floor(i * slot);
    const to = Math.min(stops.length, Math.floor((i + 1) * slot));
    const range = stops.slice(from, to);
    if (range.length === 0) continue;
    kept.push(range.findLast((s) => s.endsSession) ?? range.at(-1)!);
  }

  const last = stops.at(-1)!;
  if (kept.at(-1)!.seq !== last.seq) kept[kept.length - 1] = last;

  // Two slots can pick the same stop when a session end is the only member of
  // both; the seq is what identifies a stop, so dedupe on it.
  return kept.filter((stop, i) => i === 0 || stop.seq !== kept[i - 1]!.seq);
}

/** The stop at or before `seq`, or the first stop when `seq` precedes them all. */
export function stopIndexForSeq(timeline: Timeline, seq: number): number {
  let found = 0;
  for (const [i, stop] of timeline.stops.entries()) {
    if (stop.seq <= seq) found = i;
    else break;
  }
  return found;
}

/**
 * Group stops by local calendar day, for the scrub's labels.
 *
 * The formatter is injected rather than reached for, so this stays pure and the
 * tests do not depend on the machine's time zone.
 */
export function groupByDay(
  stops: readonly TimelineStop[],
  dayKey: (ts: number) => string,
): Array<{ day: string; from: number; to: number }> {
  const groups: Array<{ day: string; from: number; to: number }> = [];
  for (const [i, stop] of stops.entries()) {
    const day = dayKey(stop.ts);
    const last = groups.at(-1);
    if (last !== undefined && last.day === day) last.to = i;
    else groups.push({ day, from: i, to: i });
  }
  return groups;
}
