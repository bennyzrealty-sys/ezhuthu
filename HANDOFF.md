# Handoff

**Written for a session with no memory of the previous one.** Read this first. Updated at the end
of every working session — if it is stale, that is a bug.

**Last updated:** 2026-08-09 · end of Phase 1

---

## Where the project is

**Phase 1 — Foundation. Complete.** The event log, the fold, replay, snapshots and the storage
durability layer all work and are tested. There is no editor yet; that is Phase 2.

Branch: `claude/ezhuthu-editor-setup-10tfbg`. Every phase ships as its own PR.

## What works

- **Scaffold** — Vite + React 19 + TypeScript, strict including `noUncheckedIndexedAccess`.
  `npm run dev`, `build`, `typecheck` all clean.
- **Documentation set** — README, ARCHITECTURE, DECISIONS (23 ADRs), CLAUDE, and `docs/`
  (DATA-MODEL, MALAYALAM, SIGNALS, PERFORMANCE). This is the contract; read before coding.
- **Dexie schema** (`src/db/`) — six stores exactly as documented, with the indexes each feature
  needs. `settings` was added beyond the original spec to hold the backup directory handle, which
  is structured-cloneable and cannot live in localStorage.
- **The fold** (`src/core/fold.ts`) — pure, no React/DOM/Dexie. Handles insert, update, soft
  delete, restore and move. Maintains a sorted order index incrementally so replay is not
  quadratic.
- **Fractional indexing** (`src/core/order.ts`) — full integer-part scheme, so 2,000 sequential
  appends produce keys ≤ 5 characters instead of growing without bound.
- **The append path** (`src/core/events.ts`) — the four-step transaction from ADR-0008. Reads only
  the neighbours it needs, so appending never scans the document.
- **Replay and repair** (`src/core/replay.ts`) — watermark check, tail repair, full rebuild, and
  point-in-time reconstruction for the future scrub.
- **Snapshots** (`src/core/snapshots.ts`) — logarithmic retention ladder.
- **Durability** (`src/db/persistence.ts`) — persistence request, honest reporting, quota
  estimate, backup build/write/restore, urgency escalation.
- **Text** (`src/text/`) — NFC + chillu fold for comparison, word and grapheme counting.
- **Corpus generator** — `npm run corpus:generate` produces 80,022 words / 1,563 paragraphs of
  synthetic Malayalam with realistic shaping (chillu in both encodings, 2–4 consonant conjuncts,
  ZWNJ, interleaved Latin and digits).
- **PWA scaffolding** — manifest and a cache-first shell service worker.
- **105 unit tests**, all passing. `npm test`.

## What does not work yet

- **No editor.** No block rendering, no virtualisation, no typing. Phase 2.
- **No fonts bundled.** `scripts/subset-fonts.sh` exists with the correct flags, but the font
  files themselves land in Phase 3.
- **Icons are SVG only.** `public/icons/icon.svg` is used for both the manifest and
  `apple-touch-icon`. **iOS needs PNG for a proper home-screen icon**, so install on iOS will look
  wrong until PNGs are generated. This matters more than it sounds: home-screen installation is
  what improves eviction odds on iOS (ADR-0013).
- **No e2e or perf tests yet.** Playwright is configured with `e2e` and `perf` projects and the
  corpus exists, but no specs are written — there is nothing to drive until Phase 2.
- **Service worker asset list is hand-maintained.** Fine for a shell of four files; Phase 8
  replaces it with a build-generated precache manifest.
- **`Intl.Segmenter` cursor operations are not built.** Only counting is. Grapheme-aware cursor
  movement, selection and the tap-to-caret mapping are Phase 2/3.

## The next three tasks

1. **Block rendering with TanStack Virtual** (`src/render/DocumentView.tsx`, `BlockRow.tsx`).
   Read-only rows, dynamic measurement, height cache keyed by `blockId` + viewport width. Seed
   from the corpus via `scripts/seed-db.ts` (not written yet — bulk-insert with
   `generateNKeysBetween`, do NOT chain `insertBlock` 1,563 times).

2. **The focused editor** (`src/render/BlockEditor.tsx`) — the hard part of Phase 2. Swap a
   read-only div for an editable field on tap, land the caret where the finger went via
   `caretPositionFromPoint` / `caretRangeFromPoint`, snap to a grapheme boundary, and commit on
   `compositionend` + 400 ms idle. **Read ADR-0010 before starting.**

3. **The perf suite** (`tests/perf/`) — cold open, scroll fps, keystroke latency, memory, against
   the 80k corpus. Budgets in `docs/PERFORMANCE.md`. Write these as Phase 2 lands, not after;
   they are the only thing standing between this and an editor that dies at 50k words.

