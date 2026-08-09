# Handoff

**Written for a session with no memory of the previous one.** Read this first. Updated at the end
of every working session — if it is stale, that is a bug.

**Last updated:** 2026-08-09 · end of Phase 3

---

## Where the project is

**Phases 1, 2 and 3 complete.** The event log and its durability layer work, there is a working
editor on top of them, the document renders in a bundled Malayalam face that shapes correctly, and
search finds words the reader can see anywhere in a 1,563-block document.

**Phases 1-2 were merged to `main` via PR #1.** Phase 3 is on
`claude/ezhuthu-phase3-hjjo9v`. Start Phase 4 from a fresh branch off whatever has landed on
`main`:

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

**Malayalam (Phase 3).**

- **Manjari bundled** (`public/fonts/manjari-regular.woff2`, 72 KB) — the Malayalam block, Latin-1
  and the joiners, all layout features preserved. Precached by the service worker, preloaded from
  `index.html`, `font-display: block`.
- **`scripts/subset-fonts.sh` actually runs.** It fetches its own source from npm and verifies its
  own output through `scripts/verify-font.py`, which fails on a missing feature, a missing
  GPOS/GDEF, a missing joiner, or a glyph count that says layout closure was off.
- **The shaping assertion exists**, in two halves: `tests/unit/fonts.test.ts` reads the committed
  woff2 in Node (including a deliberately-broken fixture so it can be seen to fail), and
  `tests/e2e/fonts.spec.ts` measures `ക്ക` against its ZWNJ-suppressed form in a real shaper.
- **Offset-mapped folding** (`text/normalize.ts` `foldWithOffsets`) — matching happens on the
  folded form and results come back in offsets into the original text.
- **Search** (`text/search.ts`, `features/search/`) — a cursor over `blocks`, whole-word and
  case options, block-order results with cluster-safe excerpts, and a panel that scrolls the
  virtualiser to a result and marks it.
- **ADR-0024** corrects what ADR-0019 claimed about subsetting; Rule 7 in `docs/MALAYALAM.md`
  matches it now.

**Tests: 192 unit + 23 e2e + 6 perf, all passing.**

## Measured performance

Against the 80,022-word / 1,563-block synthetic Malayalam corpus, in this container, with the perf
suite now running **serially** — it used to run two budgets at once, so the Phase 2 numbers were
measured on a busier machine than we thought. Ranges are across three runs.

| Metric | Budget | Phase 3 | Phase 2 (parallel) |
|---|---|---|---|
| Cold open | < 1.5 s | **138–163 ms** | 145 ms |
| Keystroke handler | < 16 ms | **0.83–0.92 ms** median, 1.28 ms p95 | 1.05 ms median |
| Frame interval while typing | < 33 ms p95 | **16.9–20.2 ms** | 18.1 ms |
| Scroll frame interval | < 33 ms p95 | **17.0–17.3 ms** p95 | 17.6 ms |
| Memory after full scroll | < 150 MB | **3.6–3.7 MB** | 3.6 MB |
| Search, whole-document miss | < 250 ms scan | **83–94 ms** | — |
| Search, 1,064 matches | < 250 ms scan | **116–120 ms** | — |
| Blocks in DOM | — | **12** of 1,563 | 12 |

The search figures are the scan alone. The perf test measures keystroke-to-results, which is
~180 ms higher because of the panel's debounce; both numbers are printed.

Bundling the font cost nothing measurable at cold open, which is expected — it is precached and
72 KB.

## What does not work yet

- **No signals, resume, margin bar, minimap, ghost markers, time-lapse, or corpus export.**
  Phases 4-7. Nothing is stubbed — an empty button is worse than an absent one.
- **Noto Sans Malayalam is not bundled and the optional-download flow is not built.** ADR-0019
  offers it; `scripts/subset-fonts.sh` will subset it if the TTF is dropped into `vendor/fonts`,
  but nothing fetches or caches it. Manjari Bold is in the same position.
