# Handoff

**Written for a session with no memory of the previous one.** Read this first. Updated at the end
of every working session — if it is stale, that is a bug.

**Last updated:** 2026-08-10 · end of Phase 6

---

## Where the project is

**Phases 1 through 6 complete.** The event log and its durability layer work, there is a working
editor on top of them, the document renders in a bundled Malayalam face that shapes correctly,
search finds words the reader can see anywhere in a 1,563-block document, the app measures where
attention actually was and uses it to offer the writer his way back in (requirement 1) — and, as
of Phase 6, **edited lines are identifiable at a glance (requirement 2):** a margin bar, a
minimap, ghost markers for deletions, auto-bookmarks, and scroll-past feedback. Both project
requirements now have an answer.

**Phases 1-4 are merged to `main`** (PRs #1, #2 and #3). **Phase 5 is open in draft PR #4** on
`claude/ezhuthu-phase5-resume`. **Phase 6 is this branch, `claude/continue-previous-6smqet`,
stacked on the Phase 5 branch** — Phase 6 builds on Phase 5 and Phase 5 has not landed yet. When
Phase 5 merges, rebase Phase 6 onto `main` (its PR base is the Phase 5 branch, so the diff shows
Phase 6 alone).

Start Phase 7 from a fresh branch off whatever has landed on `main`:

```bash
git fetch origin main && git checkout -B <new-branch> origin/main
```

Every phase ships as its own PR.

## What works

**Foundation (Phase 1).** Dexie schema (six stores), the pure fold, fractional indexing with the
integer-part scheme, the four-step append transaction, replay/repair/point-in-time reconstruction,
the snapshot ladder, storage persistence, backups and restore, NFC + chillu normalisation.

**Editing (Phase 2).** Virtualised rendering (12 blocks in the DOM out of 1,563), the grapheme
layer, the height cache, the caret handoff, the composition-guarded focused editor, import, and
real IME coverage via CDP.

**Malayalam (Phase 3).** Manjari bundled and verified (72 KB, layout features intact, shaping
asserted in Node and in a real shaper), offset-mapped folding, and in-app search — a cursor over
`blocks` with whole-word and case options, cluster-safe excerpts, and a panel that scrolls the
virtualiser to a result and marks it.

**Signals (Phase 4).** Attention telemetry, entirely local, in `src/signals/`:

- **The attention model** (`attention.ts`) — ADR-0017's four gates: visibility, a 60 s idle
  cutoff, centre weighting, and a 1 s settle before a block accrues at all. Pure, with time as a
  parameter, so the synthetic-session tests drive ten minutes of reading and eight hours of an
  abandoned phone in milliseconds.
- **Hesitation and backspace density** (`typing.ts`) — measured from keystrokes, with the
  `isComposing` check inside the module rather than at the call site.
- **Scroll-back** (`scrollback.ts`) — upward movement of ≥ 200 px, accumulated across samples,
  followed by ≥ 2 s settled on one block.
- **Batched writes** (`queue.ts`) — coalesced by (kind, block), flushed on a 2 s timer or on
  `visibilitychange`, bounded, and dropped rather than retried on failure.
- **The sampler** (`collector.ts`) — reads the ~12 rendered rows once a second. **No
  `IntersectionObserver`**; see ADR-0025 for why, and the correction below.
- **Reading back and pruning** (`queries.ts`) — per-block totals and rankings over a window or one
  session, and the 90-day retention prune, which runs after the first status load rather than
  alongside it.
- Every tunable is a named constant in `constants.ts`, which is the module ADR-0017 says to come
  back to.

**Resume (Phase 5).** The four-destination strip of ADR-0023, in `src/features/resume/`:

- **`destinations.ts`** — the four queries. Last edited is the most recently updated block with
  `revisionCount > 0` (the filter is what stops a fresh import from offering the importer's last
  paragraph as "where you were"); most rewritten is the highest revision count inside a seven-day
  window; last read and longest dwelled come from the previous session's gated dwell.
- **`preference.ts`** — pick counts in `settings`, a five-pick floor before anything is
  emphasised, ties broken by the fixed order.
- **`ResumeStrip.tsx`** — four slots in fixed order, absent ones rendered and disabled so the
  positions never move. The learned favourite is the *default*: emphasised, and what Enter or a
  tap on the strip itself activates. Shown once per launch; gone once used or dismissed.
- **ADR-0026** — "last read" is the deepest paragraph *dwelled on* last session, not a stored
  scroll offset.

**Visibility (Phase 6).** Requirement 2, in `src/features/visibility/` and `src/render/`:

- **`intensity.ts`** — PURE. The value behind the margin bar and the minimap: opacity from
  `updatedAt` decayed in ADR-0006's bands, saturation from `revisionCount`. Returns `null` for a
  never-revised block, so an import lights nothing (ADR-0027, the same `revisionCount > 0` filter
  as "last edited"). Stores nothing; time is a parameter.
- **`MarginBar.tsx`** — the 4 px gutter bar (ADR-0005). One hue mixed toward neutral by saturation
  and faded by opacity, so the signal is never hue (colour-blind safe). A sibling of the block
  inside `.doc-block`, so it cannot reflow a glyph and it aligns even when a seam sits above.
- **`minimap.ts` + `Minimap.tsx`** — the bucketed minimap (ADR-0021), drawn to a canvas. One
  bucket per device-pixel row, each the *maximum* intensity of its blocks; a tap jumps to the
  winning block or a proportional position. O(1) in document size; reads only the index. Memoised
  so it does not redraw while scrolling.
- **`seams.ts` + `Seam.tsx`** — ghost markers (ADR-0018). A seam at every deletion join reveals the
  deleted text and restores it in place; consecutive deletions collapse into one. A merge leaves no
  ghost (ADR-0028) — its `delete` carries `mergedInto`, the fold records it on `meta`, and seam
  computation skips it. A deliberate **Delete** control on the focused block is what makes a ghost.
- **`bookmarks.ts` + `BookmarksPanel.tsx`** — the `scrollback` signal's consumer at last: the
  places the writer keeps returning to, ranked by how often, reached from the toolbar.
- **`feedback.ts`** — haptic tick and/or visual pulse past an edit (ADR-0022), both opt-in and off
  by default; haptics feature-detected and shown unavailable where the API is absent. The
  when-to-pulse decision is pure and unit-tested; the scroll handler forces no layout and is inert
  until enabled.

**Tests: 286 unit + 47 e2e + 6 perf, all passing.**

## Measured performance

Against the 80,022-word / 1,563-block synthetic Malayalam corpus, in this container, perf suite
serial. Ranges are across three runs.

| Metric | Budget | Phase 6 | Phase 5 |
|---|---|---|---|
| Cold open | < 1.5 s | **156–180 ms** | 154–188 ms |
| Keystroke handler | < 16 ms | **0.78–0.81 ms median, 1.08–1.14 ms p95** | 0.78–0.83 ms median |
| Frame interval while typing | < 33 ms p95 | **16.8–16.9 ms** | 16.8–16.9 ms |
| Scroll frame interval | < 33 ms p95 | **17.1 ms p95** | 17.1–17.2 ms p95 |
| Memory after full scroll | < 150 MB | **4.2 MB** | 3.8–4.2 MB |
| Search, whole-document miss | < 250 ms scan | **70–77 ms** | 73–91 ms |
| Search, 1,064 matches | < 250 ms scan | **94–105 ms** | — |
| Blocks in DOM | — | **12** of 1,563 | 12 |

**Visibility cost nothing measurable against Phase 5.** The margin bar is a few map lookups per
rendered row (~12), the minimap is a canvas redrawn only when the index changes (not on scroll),
seams are computed in the one ordered read the index already does, and the scroll-feedback handler
is inert until a setting turns it on — so with feedback off, the perf run's scroll path is
untouched.

## What does not work yet

- **No time-lapse or corpus export.** Phase 7. Nothing is stubbed — an empty button is worse than
  an absent one.
- **The margin bar decays on re-render, not on a timer.** DocumentView reads the clock once per
  render, so a bar fades when a scroll or edit re-renders the list — not while the reader sits
  still on one screen for an hour. Acceptable (fading is slow); a periodic re-render would fix it if
  it ever matters.
- **The minimap maps by block index, not pixel height.** Buckets are assigned by position in the
  ordered list, so a bucket's *vertical* position is only approximate against a document of uneven
  block heights (ADR-0021 accepts this). The *jump* is exact — the bucket carries the block index.
- **Ghost restore of a merge is deliberately impossible** (ADR-0028). A merge leaves no seam; its
  text lives in the neighbour. The `meta.mergedInto` needed for a future "unmerge" is recorded, but
  unmerge is not built.
- **Resume does not restore a scroll position, and deliberately does not** (ADR-0026). It offers
  four blocks. A writer who revises backwards through a manuscript gets "deepest" where he means
  "where I stopped"; the ADR names the switch and the data for it is already stored.
- **The ADR-0017 constants, and Phase 6's tunables, have never been revisited against real use.**
  60 s, 1 s, the 2 s scroll-back dwell, the 2 s hesitation floor, `REWRITE_WINDOW_DAYS`, and the
  ADR-0006 decay bands / saturation curve are all guesses. A resume or bookmark suggestion that
  feels wrong, or a margin bar that fades too fast or slow, is the symptom to watch for.
- **Signals are flushed on `visibilitychange` only**, not `pagehide`. On the platforms that matter
  this fires before freeze; if a device is found where it does not, that is where to look for
  missing telemetry.
- **Noto Sans Malayalam is not bundled and the optional-download flow is not built.** ADR-0019
  offers it; `scripts/subset-fonts.sh` will subset it if the TTF is dropped into `vendor/fonts`.
  Manjari Bold is in the same position.
- **Search has no replace, no regex and no ranking** (ADR-0015 puts ranking out of scope), and
  results cap at 100 paragraphs with an honest count past the cap.
- **No cross-block selection**, by design (ADR-0011). Of the three mitigations named there,
  in-app search now exists; **range-select mode and the copy affordances do not.**
- **The scroll-past visual pulse has no e2e.** Vibration can't be asserted in a headless browser
  and the pulse-on-scroll is timing-sensitive; `EditedRegionPulse` is unit-tested and the e2e
  covers the settings and their honesty. The pulse on a real scroll is manual-only.
- **Service worker asset list is hand-maintained.** (Phase 6 needed no change — its code is in the
  JS bundle, which is runtime-cached, not in the hand-listed shell of fonts/icons/manifest.)
- **`memory` perf test needs cross-origin isolation**, supplied by `vite.config.ts`
  `preview.headers`. It will silently skip if those headers are ever removed.

## The next three tasks

1. **Time-lapse + export** (Phase 7). The scrub UI that materialises past states — the reason
   snapshots exist (ADR-0009) and run in a Worker — and the edit-corpus export (ADR-0012, ADR-0016):
   (before, after) pairs walked from the log per block, session-coalesced and triviality-filtered
   at export. Both are batch operations where cost does not matter, which is the whole point of
   deferring them here.

2. **Range-select mode and copy affordances** (ADR-0011). The one accepted-limitation ADR whose
   mitigation is still outstanding. Whole-block granularity by tap and extend; copy block, copy
   range, copy document. Block-granular selection composes naturally with the Phase 6 Delete
   affordance and ghost markers.

3. **Revisit the guessed constants** — the four in `signals/constants.ts` (ADR-0017),
   `REWRITE_WINDOW_DAYS` in `features/resume/destinations.ts`, and the ADR-0006 decay bands and
   saturation curve in `features/visibility/intensity.ts`. This needs a person writing in the app
   for a few sessions; no automated run substitutes for it. A resume suggestion that feels wrong, or
   a margin bar that fades wrong, is the symptom.

## Traps a fresh session will fall into

**Do not read something asynchronous once and assert on it.** This has now bitten three tests in
three phases, and it is always the same shape: a row renders before its text arrives, the toolbar
shows an ellipsis before the status load finishes, a batch is queued before it is flushed. Wait
for the value (`expect.poll`, `toContainText`), do not snapshot it. Phase 4 fixed two of these —
`editing.spec.ts` compared the editor against a `textContent()` captured as `" "`, and the perf
suite's window test read "0 blocks" — and both failed only on a busy machine, which means they
failed as flakes long before anyone read them as bugs.

**Signal capture is the one thing allowed on the keystroke path, and only because it cannot be
anywhere else.** A hesitation is the gap between two keystrokes; it exists only at keystroke time.
What runs there is two map lookups and a subtraction, and the result goes into an in-memory queue.
If anything else ends up in `TypingSignals.input`, the 16 ms budget is where it will show.

**Check `isComposing` in `signals/typing.ts`, not at the call site.** The editor has its own guard
for its own reasons (ADR-0010), but the collector is separate code with a separate reason: during
composition Chrome fires an input event per candidate keystroke and reports keyCode 229 for every
key. Counting those spikes backspace density wherever an IME rewrote its own buffer and collapses
hesitation to the IME's cadence. `tests/e2e/signals.spec.ts` drives a real composition through CDP
and asserts zero signals; `tests/unit/typing.test.ts` covers the same at the unit level.

**Composing keystrokes are not counted, but they DO move the hesitation clock.** They are real
keypresses by a real writer. Ignoring them entirely reports a composition plus the pause after it
as one long thought, which is the opposite error.

**Dwell is not "the block was on screen".** Four gates, all in `attention.ts`, all tested. If you
find yourself adding a fifth (re-settling on return from the background was the tempting one),
write an ADR rather than adding it quietly — the model is the feature.

**Do not measure with the perf suite running in parallel.** `fullyParallel: false` on the perf
project exists because two budgets sharing four cores inflate each other by an amount that depends
on which pair happened to overlap.

**Search offsets are into the ORIGINAL text, not the folded form.** Folding changes length —
`അവന്‍` is five codepoints and folds to four — and the error accumulates with every folded cluster
before the match. `foldWithOffsets` exists for this and there is a test that folds every documented
string both ways and requires they agree.

**Do not build an offset map to answer a question that does not need one.** `foldWithOffsets`
segments the text, which is the expensive half of a search. `hasMatch` and `countMatches` are
deliberately map-free; making `countMatches` call `findMatches().length` cost 100 ms on a common
query over the corpus.

**Activate the editor on `click`, never `pointerdown`.** Swapping the read-only div for a textarea
on pointerdown mounts and focuses the field, and then the browser finishes the gesture it already
started: the following mousedown's default action moves focus away from the field we just focused.
The editor mounts and blurs inside one gesture, so the tap appears to do nothing. See the comment
in `BlockRow.tsx`.

**`.block-row` and `.block-editor` must render text identically.** Any difference in font, size,
line-height, padding or width makes text jump at the moment of tapping — exactly when the reader
is looking at it. The two CSS rules are deliberately adjacent in `theme.css` so they cannot drift.

**The `blocks` table looks like normal mutable state. It is not.** It is a projection, written
only by `fold()` inside the append transaction alongside the `lastAppliedSeq` watermark. Calling
`db.blocks.put()` outside `core/events.ts` breaks crash safety and fails no test you have written.
See ADR-0008. (`features/io/import.ts` is a sanctioned exception and says so.)

**Get-or-create needs a transaction.** `openDoc` exists because check-then-`add` outside one is a
race with the same shape as reading max(seq) before appending (ADR-0020).

**`Block.order` is a string.** Float midpoints exhaust f64 precision after ~50 sequential inserts
at one position — an ordinary afternoon of writing. Compare lexicographically. See ADR-0007.

**`prevText` is usually absent, and that is correct.** Derivable from the previous event for the
same block. Populating it doubles the log. `delete` events are the exception. See ADR-0012.

**NFC does not solve chillu.** Atomic chillu (U+0D7B) and its ZWJ sequence are deliberately not
canonically equivalent. `normalizeForCompare()` applies NFC **and** an explicit chillu fold. The
corpus makes the size of that visible: it writes `അവൻ` 754 times atomically and 819 times as the
ZWJ sequence, and the perf suite asserts search finds all 1,573.

**ZWJ and ZWNJ are word characters.** Not whitespace, not separators (Rule 3). Drop them from
`WORD_CHAR` in `text/search.ts` and whole-word search starts matching inside longer words.

**Normalisation is for comparison only.** Stored text keeps its original bytes so import → export
is byte-faithful. Normalising on write silently rewrites the user's manuscript. See ADR-0014.

**Do not commit while `isComposing`.** Covered by `tests/e2e/ime.spec.ts`, which drives real
composition sessions via CDP `Input.imeSetComposition`. Remove the guard and two of those tests
fail, one by committing an EMPTY block. Platform behaviour (real Gboard, iOS keyboards,
transliteration, swipe, autocorrect) is still only covered by the manual checklist in
`docs/MALAYALAM.md`, which has not been run on real devices.

**Do not measure "keystroke to paint" by waiting for `requestAnimationFrame`.** rAF is quantised
to the display refresh, so that reports ~16.7 ms however fast the handler is — it looks like a
failing budget and is a broken ruler. Measure the synchronous handler cost and, separately,
whether frames are dropped while typing. `tests/perf/budgets.spec.ts` does both.

**`ts` never orders anything.** Wall clocks move backwards. Order by `(seq, deviceId)`.

**`core/` must not import React or the DOM.** That purity lets replay run in a Worker. `signals/`
is not `core/`, but `attention.ts` and `scrollback.ts` keep the same discipline deliberately, and
that is what makes the ADR-0017 tests possible.

**Restore semantics differ from insert.** An `insert` naming an existing soft-deleted block is a
restore. Absent `afterBlockId` means "append at end" for a fresh insert but "put it back where it
was" for a restore. Deliberate, and tested.

**A merge is a soft delete, but must not leave a ghost.** Backspace-at-start deletes the emptied
block, and its text now lives in the neighbour. `mergeBack` passes `mergedInto` so the fold records
`meta.mergedInto` and `computeSeams` skips it (ADR-0028). Drop that and every Backspace-merge grows
a seam whose "restore" duplicates text. A *deliberate* delete (the Delete button) omits `mergedInto`
— that is the only thing that should ever make a ghost.

**The margin bar keys off `revisionCount > 0`, not `updatedAt` alone** (ADR-0027). `markIntensity`
returns `null` for a never-revised block, so an import lights nothing. If you make the bar decay
purely on `updatedAt`, the whole document glows the instant it is imported and the feature says
nothing. Same filter, same reason, as the "last edited" resume destination.

**The delete affordance fires on `onMouseDown`, not `onClick`.** A click would blur the editor
first, committing and clearing focus before the handler ran, and the button would be gone. It calls
`preventDefault()` to keep the blur from happening at all. (Symmetric to the `click`-not-
`pointerdown` rule for opening the editor, for the opposite reason.)

**The minimap reads the palette from the canvas element, and redraws on a theme flip.** Canvas
cannot use CSS `color-mix`, so `Minimap.tsx` parses `--accent` and `--ink-muted` via
`getComputedStyle` and interpolates in JS. It listens on `matchMedia('(prefers-color-scheme:
dark)')` so a theme change repaints; a `data-theme` toggle that does not go through that media query
would need another trigger.

**A seam's revealed state is local and collapses when the row recycles.** The `Seam` lives inside a
virtualised `.doc-item`; scroll it out and back and it remounts collapsed. That is fine — reveal is
a momentary action — but do not build anything that assumes a seam stays open across a scroll.

**Scroll-past feedback must stay off the scroll budget.** The handler in `DocumentView` reads state
through refs, finds the centre block from the virtualiser's content-relative offsets (no layout
read), throttles to ~10 Hz, and returns immediately when both toggles are off. Anything heavier
here lands on the 33 ms scroll frame. The pulse decision itself is pure (`EditedRegionPulse`).

