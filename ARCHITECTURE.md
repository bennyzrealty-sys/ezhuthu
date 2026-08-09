# Architecture

## The core idea, stated once

**Nothing writes document state except the append-only event log.** Everything else in the
system — the `blocks` table, snapshots, the rendered DOM, the minimap, the resume strip — is a
*projection* of that log. Projections are caches. Caches can be thrown away and rebuilt. The log
is the only thing that is true.

If you remember one rule from this document, it is that one, and its corollary: **no code path
may write the whole document.** Every mutation is one appended event touching one block.

## Why store edits instead of the document

A conventional editor stores the current text and throws away how it got there. That makes four
things the writer actually wants either expensive or impossible:

| The writer wants | With stored documents | With a stored edit log |
|---|---|---|
| "Take me back to where I was working" | a bookmark someone remembered to save | a ranked query over recent events |
| "Show me what I changed yesterday" | a diff against a backup, if one exists | a filter by timestamp |
| "Undo that thing from before lunch" | gone — undo died with the session | replay to any point in the log |
| "I deleted a paragraph and want it back" | gone | it is still in the log |

The event log makes all four the *same mechanism*. That is the whole argument. Every feature in
this app that looks clever is a query over one table.

There is a fifth benefit that only shows up over months: because every `update` carries both the
text before and the text after, the log accumulates a complete record of how this particular
writer improves a Malayalam sentence. See [ADR-0012](DECISIONS.md).

## Data flow: keystroke to pixel

```
  keystroke
     │
     │  (native textarea handles the character — we do NOT intercept)
     ▼
  focused BlockEditor holds a local draft string
     │
     │  wait for: compositionend AND 400ms idle  ── or ── blur
     │  (never commit mid-composition — ADR-0010)
     ▼
  commitBlock(blockId, text)
     │
     ▼
┌────────────────────────────────────────────────────────────┐
│  ONE Dexie readwrite transaction  (ADR-0008)               │
│                                                            │
│   1. allocate seq   — bump counter on the doc record       │
│   2. append event   → events                               │
│   3. apply fold     → blocks   (the projection)            │
│   4. advance        → docs.lastAppliedSeq                  │
│                                                            │
│  All four commit together or none of them do.              │
└────────────────────────────────────────────────────────────┘
     │
     ▼
  live query notices the block changed
     │
     ▼
  virtualiser re-renders that one row  ── margin bar intensity
                                          recomputed from timestamps
```

The critical property of that transaction is step 4. `lastAppliedSeq` is the watermark that
proves the `blocks` projection is in step with the log. On open, if the watermark does not equal
the log head, the projection is stale and we replay the tail before trusting it. Without the
watermark a crash between steps 2 and 3 would leave a silently wrong document — which is exactly
the failure event sourcing is supposed to make impossible.

## The fold

`src/core/fold.ts` is a pure function with no imports from React, Dexie, or the DOM:

```ts
applyEvent(state: DocState, event: BlockEvent): DocState
```

It is the single definition of what an event *means*. Both write paths use it:

- **incremental** — on commit, fold one event into the `blocks` projection
- **batch** — on replay, fold N events from a snapshot or from empty

Because both paths use the same function, "the projection drifted from the log" is not a class of
bug that can exist. This is why `core/` is dependency-free and why fold correctness is the first
thing tested: `tests/unit/fold.test.ts` asserts that folding a log incrementally and folding it
in one batch produce byte-identical state, over randomised event sequences.

## Read path, and why snapshots are not on it

The obvious event-sourcing mistake is to replay the log on open. At 200,000 events that is
seconds of jank. The equally obvious fix — snapshot every N events, replay the tail — is what the
original brief specified, and it is solving a problem we do not have.

The `blocks` table *is already* a materialised snapshot of head state, maintained transactionally
on every write. So cold open is:

```
  read docs record            → 1 indexed get
  watermark === log head?     → yes, in the overwhelmingly common case
  read blocks by [docId+order] → 1 indexed range query, no replay at all
```

Replay happens only when the watermark is behind, which means a crash mid-transaction — rare, and
bounded by however many events were lost.

**So what are snapshots for?** Historical reconstruction. The time-lapse scrub (Phase 7) needs to
materialise the document as it existed at an arbitrary past `seq`, at interactive drag rates. That
genuinely does require replay, and replay from empty is far too slow. Snapshots are anchors that
bound it.

This reframing changes the retention policy in a way that matters. We keep a **logarithmic
ladder**: at most one anchor per octave of age, so anchors are dense near head and progressively
sparser going back, and total snapshot storage is O(log n) in log length.

The guarantee that falls out is worth stating precisely, because it is the reason dropping the
oldest anchors is safe: **reconstructing any past state never replays more events than lie between
that state and the present.** Recent states are cheap — an anchor is close by. Distant states cost
more, but a state early in the log needs no anchor at all, since replaying it from empty is
bounded by its own position, which is small precisely because it is early. The property is
asserted in `tests/unit/snapshots.test.ts` across several log sizes. See
[ADR-0009](DECISIONS.md).

Replay for the scrub runs in a Web Worker (`src/features/timelapse/replay.worker.ts`) so dragging
never competes with typing for the main thread.

## Rendering

**Virtualised and block-based.** Only blocks in and slightly around the viewport exist in the
DOM. A 100k-word document is roughly 2,000 blocks; we render 15–30.

TanStack Virtual with **dynamic measurement**. Fixed row heights are not survivable here —
Malayalam line wrapping is genuinely unpredictable because conjunct clusters have widths you
cannot compute from character counts. Measured heights are cached per `blockId` + viewport width,
and the cache is invalidated on resize and on orientation change.

**Rendered blocks are read-only `<div>`s. Only the focused block becomes an editable field.**