- **Search has no replace, no regex and no ranking.** ADR-0015 puts ranking and fuzzy matching out
  of scope for v1; regex would be nearly free on top of what is there.
- **Search results cap at 100 paragraphs.** The count past the cap is honest and the UI says so.
- **No cross-block selection**, by design (ADR-0011). Of the three mitigations named there,
  in-app search now exists; **range-select mode and the copy affordances do not.**
- **Deleted blocks are dropped from the index**, so merging two blocks leaves a soft-deleted
  record with no seam rendered. Ghost markers are Phase 6; the data is already there.
- **Service worker asset list is hand-maintained** — and now has a font in it, so Phase 8's
  generated manifest matters slightly more than it did.
- **`memory` perf test needs cross-origin isolation**, supplied by `vite.config.ts`
  `preview.headers`. It will silently skip if those headers are ever removed.

## The next three tasks

1. **Signals** (Phase 4). Capture with the attention model in ADR-0017 — visibility, 60 s idle
   cutoff, centre weighting, 1 s settle — batched on a 2 s flush. **Check `isComposing` in every
   keystroke handler**, or hesitation and backspace density are nonsense on IME input. Re-run the
   perf suite afterwards; this is the first feature that competes with typing.

2. **Resume** (Phase 5). The four-destination strip, fixed order, preference learned as the
   pre-selected default with a five-pick floor (ADR-0023).

3. **Range-select mode and copy affordances** (ADR-0011). The one accepted-limitation ADR whose
   mitigation is still outstanding, now that search is done. Whole-block granularity by tap and
   extend; copy block, copy range, copy document.

## Traps a fresh session will fall into

**Do not measure with the perf suite running in parallel.** `fullyParallel: false` on the perf
project exists because two budgets sharing four cores inflate each other by an amount that depends
on which pair happened to overlap. If you see numbers worse than the table above by 10-20%, check
that first.

**Search offsets are into the ORIGINAL text, not the folded form.** Folding changes length —
`അവന്‍` is five codepoints and folds to four — and the error accumulates with every folded cluster
before the match. Report folded offsets and the highlight drifts further the deeper into a
paragraph you go, in Malayalam only. `foldWithOffsets` exists for this and there is a test that
folds every documented string both ways and requires they agree.

**Do not build an offset map to answer a question that does not need one.** `foldWithOffsets`
segments the text, which is the expensive half of a search. `hasMatch` and `countMatches` are
deliberately map-free; making `countMatches` call `findMatches().length` cost 100 ms on a common
query over the corpus.

**Activate the editor on `click`, never `pointerdown`.** This cost real debugging time in Phase 2.
Swapping the read-only div for a textarea on pointerdown mounts and focuses the field, and then
the browser finishes the gesture it already started: the following mousedown's default action
moves focus away from the field we just focused. The editor mounts and blurs inside one gesture,
so the tap appears to do nothing. Waiting for `click` means that default action has already run.
Click is still a user gesture, so the mobile keyboard opens. See the comment in `BlockRow.tsx`.

**`.block-row` and `.block-editor` must render text identically.** Any difference in font, size,
line-height, padding or width makes text jump at the moment of tapping — exactly when the reader
is looking at it. The two CSS rules are deliberately adjacent in `theme.css` so they cannot drift.
The search mark is background-only for the same reason.

**The `blocks` table looks like normal mutable state. It is not.** It is a projection, written
only by `fold()` inside the append transaction alongside the `lastAppliedSeq` watermark. Calling
`db.blocks.put()` outside `core/events.ts` breaks crash safety and fails no test you have written.
See ADR-0008. (`features/io/import.ts` is a sanctioned exception and says so.)

**Get-or-create needs a transaction.** `openDoc` exists because check-then-`add` outside one is a
race with the same shape as reading max(seq) before appending (ADR-0020) — and it fired on most
runs once the e2e reset started reliably emptying the database. If you add another "create it if
it is not there", put it in a transaction.

