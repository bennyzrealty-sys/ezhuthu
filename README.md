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

These are enforced by `tests/perf`, not vibes. A change that breaks one is a failing build.

| Metric | Budget |
|---|---|
| Cold open, 100k-word document | < 1.5 s |
| Scroll | sustained 60 fps |
| Keystroke to paint | < 16 ms |
| Memory, 100k-word document | < 150 MB |

## Current status

**Phase 1 — Foundation.** Scaffold, documentation, Dexie schema, event log, snapshot/replay,
storage-persistence and backup, fold correctness tests.

Build order and per-phase state live in [`HANDOFF.md`](HANDOFF.md), which is updated at the end
of every working session. Read it first if you are picking this up cold.

| Phase | What | State |
|---|---|---|
| 1 | Foundation — log, fold, replay, persistence, backups | in progress |
| 2 | Editing — block model, virtualised list, focused-block editing | not started |
| 3 | Malayalam — segmentation, normalisation, fonts, search | not started |
| 4 | Signals — attention telemetry | not started |
| 5 | Resume — the four-destination strip | not started |
| 6 | Visibility — margin bar, decay, minimap, haptics, ghost markers | not started |
| 7 | Time-lapse + export — scrub UI, edit corpus | not started |
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

MIT. Bundled fonts (Manjari, Noto Sans Malayalam) are under the SIL Open Font License 1.1;
see `public/fonts/OFL.txt`.
