# Signals — attention telemetry

Writing continuously leaks signals about where attention actually is. No editor captures them.
`ezhuthu` does, because they are what make "take me back to where I was working" answerable.

## The guarantee, stated once

**Signals never leave the device.** They are written to IndexedDB on the phone and read by this
app. There is no network call, no analytics, no crash reporter carrying content, no sync. The
backup file (ADR-0013) contains the event log and document metadata — not signals.

This is not a policy that could be changed by a configuration flag. There is no code path that
transmits them.

## What is captured

| Signal | Captured from | What it means |
|---|---|---|
| **Dwell** | a 1 s sample of the rendered rows + the attention model below | Scrolling fast = searching. Settled 4 s+ = working. |
| **Hesitation** | inter-keystroke gaps, bucketed per block | Long pauses before typing = the sentence was hard. |
| **Backspace density** | delete keystrokes per block per session | Where the writer fought the words. |
| **Scroll-back** | upward scroll followed by dwell > 2 s | A reference point being checked. Auto-bookmark. |
| **Revision count** | count of `update` events per block | Derived from the log, not stored separately. |

Revision count is in this table for completeness but is not a `signals` record — it comes from
`Block.revisionCount`, maintained by the fold. Anything derivable from the log is read from the
log.

## The attention model (ADR-0017)

Naive dwell — `IntersectionObserver` plus a timestamp — does not measure attention. It measures
pixels on screen, and the two diverge in ways that are not edge cases:

- A phone left face-up on a desk accrues dwell indefinitely. The winner becomes wherever the
  writer was when he was interrupted — the least useful place in the document.
- A block at the top of the viewport accrues as much as the block actually being read.

Since "longest dwelled" is presented as *where attention was*, uncorrected this is not imprecise
but **confidently wrong**, which is worse than absent — the writer will follow it.

Dwell therefore accrues only under four gates:

1. **Visibility.** `visibilitychange` to hidden stops accrual immediately.
2. **Idle cutoff.** No keystroke, scroll or touch for `IDLE_CUTOFF_MS` (60 s) stops accrual for
   every block. Time already banked is kept; the gap is discarded.
3. **Centre weighting.** Accrual is weighted by proximity to viewport centre, so the block being
   read outscores blocks merely on screen.
4. **Settling.** A block accrues nothing until it has been stable for `SETTLE_MS` (1 s). This is
   what separates scrolling-as-searching from scrolling-as-reading.

The constants live in one module and are named — [`src/signals/constants.ts`](../src/signals/constants.ts).
They are guesses; revisiting them after real use is expected.

### How the model is fed

Not by an `IntersectionObserver`, despite what the table above said until Phase 4. IO reports
threshold *crossings*, and gates 3 and 4 need a value over *time* — so a timer is needed either
way, and IO would only supply staler geometry to it. The question IO exists to answer cheaply,
"which elements are near the viewport", is one virtualisation has already answered: about a dozen
rows exist in the DOM at all.

So `src/signals/collector.ts` samples `[data-block-id]` inside the scroller once a second, reads a
rect per row, and weights each by the centre of its *visible* extent — which is what stops a
paragraph taller than the screen from scoring zero. Accrual is computed from timestamps rather
than tick counts, so the interval is the model's resolution and not its accuracy. See ADR-0025.

The model itself (`src/signals/attention.ts`) is pure and takes time as a parameter, so the
synthetic-session tests drive ten minutes of reading and eight hours of a phone face-up on a desk
in a few milliseconds.

## Batching

Signal writes are queued in memory and flushed **every 2 s, or on `visibilitychange`**, whichever
comes first. Telemetry must never compete with typing for the main thread — a synchronous
IndexedDB write on the keystroke path would blow the 16 ms budget on its own.

The queue is bounded. If a flush fails, the queue is dropped rather than allowed to grow: signals
are non-critical, and losing some costs a slightly worse resume suggestion. Document data is never
in this queue.

## IME interaction

Hesitation and backspace density are measured from keystrokes, and **composing keystrokes must be
excluded** (ADR-0010). During IME composition the browser fires key events that do not correspond
to what the writer typed — Chrome reports `keyCode` 229 for everything. Counting those makes both
measurements nonsense for exactly the input method Malayalam is typed with.

Every keystroke handler in `src/signals/typing.ts` checks `isComposing` first.

## What powers what

The signals exist to serve two features. Nothing is collected speculatively.

**Resume (Phase 5)** — the four destinations:

| Destination | Query |
|---|---|
| Last edited | most recent `update` event |
| Last read | furthest scroll position from last session |
| Longest dwelled | highest gated dwell in the last session |
| Most rewritten | highest `revisionCount` in a recent window |

**Visibility (Phase 6)** — margin bar intensity and minimap shading come from `updatedAt` and
`revisionCount`, both from the log rather than from signals. Scroll-back auto-bookmarks come from
the `scrollback` signal.

## The modules

| File | What |
|---|---|
| `constants.ts` | every tunable, named. The ADR-0017 guesses live here and nowhere else |
| `attention.ts` | the four gates. Pure — time is a parameter, there is no clock inside |
| `scrollback.ts` | upward-scroll-then-dwell detection. Pure, for the same reason |
| `typing.ts` | hesitation and backspace density. Checks `isComposing` before anything else |
| `queue.ts` | coalescing, bounded, 2 s flush. The only code that writes `signals` |
| `collector.ts` | the DOM half: the 1 s sampler, the activity listeners, `visibilitychange` |
| `queries.ts` | reading back, and the retention prune |

## Storage

```ts
interface Signal {
  id?: number;
  docId: DocId;
  blockId: BlockId;
  ts: number;
  sessionId: string;
  kind: 'dwell' | 'hesitation' | 'backspace' | 'scrollback';
  value: number;   // dwell/hesitation: ms. backspace: count. scrollback: ms dwelled after return.
}
```

Indexed by `[docId+blockId]` and `[docId+ts]`. See [`DATA-MODEL.md`](DATA-MODEL.md).

Signals accumulate without bound over months, so they are pruned: records older than 90 days are
deleted on startup. Their only consumer is "the last session" and "a recent window", so old ones
have no reader. This is a genuine deletion, not a soft delete — unlike document data, signals are
not the user's work.
