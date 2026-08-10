import { describe, expect, it } from 'vitest';
import { coalesceRevisions, pairsForBlock, revisionsForBlock } from '@/features/io/corpus/pairs';
import { COALESCE_WINDOW_MS } from '@/features/io/corpus/constants';
import { eventFactory } from './helpers';

const BLOCK = 'b1';

describe('walking a block history', () => {
  it('derives before from the preceding event rather than the payload', () => {
    // The point of ADR-0012: the log does not store prevText, and this is what
    // recovers it.
    const f = eventFactory();
    const events = [
      f.make('insert', BLOCK, { text: 'കടൽ ശാന്തമായിരുന്നു.' }),
      f.make('update', BLOCK, { text: 'കടൽ ശാന്തമായിരുന്നു. കാറ്റില്ല.' }),
    ];

    const revisions = revisionsForBlock(events);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.before).toBe('കടൽ ശാന്തമായിരുന്നു.');
    expect(revisions[0]!.after).toBe('കടൽ ശാന്തമായിരുന്നു. കാറ്റില്ല.');
  });

  it('prefers stored prevText where the log carries it', () => {
    // The case ADR-0012 keeps prevText for: history begins mid-block, so
    // nothing earlier in the log holds the text this revision started from.
    const f = eventFactory();
    const events = [
      f.make('update', BLOCK, { text: 'അവൻ ഒരു നല്ല എഴുത്തുകാരൻ ആണ്.', prevText: 'അവൻ ഒരു എഴുത്തുകാരൻ ആണ്.' }),
    ];

    const revisions = revisionsForBlock(events);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.before).toBe('അവൻ ഒരു എഴുത്തുകാരൻ ആണ്.');
  });

  it('emits nothing when the text it started from is unknowable', () => {
    // An empty `before` here would publish "written from nothing" about a
    // paragraph that already existed.
    const f = eventFactory();
    const events = [f.make('update', BLOCK, { text: 'മഴ പെയ്യുന്നു.' })];
    expect(revisionsForBlock(events)).toEqual([]);
  });

  it('picks the history back up after an unknowable first revision', () => {
    const f = eventFactory();
    const events = [
      f.make('update', BLOCK, { text: 'മഴ പെയ്യുന്നു.' }),
      f.make('update', BLOCK, { text: 'മഴ ശക്തമായി പെയ്യുന്നു.' }),
    ];

    const revisions = revisionsForBlock(events);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.before).toBe('മഴ പെയ്യുന്നു.');
    expect(revisions[0]!.continuesRun).toBe(false);
  });

  it('orders events by (seq, deviceId) rather than trusting the caller', () => {
    const f = eventFactory();
    const insert = f.make('insert', BLOCK, { text: 'ഒന്ന്' });
    const first = f.make('update', BLOCK, { text: 'രണ്ട്' });
    const second = f.make('update', BLOCK, { text: 'മൂന്ന്' });

    const revisions = revisionsForBlock([second, insert, first]);
    expect(revisions.map((r) => r.after)).toEqual(['രണ്ട്', 'മൂന്ന്']);
    expect(revisions[0]!.before).toBe('ഒന്ന്');
  });

  it('treats a deletion as the end of a run, not as a revision', () => {
    const f = eventFactory();
    const events = [
      f.make('insert', BLOCK, { text: 'പുസ്തകം' }),
      f.make('update', BLOCK, { text: 'പുസ്തകങ്ങൾ' }),
      f.make('delete', BLOCK, { text: 'പുസ്തകങ്ങൾ' }),
      f.make('insert', BLOCK, {}), // restore in place (ADR-0018)
      f.make('update', BLOCK, { text: 'പുസ്തകങ്ങൾ ഉണ്ട്.' }),
    ];

    const revisions = revisionsForBlock(events);
    expect(revisions.map((r) => r.after)).toEqual(['പുസ്തകങ്ങൾ', 'പുസ്തകങ്ങൾ ഉണ്ട്.']);
    // A restore keeps the text it left with, so the later revision starts from
    // the text the delete removed.
    expect(revisions[1]!.before).toBe('പുസ്തകങ്ങൾ');
    expect(revisions[1]!.continuesRun).toBe(false);
  });

  it('does not let a move split a run', () => {
    const f = eventFactory();
    const events = [
      f.make('insert', BLOCK, { text: 'ഒന്ന്' }),
      f.make('update', BLOCK, { text: 'ഒന്നും രണ്ടും' }),
      f.make('move', BLOCK, { afterBlockId: null }),
      f.make('update', BLOCK, { text: 'ഒന്നും രണ്ടും മൂന്നും' }),
    ];

    expect(revisionsForBlock(events).map((r) => r.continuesRun)).toEqual([true, true]);
  });
});

