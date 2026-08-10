# എഴുത്ത് · ezhuthu

An offline-first, mobile-first editor for writing and editing **very long documents** in
Malayalam and English. Target scale: **100,000+ words in a single document**, smooth on a
mid-range phone.

Everything stays on the device. No accounts, no server, no sync, no telemetry leaving the
phone — ever.

---

## Why it exists

Every editor is built for documents that fit on a screen. At 100,000 words a document stops
being a thing you read and becomes a place you navigate, and the tools stop helping. You lose
your place. You cannot find the paragraph you fixed yesterday. The scroll bar becomes a blunt
instrument over an undifferentiated wall of text.

`ezhuthu` is built around two requirements, and every other decision serves them:

**1. On open, return the writer to where he was working.** Not the cursor position — the cursor
is wherever a thumb last landed, which is usually meaningless. The place his *attention* was.

**2. Make edited lines identifiable at a glance**, so work is findable inside a huge document
without scrolling through it.

## The one architectural idea

**The document is not stored. The stream of edits is stored.**

`ezhuthu` is an event-sourced text editor. Every mutation appends an immutable event to a log.
The document you see is a projection of that log. This is the decision that makes everything
else cheap instead of hard:

- *"Where was I?"* is a query over the log, not a bookmark someone remembered to save
- *"What changed?"* is a filter by timestamp
- Undo is unlimited and survives app restarts
- The document can be reconstructed as it existed at any past moment
- Crash safety is structural — nothing is overwritten, only appended
- Deletions stay in history, so they can be shown and recovered

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for how it actually works, and
[`DECISIONS.md`](DECISIONS.md) for why each choice was made and what was rejected.

## Quick start

```bash
npm install
npm run dev            # dev server
npm test               # unit tests (Vitest)
npm run test:e2e       # end-to-end (Playwright)
npm run test:perf      # performance budgets — seeds an 80k-word corpus, slow
npm run corpus:generate  # regenerate the synthetic Malayalam test document
```

Requires Node 20.19+ (22 recommended, see `.nvmrc`).

## Performance budgets

These are enforced by `tests/perf`, not vibes. See the measured numbers under
[Current status](#current-status).

| Metric | Budget |
|---|---|
| Cold open, 100k-word document | < 1.5 s |
| Scroll | sustained 60 fps |
| Keystroke to paint | < 16 ms |
| Memory, 100k-word document | < 150 MB |
| Search, whole document | < 250 ms scan |
| Time-lapse, open and materialise | < 2 s |
| Time-lapse, one scrub step | < 400 ms |
| Corpus export, whole log | < 5 s |

Typecheck, unit tests, build and e2e run in CI on every pull request. The perf suite runs locally
only — shared CI runners have noisy CPU, and a budget that fails at random teaches everyone to
ignore red builds. See [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md).

## Current status

**Phase 6 — Visibility complete.** On top of Phases 1–5, this is requirement 2: making edited
lines identifiable at a glance. A margin intensity bar (opacity for recency, saturation for
revision count, decayed at render time), a bucketed minimap of the whole document, ghost markers
that reveal and restore deleted paragraphs, auto-bookmarks built from where the writer keeps
scrolling back, and opt-in haptic/visual feedback while scrolling past edits.

Measured against the 80,022-word synthetic Malayalam corpus, every budget still has headroom, and
nothing regressed against Phase 5 — the new work is a few map lookups per rendered row, a canvas
redrawn only on edit, and a scroll handler that does nothing until enabled:

| Metric | Budget | Measured |
|---|---|---|
| Cold open | < 1.5 s | **156–180 ms** |
| Keystroke handler | < 16 ms | **0.78–0.81 ms** median, 1.08–1.14 ms p95 |
| Scroll frame interval | < 33 ms p95 | **17.1 ms** p95 |
| Memory | < 150 MB | **4.2 MB** |
| Search, whole-document miss | < 250 ms | **~70–77 ms** scan |
| Blocks in the DOM | — | **12** of 1,563 |

Build order and per-phase state live in [`HANDOFF.md`](HANDOFF.md), which is updated at the end
of every working session. Read it first if you are picking this up cold.

| Phase | What | State |
|---|---|---|
| 1 | Foundation — log, fold, replay, persistence, backups | **done** |
| 2 | Editing — block model, virtualised list, focused-block editing | **done** |
| 3 | Malayalam — segmentation, normalisation, fonts, search | **done** |
| 4 | Signals — attention telemetry | **done** |
| 5 | Resume — the four-destination strip | **done** |
| 6 | Visibility — margin bar, decay, minimap, ghost markers, haptics | **done** |
| 7 | Time-lapse + export — scrub UI, edit corpus | **done** |
| 8 | PWA polish — install flow, offline verification | not started |

## Your data is yours

The event log is a complete record of how the document was written. It exports as JSON. The
document exports as `.txt` and `.md`. The accumulated (before, after) edit pairs export as JSONL
— a personal style corpus in a low-resource language, produced for free by normal writing.
See [`docs/DATA-MODEL.md`](docs/DATA-MODEL.md).

**A warning worth reading:** browsers can evict IndexedDB. `ezhuthu` requests persistent storage
on first write and tells you whether it was granted, but the only real protection for a
100,000-word manuscript is a backup that lives outside the browser. The app schedules these and
nags if one is overdue. Take them. See [ADR-0013](DECISIONS.md).

## Non-goals for v1

Stated plainly so scope does not creep:

- **No cloud sync, no accounts, no server.** Fully local.
- **No real-time collaboration.**
- **No rich text formatting.** Blocks are plain text.
- **No AI features in the editor itself.**
- **No document-type-specific features.** This is a general-purpose long-form editor. It is not
  a screenplay tool, not a novel-structure tool, not a notes app.

Seams are deliberately left for the things in "Extension points" in
[`ARCHITECTURE.md`](ARCHITECTURE.md) — block metadata, locked blocks, a derived-metrics slot,
additional scripts. Designed for; not built.

## Licence

MIT.

[Manjari](https://gitlab.com/smc/fonts/manjari) is bundled under the SIL Open Font License 1.1,
with its licence text alongside it in `public/fonts/OFL.txt`. It ships as a 72 KB woff2 subset
covering the Malayalam block, Latin-1 and the joiners, with all layout features preserved — see
[ADR-0019](DECISIONS.md) for why only one face is bundled, [ADR-0024](DECISIONS.md) for what
actually breaks Malayalam subsetting, and `scripts/subset-fonts.sh` to rebuild it.

Noto Sans Malayalam remains an optional face for a reader who prefers it; it is not bundled and
the download flow is not built.