**The minimap wraps the scroller in `.doc-viewport`.** DocumentView's main return is
`.doc-viewport > (.doc-scroll + <Minimap>)`, and the flex sizing moved from `.doc-scroll` to
`.doc-viewport` (`theme.css`). The loading/empty early returns are still bare `.doc-empty`. If you
restructure the return, keep the scroller a direct measured child or the virtualiser's height math
breaks.

**Playwright needs `PLAYWRIGHT_CHROMIUM_PATH`** in this container — the preinstalled Chromium
build (1194) does not match the one this Playwright version wants (1234). Set it to
`/opt/pw-browsers/chromium`. CI installs its own browser and leaves it unset.

**Re-subsetting the font needs fonttools.** `pip install 'fonttools[woff]'` — pypi is reachable
from this container, GitHub is not.

**Fake timers and fake-indexeddb do not mix.** `vi.useFakeTimers()` with its default `toFake`
deadlocks any test that waits on a Dexie write, because fake-indexeddb drives its transactions
through `setImmediate`. Fake `setTimeout`/`clearTimeout` only.

## Decisions already made — do not relitigate

All 28 are in `DECISIONS.md`. The seventeen that departed from the original brief:

| ADR | Departure |
|---|---|
| 0007 | `order` is a string; float midpoints corrupt after ~50 same-position inserts |
| 0008 | Projection written in the same transaction as the event, with a watermark |
| 0009 | Snapshots serve time travel, not cold open; logarithmic retention ladder |
| 0010 | IME composition guard — absent from the brief entirely |
| 0011 | Cross-block selection accepted as lost, mitigated explicitly |
| 0012 | `prevText` omitted when derivable; corpus compaction at export |
| 0013 | Eviction handling and scheduled backups moved to Phase 1 |
| 0014 | Normalise for comparison, preserve bytes for round trip |
| 0017 | Dwell gated by an attention model |
| 0019 | One bundled font; layout features preserved through subsetting |
| 0021 | Minimap buckets by max intensity, not per-block ticks |
| 0022 | Haptics are Android-only; `navigator.vibrate` does not exist on iOS Safari |
| 0023 | Resume strip order fixed; preference learned as default, not layout |
| 0024 | The subsetter's defaults were never the danger; the guarantee moves to the output |
| 0025 | Dwell is sampled on a timer; no `IntersectionObserver` |
| 0026 | "Last read" is the deepest paragraph dwelled on, not a scroll offset |
| 0027 | The margin bar marks revision (`revisionCount > 0`), not arrival, so imports do not light |
| 0028 | A merge is not a deletion and leaves no ghost; `delete` carries `mergedInto` |

