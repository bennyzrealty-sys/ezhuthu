# Handoff

**Written for a session with no memory of the previous one.** Read this first. Updated at the end
of every working session — if it is stale, that is a bug.

**Last updated:** 2026-08-09 · end of Phase 2

---

## Where the project is

**Phases 1 and 2 complete.** The event log and its durability layer work, and there is a working
editor on top of them: a 1,563-block document renders, scrolls at frame rate, and is editable.

Branch: `claude/ezhuthu-editor-setup-10tfbg`. Every phase ships as its own PR.

## What works

**Foundation (Phase 1).** Dexie schema (six stores), the pure fold, fractional indexing with the
integer-part scheme, the four-step append transaction, replay/repair/point-in-time reconstruction,
the snapshot ladder, storage persistence, backups and restore, NFC + chillu normalisation.

**Editing (Phase 2).**

- **Virtualised rendering** (`render/DocumentView.tsx`) — 12 blocks in the DOM out of 1,563.
  Holds a compact index for every block and fetches text by window, evicting behind.
- **Grapheme layer** (`text/segmenter.ts`) — cached segmenters, boundary snapping, cluster-wise
  cursor movement, cluster-safe truncation for previews.
- **Height cache** (`render/measure.ts`) — per block and per viewport width, bucketed to whole
  pixels, invalidated on edit and on rotation.
- **Caret handoff** (`render/caret.ts`) — `caretPositionFromPoint` with the WebKit
  `caretRangeFromPoint` fallback, text-node walking, grapheme snapping.
- **The focused editor** (`render/BlockEditor.tsx`) — uncontrolled textarea, composition-guarded
  commit, 400 ms idle, Enter to split, Backspace-at-start to merge, cluster-wise ArrowLeft.
- **Import** (`features/io/import.ts`) — blank-line splitting, one transaction for the whole file.
- **IME composition coverage** (`tests/e2e/ime.spec.ts`) — real composition sessions via CDP.
- **Icons and CI** — PNG icons at 192/512/maskable/180; CI runs typecheck, unit, build and e2e.

**Tests: 143 unit + 10 e2e + 5 perf, all passing.**

## Measured performance

Against the 80,022-word / 1,563-block synthetic Malayalam corpus, in this container. Treat as a
regression baseline, not an absolute — re-measure on the same machine when comparing.

| Metric | Budget | Measured |
|---|---|---|
| Cold open | < 1.5 s | **145 ms** |
| Keystroke handler | < 16 ms | **1.05 ms** median, 1.88 ms p95 |
| Frame interval while typing | < 33 ms p95 | **18.1 ms** |
| Scroll frame interval | < 33 ms p95 | **17.6 ms** p95, 19.2 ms worst |
| Memory after full scroll | < 150 MB | **3.6 MB** |
| Blocks in DOM | — | **12** of 1,563 |

Headroom is large enough that Phases 4-7 can afford real work — but signals (Phase 4) are the
first thing that will eat into the typing path, so re-run `npm run test:perf` when adding them.

## What does not work yet

- **No fonts bundled.** `scripts/subset-fonts.sh` has the correct flags; the files land in Phase 3.
  Text currently renders in whatever the device has, which is what ADR-0019 exists to prevent.
- **No search.** `text/search.ts` does not exist yet (Phase 3, ADR-0015).
- **No signals, resume, margin bar, minimap, ghost markers, time-lapse, or corpus export.**
  Phases 4-7. Nothing is stubbed — an empty button is worse than an absent one.
- **No cross-block selection**, by design (ADR-0011). The mitigations named there — range-select
  mode and copy affordances — are **not built yet**. This is the one accepted-limitation ADR whose
  mitigation is still outstanding.
- **Deleted blocks are dropped from the index**, so merging two blocks leaves a soft-deleted
  record with no seam rendered. Ghost markers are Phase 6; the data is already there.
- **Service worker asset list is hand-maintained.** Phase 8 generates it.
- **`memory` perf test needs cross-origin isolation**, supplied by `vite.config.ts` `preview.headers`.
  It will silently skip if those headers are ever removed.

## The next three tasks

1. **Bundle Manjari** (Phase 3). Fetch the OFL font, run `npm run fonts:subset`, add `@font-face`
   and the licence text to `public/fonts/`. **Read ADR-0019 first** — the default subsetter
   settings strip GSUB and break every conjunct. Add the shaping assertion the script's closing
   message refers to; it does not exist yet.

2. **Search** (`src/text/search.ts`, `src/features/search/`). Cursor over the `blocks` store,
   normalising both sides through `normalizeForCompare`. Never touch the DOM (ADR-0015). The
   chillu fold is what makes this find words the reader can see.

