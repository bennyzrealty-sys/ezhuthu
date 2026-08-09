# Project conventions

Read [`HANDOFF.md`](HANDOFF.md) first if you are starting a session cold — it has current state,
next tasks, and the traps.

## The rules that are not negotiable

These exist because breaking them produces silent data corruption or silent Unicode breakage,
neither of which shows up in a passing test suite.

**1. No code path may write the whole document.** Every mutation appends one event touching one
block. If you find yourself writing an array of blocks, stop — you are about to make a 100k-word
document unusable. The only exceptions are import, restore-from-backup, and projection rebuild,
which are batch operations and are marked as such.

**2. Nothing writes document state except the event log.** `blocks` is a projection maintained by
`fold()` inside the append transaction. Never `db.blocks.put()` outside `core/events.ts`.

**3. Event + projection + watermark go in one transaction.** See ADR-0008. If you add a new event
type, it goes through the same append path; do not open your own transaction.

**4. All cursor, character, and selection operations go through `Intl.Segmenter`.** Never index
into a string with a raw offset for anything user-facing. `"നി".length` is 2 and the user sees one
character. Use the helpers in `src/text/segmenter.ts` — do not call `Intl.Segmenter` directly at
call sites, because the segmenter instances are cached and constructing them per keystroke is
measurably slow.

**5. Never compare strings without normalising.** All comparison, search and matching goes through
`src/text/normalize.ts`. Raw `===` on user text is a bug — chillu forms that look identical will
fail to match. Note that we normalise *for comparison only*; stored text keeps its original bytes
(ADR-0014).

**6. Never commit to storage while `isComposing`.** Malayalam is typed through IMEs. Writing to or
re-rendering the focused field mid-composition corrupts the input. See ADR-0010. This applies to
signal capture too — composing keystrokes must not be counted as hesitation or backspaces.

**7. Sort event order with the comparator in `core/order.ts`.** `(seq, deviceId)`, never `seq`
alone, never `ts`. Block order is a *string* compared lexicographically — sorting `Block.order`
numerically anywhere is a bug (ADR-0007).

**8. Never call `Date.now()` in rendering or fold logic.** Time decay is computed from an injected
clock so it can be tested. `core/` takes time as a parameter.

**9. Nothing leaves the device.** No network calls for user data, ever. No analytics, no error
reporting with content, no font CDN. If you are adding a `fetch`, it had better be for a static
asset from our own origin.

## Where things go

```
src/db/        Dexie schema, types, ids, storage persistence + backup
src/core/      PURE — fold, replay, ordering, snapshots, event append
               No React, no DOM. This is what makes replay work in a Worker.
src/text/      Unicode: segmentation, NFC, counting, search
src/signals/   attention telemetry: capture, batching, resume queries
src/render/    virtualiser, read-only rows, focused editor, measurement, caret
src/features/  resume · visibility · timelapse · search · io
src/ui/        primitives, theme, fonts
src/pwa/       service worker + registration
```

`core/` importing React or the DOM is a review-blocking error. Everything else follows from it.

## Commit style

Subject line: imperative, lower-case after the first word, no trailing period, ≤ 72 chars.

The body explains **why**, not what — the diff already says what. If a commit implements or
changes an ADR, reference it (`ADR-0012`). If it deliberately leaves something broken or
unfinished, say so in the body so the next session does not treat it as a bug to hunt.

Small, logical commits. One concern per commit. A commit that touches the schema, the fold, and
the UI is three commits.

## Tests

- **Unit (Vitest)** — everything in `core/` and `text/`. These are pure, so there is no excuse.
  `npm test`
- **E2E (Playwright)** — user-visible behaviour, offline, import/export round trip.
  `npm run test:e2e`
- **Perf (Playwright)** — the budgets in `docs/PERFORMANCE.md`, against an 80k-word synthetic
  corpus. `npm run test:perf`

**Required before any commit that touches `core/`:** the fold equivalence property test must pass.
It asserts that folding a log incrementally and in one batch produce identical state, over
randomised sequences. If that breaks, the projection can diverge from the log and everything
downstream is untrustworthy.

**Required for anything touching text handling:** the Malayalam test strings in
`docs/MALAYALAM.md` are in the unit suite. Add to them when you find a new failure mode; that
file and the tests are meant to stay in sync.

Performance work is not accepted on the basis that it feels fast. Run the suite and put the
numbers in the commit body.

## Performance rules of thumb

- The keystroke handler stores a string and returns. Anything else goes to idle or to commit time.
- Nothing that scales with document size runs on the main thread during typing or scrolling.
- Signals batch on a 2 s flush or `visibilitychange`. Never write telemetry synchronously.
- Do not hold all block text in memory. The compact index (`{blockId, order, updatedAt,
  revisionCount, length}`) is what the minimap and scrollbar use.

## Documentation upkeep

- **`HANDOFF.md` is updated at the end of every session.** Not optional. It is the difference
  between the next session resuming and restarting.
- A significant decision gets an ADR in `DECISIONS.md`. Significant means: someone could
  reasonably have chosen otherwise, and the reason will not be obvious from the code in six months.
- ADRs are never edited to change a decision. Add a new one and mark the old superseded.