## Corrections made so far

**Phase 1 — ADR-0009.** Originally claimed the retention ladder kept any point in history within a
bounded number of events of an anchor. The test showed otherwise: the oldest anchors are dropped,
so an early target replays from empty. The real guarantee is better and now stated everywhere —
**reconstructing any past state never replays more events than lie between it and the present.**

**Phase 1 — `docs/PERFORMANCE.md`** claimed a breached budget was "a failing build" while no CI
existed. CI now exists, and the doc says which suites run where and why perf is excluded.

**Phase 2 — "composition cannot be tested".** Claimed repeatedly, in ADR-0010, in
`docs/MALAYALAM.md` and in code comments. It was wrong: CDP's `Input.imeSetComposition` drives a
genuine composition session in Chromium. `tests/e2e/ime.spec.ts` now covers the guard, verified by
mutation. Only *platform* IME behaviour remains manual.

**Phase 2 — CI ran the perf suite.** `npm run test:e2e` was bare `playwright test`, which runs
every project including the one the workflow says it excludes. Scoped now.

**Phase 2 — the memory probe checked existence, not availability.**
`measureUserAgentSpecificMemory` is present without cross-origin isolation and throws when called.
It now checks `crossOriginIsolated` and wraps the call.

**Phase 3 — "pyftsubset strips layout features by default".** Repeated in ADR-0019, in
`scripts/subset-fonts.sh` and in Rule 7, and false. What breaks Malayalam is an explicitly emptied
`--layout-features` or `--no-layout-closure`, each of which takes 912 glyphs down to 323. See
ADR-0024. The flag stays; the guarantee moved from the flag to a verifier and two tests.