This is what lets virtualisation and text editing coexist. A `contenteditable` spanning a
virtualised list is not workable: the browser's selection model assumes the whole document is in
the DOM, and unmounting a node the selection lives inside destroys the selection. With one
editable node at a time, the browser only ever manages a single-paragraph editing context — which
it is extremely good at, including IME composition, autocorrect, and swipe typing.

The cost is real and is documented as a limitation rather than hidden: **you cannot select across
block boundaries.** No select-from-paragraph-3-into-paragraph-7, no ⌘A over the document, no
multi-paragraph drag-copy. On a phone this is barely noticeable; on desktop it is jarring. The
mitigation is an explicit range-select mode and a copy affordance (Phase 2), not an attempt to
make native selection work across a virtualised list. See [ADR-0011](DECISIONS.md).

The hard part of this design is the **tap-to-focus handoff**. When a read-only div is tapped, we
must mount an editor in its place and land the caret exactly where the finger did, without a
visible jump. That means `caretPositionFromPoint()` (or `caretRangeFromPoint()` on WebKit) to map
tap coordinates to a text offset, converting that offset to a grapheme-cluster boundary, then
restoring it in the newly mounted field. Getting this wrong is the difference between an editor
that feels native and one that feels like a web page.

## Keeping the typing path empty

The `< 16ms` keystroke budget is easy to hit and easy to lose. It is easy to hit because the
focused block is a plain field and the browser renders the character itself — we are not in the
loop. It is easy to lose the moment anything expensive is attached to `onChange`.

So the rule is: **the change handler stores a string and returns.** Everything else — word
counting, grapheme segmentation, signal capture, revision accounting, persistence — is deferred
to idle time or to the commit boundary. Nothing that scales with document size, and nothing that
touches IndexedDB, may run synchronously with a keypress.

Signals are batched on a 2-second flush (or on `visibilitychange`) for the same reason: telemetry
must never compete with typing for the main thread.

## Storage durability

Browsers evict IndexedDB. On iOS this is not hypothetical — storage for a site that has not been
added to the home screen can be reclaimed under pressure, and on some versions after a period of
disuse. For an application whose entire value proposition is holding a 100,000-word manuscript,
this is the single largest risk to the user, larger than any performance concern.

Three layers of defence, all in Phase 1 rather than deferred to polish:

1. **Request `navigator.storage.persist()`** on first write, and record the answer.
2. **Tell the truth about the result.** If persistence was denied, the app says so plainly rather
   than pretending the data is safe.
3. **Scheduled backups out of the browser.** A backup produces a single self-contained JSON file
   containing the full event log. The app tracks when the last one happened and escalates a nag
   as it ages. This is the only layer that actually survives eviction, so the UI treats it as the
   real protection and the other two as best-effort.

See [ADR-0013](DECISIONS.md) and `src/db/persistence.ts`.

## Module layout

```
src/
  db/        Dexie schema, types, id generation, storage persistence + backup
  core/      PURE. fold, replay, ordering, snapshot policy, event append.
             No React. No DOM. Imports Dexie types only, never the DOM.
  text/      Unicode correctness: segmentation, NFC, counting, search
  signals/   attention telemetry: capture, batching, resume queries
  render/    virtualiser host, read-only rows, focused editor, measurement, caret
  features/  resume · visibility · timelapse · search · io
  ui/        primitives, theme, font loading
  pwa/       service worker, registration
```

`core/` being pure is load-bearing, not stylistic. It is what makes the fold testable in
isolation, what lets replay run inside a Web Worker, and what keeps the definition of "what an
event means" in exactly one place.

## Performance budgets

Enforced in `tests/perf` against a synthetic 80,000-word Malayalam document
(`npm run corpus:generate`). "It feels fast" is not evidence; a failing budget is a failing build.

| Metric | Budget | Measured how |
|---|---|---|
| Cold open, 100k words | < 1.5 s | navigation start → first block painted |
| Scroll | sustained 60 fps | long-task count + frame timing during scripted fling |
| Keystroke to paint | < 16 ms | `performance.mark` around input → next paint |
| Memory | < 150 MB | `performance.measureUserAgentSpecificMemory()` |

The memory budget is why we never hold every block's text in memory. What we do hold, for all
blocks, is a compact index — `{blockId, order, updatedAt, revisionCount, length}`, about 100
bytes per block, so ~200 KB at 2,000 blocks. That index is enough to drive the minimap and the
scrollbar. Text is fetched by range as the viewport needs it, and search runs as a cursor over
IndexedDB rather than over anything resident.

## Extension points

Designed for, deliberately not built in v1. The seams:

- **`Block.meta: Record<string, unknown>`** — present in the type and persisted from day one, so
  blocks can later carry type tags without a schema migration.
- **Locked blocks** — `meta.locked`, requiring deliberate unlock before editing. The commit path
  already funnels through one function, which is where the check would go.
- **Derived metrics panel** — a pluggable slot computing per-block and per-document figures from
  block text. The compact in-memory index is the natural input.
- **Additional scripts** — nothing in `text/` hardcodes Malayalam. Locale is a parameter to
  `Intl.Segmenter`, and the font stack is data.

## Related documents

- [`DECISIONS.md`](DECISIONS.md) — ADR log: why, what was rejected, what it costs
- [`docs/DATA-MODEL.md`](docs/DATA-MODEL.md) — every store, index and type, with worked examples
- [`docs/MALAYALAM.md`](docs/MALAYALAM.md) — script-handling rules and the bugs each prevents
- [`docs/SIGNALS.md`](docs/SIGNALS.md) — what is captured, what it means, the local-only guarantee
- [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md) — how to run and interpret the budget suite
- [`HANDOFF.md`](HANDOFF.md) — current state, next tasks, traps