describe('session coalescing', () => {
  const run = (texts: readonly string[], opts: { sessionId?: string; gapMs?: number } = {}) => {
    const f = eventFactory({ sessionId: opts.sessionId });
    const events = [f.make('insert', BLOCK, { text: texts[0] })];
    for (const text of texts.slice(1)) events.push(f.make('update', BLOCK, { text }));
    return events;
  };

  it('collapses one editing burst to the text before it and the text after', () => {
    // Forty autosaves of a reworked sentence are one act of revision, not
    // forty (ADR-0012).
    const events = run(['ഒന്ന്', 'ഒന്നും', 'ഒന്നും രണ്ടും', 'ഒന്നും രണ്ടും മൂന്നും']);
    const pairs = pairsForBlock(events);

    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.before).toBe('ഒന്ന്');
    expect(pairs[0]!.after).toBe('ഒന്നും രണ്ടും മൂന്നും');
  });

  it('stamps the pair with when the revision finished', () => {
    const events = run(['ഒന്ന്', 'രണ്ട്', 'മൂന്ന്']);
    const pairs = pairsForBlock(events);
    expect(pairs[0]!.ts).toBe(events.at(-1)!.ts);
  });

  it('splits when the writer comes back in a later session', () => {
    const morning = eventFactory({ sessionId: 'morning' });
    const evening = eventFactory({ sessionId: 'evening' });

    const events = [
      morning.make('insert', BLOCK, { text: 'ഒന്ന്' }),
      morning.make('update', BLOCK, { text: 'ഒന്നും രണ്ടും' }),
      evening.make('update', BLOCK, { text: 'ഒന്നും രണ്ടും മൂന്നും' }, { seq: 90 }),
    ];

    const pairs = pairsForBlock(events);
    expect(pairs).toHaveLength(2);
    expect(pairs[0]!.after).toBe('ഒന്നും രണ്ടും');
    expect(pairs[1]!.before).toBe('ഒന്നും രണ്ടും');
  });

  it('splits when the gap inside one session exceeds the window', () => {
    const f = eventFactory();
    const events = [
      f.make('insert', BLOCK, { text: 'ഒന്ന്' }),
      f.make('update', BLOCK, { text: 'ഒന്നും രണ്ടും' }),
      f.make('update', BLOCK, { text: 'ഒന്നും രണ്ടും മൂന്നും' }, { ts: 1_700_000_000_000 + COALESCE_WINDOW_MS * 2 }),
    ];

    expect(pairsForBlock(events)).toHaveLength(2);
  });

  it('measures the gap between consecutive revisions, not across the whole run', () => {
    // An hour spent working over one paragraph without pausing five minutes is
    // one revision — the run is not capped by its own duration.
    const f = eventFactory();
    const events = [f.make('insert', BLOCK, { text: 'ഒന്ന്' })];
    let ts = 1_700_000_000_000;
    for (let i = 0; i < 30; i += 1) {
      ts += COALESCE_WINDOW_MS - 1_000;
      events.push(f.make('update', BLOCK, { text: `വാക്ക് ${i}` }, { ts }));
    }

    expect(pairsForBlock(events)).toHaveLength(1);
  });

  it('never coalesces across a deletion, however close in time', () => {
    const f = eventFactory();
    const events = [
      f.make('insert', BLOCK, { text: 'ഒന്ന്' }),
      f.make('update', BLOCK, { text: 'രണ്ട്' }),
      f.make('delete', BLOCK, { text: 'രണ്ട്' }),
      f.make('insert', BLOCK, {}),
      f.make('update', BLOCK, { text: 'മൂന്ന്' }),
    ];

    expect(pairsForBlock(events)).toHaveLength(2);
  });

  it('numbers revisions within the block, counting coalesced acts', () => {
    const morning = eventFactory({ sessionId: 'morning' });
    const evening = eventFactory({ sessionId: 'evening' });
    const events = [
      morning.make('insert', BLOCK, { text: 'ഒന്ന്' }),
      morning.make('update', BLOCK, { text: 'രണ്ട്' }),
      morning.make('update', BLOCK, { text: 'മൂന്ന്' }),
      evening.make('update', BLOCK, { text: 'നാല്' }, { seq: 90 }),
    ];

    expect(pairsForBlock(events).map((p) => p.revisionIndex)).toEqual([1, 2]);
  });

  it('returns nothing for a block that was only ever written once', () => {
    const f = eventFactory();
    expect(pairsForBlock([f.make('insert', BLOCK, { text: 'ഒന്ന്' })])).toEqual([]);
    expect(coalesceRevisions([])).toEqual([]);
  });
});