## Traps a fresh session will fall into

**The `blocks` table looks like normal mutable state. It is not.** It is a projection, written
only by `fold()` inside the append transaction, alongside the `lastAppliedSeq` watermark. Calling
`db.blocks.put()` from anywhere outside `core/events.ts` breaks the guarantee that makes crash
safety work, and it will not fail any test you have written. See ADR-0008.

**`Block.order` is a string.** The original brief said `number`, and float midpoints exhaust f64
precision after ~50 sequential inserts at the same position — an ordinary afternoon of writing,
after which block order silently corrupts. `tests/unit/fold.test.ts` does 500 of them. Compare
lexicographically; never sort numerically. See ADR-0007.

**`prevText` is usually absent, and that is correct.** It is derivable from the previous event for
the same block. Do not "fix" the missing field — that doubles the log. `delete` events are the
exception and always carry full text. See ADR-0012.

**NFC does not solve chillu.** Atomic chillu (U+0D7B) and its ZWJ sequence are deliberately *not*
canonically equivalent, so no normalisation form unifies them. `normalizeForCompare()` applies NFC
**and** an explicit chillu fold. If you simplify it to `.normalize('NFC')` because the extra step
looks redundant, search will silently stop matching text visible on screen. A test asserts both
halves, so this fails loudly — leave it that way.

**Normalisation is for comparison only.** Stored text keeps its original bytes so import → export
is byte-faithful. Normalising on write silently rewrites the user's manuscript. See ADR-0014.

**Do not commit while `isComposing`.** Malayalam is typed through IMEs and this is the single most
likely source of user-visible breakage — more than grapheme handling. **Playwright cannot catch
it**, because synthetic `input` events do not produce real composition sessions. See ADR-0010 and
the manual checklist at the end of `docs/MALAYALAM.md`.

**`ts` never orders anything.** Wall clocks move backwards. Order by `(seq, deviceId)` through the
comparator in `core/order.ts`. There is a test asserting an event with an earlier `ts` but a later
`seq` still sorts later.

**`core/` must not import React or the DOM.** That purity is what lets replay run in a Worker and
what makes the fold testable. Easy to break with a convenience import; nothing fails immediately.

**Restore semantics differ from insert.** An `insert` naming an existing soft-deleted block is a
restore. An absent `afterBlockId` means "append at end" for a fresh insert but "put it back where
it was" for a restore. Both are the useful default for their case; the asymmetry is deliberate and
tested.

**Do not seed the corpus through `insertBlock`.** 1,563 sequential transactions will take minutes.
Use `generateNKeysBetween` and bulk-insert — that is what it is for.

## Decisions already made — do not relitigate

All 23 are in `DECISIONS.md` with alternatives and consequences. The twelve that departed from the
original brief, because a fresh session reading the brief will notice the difference:

| ADR | Departure |
|---|---|
| 0007 | `order` is a string; float midpoints silently corrupt after ~50 same-position inserts |
| 0008 | Projection written in the same transaction as the event, with a watermark |
| 0009 | Snapshots serve time travel, not cold open; logarithmic retention ladder |
| 0010 | IME composition guard — absent from the brief entirely |
| 0011 | Cross-block selection accepted as lost, mitigated explicitly |
| 0012 | `prevText` omitted when derivable; corpus compaction at export |
| 0013 | Eviction handling and scheduled backups moved to Phase 1 |
| 0014 | Normalise for comparison, preserve bytes for round trip (brief was self-contradictory) |
| 0017 | Dwell gated by an attention model |
| 0019 | One bundled font; layout features preserved through subsetting |
| 0021 | Minimap buckets by max intensity, not per-block ticks |
| 0022 | Haptics are Android-only; `navigator.vibrate` does not exist on iOS Safari |
| 0023 | Resume strip order fixed; preference learned as default, not layout |

## One correction made during Phase 1

ADR-0009 originally claimed the retention ladder kept "any point in history within a bounded number
of events of an anchor". Writing the test showed that is not what it does — the oldest anchors are
dropped, so an early target replays from empty. The real guarantee is better and is now stated in
the ADR, in `ARCHITECTURE.md` and in the module comment: **reconstructing any past state never
replays more events than lie between that state and the present.** Early targets need no anchor
because replaying them from empty is bounded by their own position. Asserted across log sizes of
5k, 50k and 200k events.

## Conventions

`CLAUDE.md` — commit style, test requirements, the non-negotiable rules. Read it before writing
code.
