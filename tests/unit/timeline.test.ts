import { describe, expect, it } from 'vitest';
import {
  buildTimeline,
  groupByDay,
  stopIndexForSeq,
  type EventSample,
} from '@/features/timelapse/timeline';
import { SESSION_GAP_MS } from '@/features/timelapse/constants';

const T0 = 1_700_000_000_000;

/** `count` commits one second apart, in one session. */
function burst(from: number, count: number, ts: number, sessionId = 'a'): EventSample[] {
  return Array.from({ length: count }, (_, i) => ({
    seq: from + i,
    ts: ts + i * 1_000,
    sessionId,
  }));
}

/** `count` events written in one transaction: one instant, one `ts`. */
function transaction(from: number, count: number, ts: number, sessionId = 'a'): EventSample[] {
  return Array.from({ length: count }, (_, i) => ({ seq: from + i, ts, sessionId }));
}

describe('building a timeline', () => {
  it('has no stops for a log with no events', () => {
    const timeline = buildTimeline([]);
    expect(timeline.stops).toEqual([]);
    expect(timeline.headSeq).toBe(0);
  });

  it('gives an import one stop, not sixteen hundred', () => {
    // Events written in one transaction share a ts. There is no intermediate
    // state anybody wrote or could have seen, and a slider that spends its
    // whole travel inside a paste is the failure this rule exists to prevent.
    const timeline = buildTimeline(transaction(1, 1_563, T0));

    expect(timeline.stops).toHaveLength(1);
    expect(timeline.stops[0]).toMatchObject({ seq: 1_563, events: 1_563 });
  });

  it('gives each committed edit its own stop', () => {
    const timeline = buildTimeline([...transaction(1, 3, T0), ...burst(4, 4, T0 + 10_000)]);

    // The import, then one stop per commit.
    expect(timeline.stops.map((s) => s.seq)).toEqual([3, 4, 5, 6, 7]);
  });

  it('ends a stop where the writer put the document down', () => {
    const morning = burst(1, 5, T0);
    const evening = burst(6, 5, T0 + SESSION_GAP_MS * 4);

    const timeline = buildTimeline([...morning, ...evening]);

    expect(timeline.sessions).toBe(2);
    expect(timeline.stops.filter((s) => s.endsSession).map((s) => s.seq)).toEqual([5, 10]);
  });

  it('starts a new session when the app was relaunched', () => {
    // Same instant, different sessionId: two launches, and the state at the end
    // of each is a state the writer left.
    const first = transaction(1, 3, T0, 'launch-1');
    const second = transaction(4, 3, T0, 'launch-2');

    const timeline = buildTimeline([...first, ...second]);
    expect(timeline.sessions).toBe(2);
    expect(timeline.stops.map((s) => s.seq)).toEqual([3, 6]);
  });

  it('counts the events each stop covers', () => {
    const timeline = buildTimeline([...transaction(1, 10, T0), ...burst(11, 3, T0 + 5_000)]);
    expect(timeline.stops.map((s) => s.events)).toEqual([10, 1, 1, 1]);
  });

  it('does not treat a clock that moved backwards as a pause', () => {
    // Wall clocks go backwards (NTP, DST). That is not the writer walking away,
    // and it must not invent a session boundary.
    const corrected = T0 - SESSION_GAP_MS * 3;
    const samples: EventSample[] = [
      { seq: 1, ts: T0, sessionId: 'a' },
      { seq: 2, ts: corrected, sessionId: 'a' },
      { seq: 3, ts: corrected + 1_000, sessionId: 'a' },
    ];

    expect(buildTimeline(samples).sessions).toBe(1);
    expect(buildTimeline(samples).stops.map((s) => s.endsSession)).toEqual([false, false, true]);
  });

  it('always ends at the present', () => {
    const timeline = buildTimeline(burst(1, 5_000, T0), { maxStops: 20 });
    expect(timeline.stops.at(-1)!.seq).toBe(5_000);
    expect(timeline.headSeq).toBe(5_000);
  });
});

describe('thinning', () => {
  it('never exceeds the cap', () => {
    const timeline = buildTimeline(burst(1, 10_000, T0), { maxStops: 50 });
    expect(timeline.stops.length).toBeLessThanOrEqual(50);
  });

  it('prefers the stop the writer chose over the one the counter produced', () => {
    // Three sessions of ten commits each, thinned to three stops: the survivors
    // should be the session ends.
    const samples = [
      ...burst(1, 10, T0, 'a'),
      ...burst(11, 10, T0 + SESSION_GAP_MS * 3, 'b'),
      ...burst(21, 10, T0 + SESSION_GAP_MS * 6, 'c'),
    ];

    const timeline = buildTimeline(samples, { maxStops: 3 });
    expect(timeline.stops.map((s) => s.seq)).toEqual([10, 20, 30]);
  });

  it('restates the event counts over the stops that survived', () => {
    // Otherwise "events" means "since a stop that is no longer on the slider".
    const timeline = buildTimeline(burst(1, 100, T0), { maxStops: 4 });
    const total = timeline.stops.reduce((sum, stop) => sum + stop.events, 0);
    expect(total).toBe(100);
  });

  it('leaves a short timeline alone', () => {
    const timeline = buildTimeline(burst(1, 3, T0), { maxStops: 100 });
    expect(timeline.stops.map((s) => s.seq)).toEqual([1, 2, 3]);
  });

  it('emits no duplicate positions', () => {
    const timeline = buildTimeline(burst(1, 300, T0), { maxStops: 10 });
    const seqs = timeline.stops.map((s) => s.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});

describe('locating a seq', () => {
  const timeline = buildTimeline(burst(1, 5, T0));

  it('finds the stop at or before a seq', () => {
    expect(stopIndexForSeq(timeline, 1)).toBe(0);
    expect(stopIndexForSeq(timeline, 3)).toBe(2);
    expect(stopIndexForSeq(timeline, 5)).toBe(4);
  });

  it('clamps a seq before the first stop to the first stop', () => {
    expect(stopIndexForSeq(timeline, 0)).toBe(0);
  });

  it('clamps a seq past the head to the last stop', () => {
    expect(stopIndexForSeq(timeline, 9_999)).toBe(4);
  });
});

describe('grouping stops by day', () => {
  const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);

  it('runs consecutive stops from one day together', () => {
    const stops = buildTimeline([
      ...transaction(1, 5, Date.UTC(2026, 7, 8, 9)),
      ...transaction(6, 5, Date.UTC(2026, 7, 8, 20)),
      ...transaction(11, 5, Date.UTC(2026, 7, 10, 9)),
    ]).stops;

    const groups = groupByDay(stops, day);
    expect(groups.map((g) => g.day)).toEqual(['2026-08-08', '2026-08-10']);
    expect(groups[0]).toMatchObject({ from: 0, to: 1 });
    expect(groups[1]).toMatchObject({ from: 2, to: 2 });
  });

  it('groups nothing into nothing', () => {
    expect(groupByDay([], day)).toEqual([]);
  });
});