**Phase 3 — the shaping assertion did not exist.** Three documents said a test asserted the
expected shaped output. There was no such test. There are two now.

**Phase 3 — the e2e reset never reliably deleted the database.** It issued the delete from the
page that had the database open, so the request fired `blocked` rather than `success`. Fixed, and
it exposed two real races behind it — importing before the document exists, and two concurrent
creates.

**Phase 3 — the perf suite measured a busier machine than it thought.** `fullyParallel` ran two
budgets concurrently on four cores. Serially, scroll p95 is 17.0 ms rather than 18.6 and cold open
138 ms rather than 197.

**Phase 4 — `IntersectionObserver` was the wrong mechanism.** `docs/SIGNALS.md` specified it for
dwell. IO reports threshold *crossings*, and the attention model needs a value over *time*, so a
timer is required either way and IO would only feed it staler geometry — while adding an observer
to attach and detach on every row the virtualiser recycles. The question IO answers cheaply, "which
elements are near the viewport", was already answered by virtualisation: a dozen rows exist in the
DOM. ADR-0025 records the change; ADR-0017's four gates are untouched.

**Phase 4 — "signal capture is deferred to idle or the commit boundary"** (`ARCHITECTURE.md`). Not
quite true, and it cannot be: the gap between two keystrokes only exists at keystroke time. The
observation happens in the handler and costs two map lookups; the *work* — the write, the geometry,
the model — is what is deferred. The doc now says so.

**Phase 4 — the toolbar could report the document as it was before an import.** Chasing the test
failure above found a real one behind it. Two status loads overlap on the import path: the one
`App` fires on mount and the one the import fires when it finishes. On a large document the first
is the slower — it walks the log to check the projection — so its result lands last and
`setStatus` overwrites the fresh count with the stale one. The toolbar then reads "0 words ·
0 blocks" over 80,000 words that are visibly on screen, and nothing refreshes it until a reload.
`refresh()` now carries a ticket and ignores results that are not the newest.

**Phase 4 — two tests read asynchronous values once.** `editing.spec.ts` captured a row's
`textContent()` before its text had loaded and compared the editor to `" "`; the perf suite's
bounded-window test read the toolbar's block count before the status load finished and asserted on
`0`. Both predate this phase and both surfaced under Phase 4's extra mount-time render. Fixed by
waiting for the value rather than snapshotting it.

## Conventions

`CLAUDE.md` — commit style, test requirements, the non-negotiable rules. Read before writing code.