3. **Signals** (Phase 4). Capture with the attention model in ADR-0017 — visibility, 60 s idle
   cutoff, centre weighting, 1 s settle — batched on a 2 s flush. **Check `isComposing` in every
   keystroke handler**, or hesitation and backspace density are nonsense on IME input. Re-run the
   perf suite afterwards; this is the first feature that competes with typing.

## Traps a fresh session will fall into

**Activate the editor on `click`, never `pointerdown`.** This cost real debugging time in Phase 2.
Swapping the read-only div for a textarea on pointerdown mounts and focuses the field, and then
the browser finishes the gesture it already started: the following mousedown's default action
moves focus away from the field we just focused. The editor mounts and blurs inside one gesture,
so the tap appears to do nothing. Waiting for `click` means that default action has already run.
Click is still a user gesture, so the mobile keyboard opens. See the comment in `BlockRow.tsx`.

**`.block-row` and `.block-editor` must render text identically.** Any difference in font, size,
line-height, padding or width makes text jump at the moment of tapping — exactly when the reader
is looking at it. The two CSS rules are deliberately adjacent in `theme.css` so they cannot drift.

**The `blocks` table looks like normal mutable state. It is not.** It is a projection, written
only by `fold()` inside the append transaction alongside the `lastAppliedSeq` watermark. Calling
`db.blocks.put()` outside `core/events.ts` breaks crash safety and fails no test you have written.
See ADR-0008. (`features/io/import.ts` is a sanctioned exception and says so.)

**`Block.order` is a string.** Float midpoints exhaust f64 precision after ~50 sequential inserts
at one position — an ordinary afternoon of writing. Compare lexicographically. See ADR-0007.

**`prevText` is usually absent, and that is correct.** Derivable from the previous event for the
same block. Populating it doubles the log. `delete` events are the exception. See ADR-0012.

**NFC does not solve chillu.** Atomic chillu (U+0D7B) and its ZWJ sequence are deliberately not
canonically equivalent. `normalizeForCompare()` applies NFC **and** an explicit chillu fold.
Simplify it to `.normalize('NFC')` and search silently stops matching text visible on screen. A
test asserts both halves — leave it that way.

**Normalisation is for comparison only.** Stored text keeps its original bytes so import → export
is byte-faithful. Normalising on write silently rewrites the user's manuscript. See ADR-0014.

**Do not commit while `isComposing`.** The single most likely source of user-visible breakage,
more than grapheme handling. This IS covered now: `tests/e2e/ime.spec.ts` drives real composition
sessions via CDP `Input.imeSetComposition`. Remove the guard and two of those tests fail, one by
committing an EMPTY block — so do not "simplify" it away. Platform behaviour (real Gboard, iOS
keyboards, transliteration, swipe, autocorrect) is still only covered by the manual checklist in
`docs/MALAYALAM.md`, which has not been run on real devices.

**Do not measure "keystroke to paint" by waiting for `requestAnimationFrame`.** rAF is quantised
to the display refresh, so that reports ~16.7 ms however fast the handler is — it looks like a
failing budget and is a broken ruler. Measure the synchronous handler cost and, separately,
whether frames are dropped while typing. `tests/perf/budgets.spec.ts` does both.

**`ts` never orders anything.** Wall clocks move backwards. Order by `(seq, deviceId)`.

**`core/` must not import React or the DOM.** That purity lets replay run in a Worker.

**Restore semantics differ from insert.** An `insert` naming an existing soft-deleted block is a
restore. Absent `afterBlockId` means "append at end" for a fresh insert but "put it back where it
was" for a restore. Deliberate, and tested.

**Playwright needs `PLAYWRIGHT_CHROMIUM_PATH`** in this container — the preinstalled Chromium
build (1194) does not match the one this Playwright version wants (1234). Set it to
`/opt/pw-browsers/chromium`. CI installs its own browser and leaves it unset.

## Decisions already made — do not relitigate

All 23 are in `DECISIONS.md`. The twelve that departed from the original brief:

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
mutation — removing the isComposing check makes it commit an empty block. Only *platform* IME
behaviour remains manual.

**Phase 2 — CI ran the perf suite.** `npm run test:e2e` was bare `playwright test`, which runs
every project including the one the workflow says it excludes. Missed because the script was never
invoked by hand — `--project=e2e` always was. Scoped now.

**Phase 2 — the memory probe checked existence, not availability.**
`measureUserAgentSpecificMemory` is present without cross-origin isolation and throws when called.
It now checks `crossOriginIsolated` and wraps the call.

## Conventions

`CLAUDE.md` — commit style, test requirements, the non-negotiable rules. Read before writing code.