**`Block.order` is a string.** Float midpoints exhaust f64 precision after ~50 sequential inserts
at one position — an ordinary afternoon of writing. Compare lexicographically. See ADR-0007.

**`prevText` is usually absent, and that is correct.** Derivable from the previous event for the
same block. Populating it doubles the log. `delete` events are the exception. See ADR-0012.

**NFC does not solve chillu.** Atomic chillu (U+0D7B) and its ZWJ sequence are deliberately not
canonically equivalent. `normalizeForCompare()` applies NFC **and** an explicit chillu fold.
Simplify it to `.normalize('NFC')` and search silently stops matching text visible on screen. The
corpus makes the size of that visible: it writes `അവൻ` 754 times atomically and 819 times as the
ZWJ sequence, and the perf suite asserts search finds all 1,573.

**ZWJ and ZWNJ are word characters.** Not whitespace, not separators (Rule 3). Drop them from
`WORD_CHAR` in `text/search.ts` and whole-word search starts matching inside longer words.

**Normalisation is for comparison only.** Stored text keeps its original bytes so import → export
is byte-faithful. Normalising on write silently rewrites the user's manuscript. See ADR-0014.

**Do not commit while `isComposing`.** The single most likely source of user-visible breakage,
more than grapheme handling. This IS covered now: `tests/e2e/ime.spec.ts` drives real composition
sessions via CDP `Input.imeSetComposition`. Remove the guard and two of those tests fail, one by
committing an EMPTY block — so do not "simplify" it away. The search field's Enter handler is
guarded for the same reason: during composition Chrome reports keyCode 229 for everything, so an
unguarded Enter is the IME accepting a candidate read as "next result". Platform behaviour (real
Gboard, iOS keyboards, transliteration, swipe, autocorrect) is still only covered by the manual
checklist in `docs/MALAYALAM.md`, which has not been run on real devices.

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

**Re-subsetting the font needs fonttools.** `pip install 'fonttools[woff]'` — pypi is reachable
from this container, GitHub is not. `npm run fonts:subset` fetches the source TTF from npm for the
same reason.

## Decisions already made — do not relitigate

All 24 are in `DECISIONS.md`. The thirteen that departed from the original brief:

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

**Phase 3 — "pyftsubset strips layout features by default".** Repeated in ADR-0019, in
`scripts/subset-fonts.sh` and in Rule 7, and false. The default `--layout-features` list already
contains every Indic shaping feature and layout closure is on by default; the default subset of
Manjari renders conjuncts correctly. What breaks Malayalam is an explicitly emptied
`--layout-features` or `--no-layout-closure`, each of which takes 912 glyphs down to 323. See
ADR-0024. The flag stays; the guarantee moved from the flag to a verifier and two tests.

**Phase 3 — the shaping assertion did not exist.** `scripts/subset-fonts.sh` closed by telling the
operator to run it, ADR-0019 said "a test asserts that a known conjunct string shapes to the
expected glyph count", and Rule 7 said "a rendering test asserts...". There was no such test. There
are two now.

**Phase 3 — the e2e reset never reliably deleted the database.** It issued the delete from the
page that had the database open, so the request fired `blocked` rather than `success`, and the
handler treated that as done; the deletion landed later, sometimes after the next page had created
its document. On `main` this makes the suite fail about four runs in five in this container, always
blaming whichever test drew the short straw. Fixed, and it exposed two real races behind it —
importing before the document exists, and two concurrent creates. All three are fixed; the suite
is 7 consecutive clean runs and its wall time dropped from 1.8 minutes to 21 seconds, because the
failures were all 30-second timeouts.

**Phase 3 — the perf suite measured a busier machine than it thought.** `fullyParallel` ran two
budgets concurrently on four cores. Serially, scroll p95 is 17.0 ms rather than 18.6 and cold open
138 ms rather than 197. No budget was ever wrongly reported as met; the numbers were just noisier
and worse than the app deserved.

## Conventions

`CLAUDE.md` — commit style, test requirements, the non-negotiable rules. Read before writing code.
