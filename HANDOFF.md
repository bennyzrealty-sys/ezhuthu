# Handoff

**Written for a session with no memory of the previous one.** Read this first. Updated at the end
of every working session — if it is stale, that is a bug.

**Last updated:** 2026-08-09 · end of Phase 1 documentation

---

## Where the project is

**Phase 1 — Foundation.** Documentation set complete and committed. Implementation of the Dexie
schema, event log, fold, replay and persistence layer in progress.

Branch: `claude/ezhuthu-editor-setup-10tfbg`. Every phase ships as its own PR.

## What works

- Vite + React + TypeScript scaffold, strict mode, `npm run dev` and `npm run build`
- Full documentation set — this is the contract for everything after, and it is deliberately
  detailed because the decisions in it are load-bearing

## What does not work yet

Everything else. There is no application code beyond the scaffold. No editor, no storage layer, no
rendering. Phases 2–8 are untouched.

## The next three tasks

1. **`src/db/` — schema and types.** Dexie declaration exactly as in `docs/DATA-MODEL.md`, the
   five stores with their indexes, and the TypeScript types. Plus `ids.ts` (uuid, stable
   `deviceId` in localStorage — the one legitimate localStorage use, `sessionId` per app launch).

2. **`src/core/fold.ts` and `src/core/events.ts`.** The pure fold, then the append path with the
   four-step transaction from ADR-0008. Then `tests/unit/fold.test.ts` — the property test
   asserting incremental and batch folding produce identical state over randomised sequences. This
   test is the foundation of every correctness claim in the project; write it before moving on.

3. **`src/db/persistence.ts` — eviction handling and scheduled backups (ADR-0013).** Moved into
   Phase 1 deliberately: this is the largest risk to the user's data and the app should not hold
   real writing before it exists.

## Traps a fresh session will fall into

**The `blocks` table looks like normal mutable state. It is not.** It is a projection, written
only by `fold()` inside the append transaction, alongside the `lastAppliedSeq` watermark. Calling
`db.blocks.put()` from anywhere outside `core/events.ts` breaks the guarantee that makes crash
safety work, and it will not fail any test you have written. See ADR-0008.

**`Block.order` is a string.** The original brief said `number`, and float midpoints exhaust f64
precision after ~50 sequential inserts at the same position — an ordinary afternoon of writing,
after which block order silently corrupts. Compare lexicographically. Never sort it numerically.
See ADR-0007.

**`prevText` is usually absent, and that is correct.** It is derivable from the previous event for
the same block. The corpus exporter reconstructs pairs by walking `[docId+blockId+seq]`. Do not
"fix" the missing field by populating it — that doubles the log. `delete` events are the exception
and always carry full text. See ADR-0012.

**NFC does not solve chillu.** Atomic chillu (U+0D7B) and its ZWJ sequence are deliberately *not*
canonically equivalent, so no normalisation form unifies them. `normalizeForCompare()` applies NFC
**and** an explicit chillu fold. If you refactor normalisation down to `.normalize('NFC')` because
it looks redundant, search will silently stop matching text visible on screen. A test asserts both
halves. See `docs/MALAYALAM.md` Rule 2.

**Normalisation is for comparison only.** Stored text keeps its original bytes so import → export
is byte-faithful. Normalising on write silently rewrites the user's manuscript. See ADR-0014.

**Do not commit while `isComposing`.** Malayalam is typed through IMEs and this is the single most
likely source of user-visible breakage — more than grapheme handling. It cannot be caught by
Playwright, which does not produce real composition sessions. See ADR-0010 and the manual
checklist at the end of `docs/MALAYALAM.md`.

**`ts` never orders anything.** Wall clocks move backwards. Order by `(seq, deviceId)` through the
single comparator in `core/order.ts`. See ADR-0020.

**`core/` must not import React or the DOM.** That purity is what lets replay run in a Worker and
what makes the fold testable. It is easy to break with a convenience import and nothing will fail
immediately.

## Decisions already made — do not relitigate

All 23 are in `DECISIONS.md` with alternatives and consequences. The nine that departed from the
original brief, because a fresh session reading the brief will notice the difference:

| ADR | Departure |
|---|---|
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

## Conventions

`CLAUDE.md` — commit style, test requirements, the non-negotiable rules. Read it before writing
code.
