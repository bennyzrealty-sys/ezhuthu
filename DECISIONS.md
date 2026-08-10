# Architecture Decision Record

Chronological. Each entry: context, decision, alternatives considered, consequences — including
the ones we do not like. An ADR is not deleted when it turns out to be wrong; it is superseded by
a later one that says so.

**Status key:** `accepted` · `superseded by ADR-NNNN` · `revisit` (decided, but with a known
trigger for reconsidering)

---

## ADR-0001 — Store the stream of edits, not the document

**Status:** accepted

**Context.** The application must support 100,000+ word documents on a phone, return the writer
to where his attention was, show what changed and when, survive crashes without losing work, and
recover deleted text. Approached separately, each of those is a feature with its own storage,
its own failure modes, and its own bugs.

**Decision.** The document has no canonical stored form. Durable state is an append-only log of
immutable `BlockEvent`s. The document is a projection of that log via a pure fold. Every mutation
appends exactly one event; no other code path writes document state.

**Alternatives considered.**

- *Store the document, add features alongside.* Each requirement becomes independent machinery:
  a bookmark store, a diff-against-backup, a session-scoped undo stack, a trash can. Four
  mechanisms, four sets of bugs, and the ones that need history cannot be added retroactively
  because the history was never kept.
- *Store the document with a change journal beside it.* Two sources of truth that must agree.
  They will not agree, and the failure is silent.
- *CRDT (Yjs / Automerge).* Solves a problem we explicitly do not have — concurrent editing — at
  the cost of a large dependency, opaque internal state, and metadata that grows with edit count
  in ways that are hard to bound. Revisit only if sync becomes a goal, and note that a CRDT is a
  *replacement* for this ADR, not an addition to it.

**Consequences.**

- "Where was I", "what changed", undo, and deletion recovery all become queries over one table.
  This is the entire justification and it is a large one.
- Storage grows with edit count, not document size. Bounded by ADR-0012.
- Naive replay on open would be unacceptably slow; addressed by ADR-0009.
- The projection can drift from the log if written carelessly; addressed by ADR-0008.
- Every future feature must be expressible as an event. If one is not, that is a signal the
  event model is wrong, not a licence to write state directly.

---

## ADR-0002 — IndexedDB, never localStorage

**Status:** accepted

**Context.** We need durable structured storage for a log that will reach hundreds of thousands
of records and tens of megabytes.

**Decision.** All persistence is IndexedDB via Dexie. `localStorage` is not used for document
data, event data, or anything on a hot path.

**Alternatives considered.**

- *localStorage.* Caps around 5 MB, stores strings only, and is **synchronous on the main
  thread** — every read and write is a jank source. Disqualified twice over.
- *OPFS (Origin Private File System).* Genuinely fast and a plausible future home for snapshots.
  But it offers no indexes, so every query we need would have to be built by hand. Revisit if
  snapshot writes become a measurable cost.
- *WASM SQLite over OPFS.* Real indexes and real queries, at the cost of a multi-megabyte WASM
  payload fighting our cold-open budget on a phone. Not justified at this scale.

**Consequences.**

- Async everywhere, which is correct but makes ordering discipline mandatory (ADR-0008).
- Subject to browser eviction — the risk addressed by ADR-0013.
- Dexie gives us `liveQuery` and clean transactions; we accept a ~30 KB dependency for it.
- `localStorage` remains acceptable for one narrow thing: a few bytes of UI preference that we
  would not mind losing. Never document data.

---

## ADR-0003 — A document is an ordered list of blocks

**Status:** accepted

**Context.** The alternative to blocks is one large string. At 100,000 words that string is
roughly 600 KB.

**Decision.** A document is an ordered list of `Block` records, one block ≈ one paragraph. Events
address individual blocks by `blockId`.

**Alternatives considered.**

- *Single text field.* Every keystroke rewrites 600 KB to storage, re-renders the whole document,
  and re-measures every line. It also makes "which paragraph changed" an inference problem
  requiring a diff, rather than something the event already tells us. Fails the write budget, the
  render budget, and the feature requirements simultaneously.
- *Fixed-size chunks (e.g. every 4 KB).* Cheap to implement, but chunk boundaries fall mid-
  sentence, so "this block was edited" no longer corresponds to anything the writer recognises.
  The visibility features depend on block boundaries being *meaningful*.

**Consequences.**

- Per-block writes. A single edit touches one record. This is what makes the write path
  affordable and it is a hard rule: no code path may write the whole document.
- Blocks are the unit of virtualisation, of edit-visibility, of dwell measurement, and of the
  edit corpus. One concept, reused everywhere.
- Cross-block operations (selection, find-and-replace across paragraphs) need explicit handling
  rather than coming free. See ADR-0011.
- Import must split text into blocks and export must rejoin them faithfully; see ADR-0014.

---

## ADR-0004 — Virtualised read-only blocks, one focused editor

**Status:** accepted

**Context.** 2,000 blocks cannot all be in the DOM at 60 fps. Virtualisation is mandatory. But a
`contenteditable` region and a virtualised list are in direct conflict: the browser's selection
and composition model assumes the content is present, and unmounting a node that the selection
lives inside destroys the editing context.

**Decision.** Rendered blocks are read-only `<div>`s. On focus, exactly one block is replaced by
an editable field. On blur or 400 ms idle (subject to ADR-0010), the block commits and reverts to
a read-only div. TanStack Virtual with dynamic measurement; heights cached per `blockId` +
viewport width.

**Alternatives considered.**

- *One `contenteditable` for the whole document.* What most web editors do, and the reason most
  web editors die past ~20,000 words. Cannot be virtualised.
- *All blocks individually contenteditable.* 2,000 editable nodes; memory and event-listener cost
  is worse than the single-contenteditable case.
- *Canvas-rendered text with a custom editing layer* (the Google Docs approach). Total control,
  and total responsibility: we would be reimplementing IME composition, autocorrect, swipe
  typing, selection handles, and accessibility for Malayalam. Cost is out of proportion to a
  single-author offline editor.
- *Fixed row heights.* Would remove the measurement problem, but Malayalam wrapping cannot be
  predicted from character counts — conjunct clusters have widths that depend on shaping. Fixed
  heights produce scroll drift that compounds over 2,000 blocks.

**Consequences.**

- The browser only ever manages one paragraph of editing context, which it does extremely well —
  including IME, autocorrect and swipe typing, all of which we would otherwise have to rebuild.
- The keystroke path is native, so the < 16 ms budget is met by default provided we keep the
  change handler trivial.
- Cross-block selection is lost. Documented and mitigated in ADR-0011, not hidden.
- The tap-to-focus caret handoff becomes the hardest single piece of the render layer.

---

## ADR-0005 — Margin intensity bar, not coloured text

**Status:** accepted

**Context.** Requirement 2: edited lines must be identifiable at a glance in a huge document.

**Decision.** A 4 px bar on the left edge of each block. **Opacity encodes recency**, **saturation
encodes revision count**. The text itself is never restyled. Intensity is computed at render time
from timestamps and is never stored (ADR-0006).

**Alternatives considered.**

- *Colouring or highlighting the text.* Fights Malayalam directly. The script's conjunct clusters
  and vowel signs are visually dense; adding colour and background variation to the glyphs
  themselves measurably hurts legibility, and legibility is the product.
- *Underlines or borders.* Collide with vowel signs that descend below the baseline. Malayalam has
  marks above and below; horizontal decoration lands on top of them.
- *Icons or gutter badges.* Discrete, so they cannot express "how recently" or "how many times" —
  and the whole point is a continuous signal readable in peripheral vision.

**Consequences.**

- Text rendering is completely untouched by the feature, which is the property we wanted.
- Two independent visual dimensions in 4 px of horizontal space, readable without focusing on it.
- Requires decay to stay useful (ADR-0006).
- Colour-blind safety comes free: the signal is opacity and saturation, not hue.

---

## ADR-0006 — Time decay, computed at render time

**Status:** accepted

**Context.** Without decay, every block eventually carries an edit marker. After a week of work
the entire document is highlighted, which conveys exactly as much as highlighting none of it.

**Decision.** Intensity decays with age: < 1 hour → 100%, < 1 day → 60%, < 1 week → 25%, older →
0%. Decay is computed at render time from `updatedAt`. **No decayed value is ever persisted.**

**Alternatives considered.**

- *Store computed intensity.* Requires touching every block as time passes — a background job
  that rewrites the document, violating the no-whole-document-writes rule for a value that is a
  pure function of a timestamp we already have.
- *Continuous exponential decay.* Smoother in principle, but the banded scheme is easier to reason
  about, easier to test, and the bands map to how the writer actually thinks about his own work
  ("this session", "today", "this week").
- *No decay, manual clearing.* Housekeeping the writer would have to remember. He will not.

**Consequences.**

- Markers fade on their own. The feature stays informative indefinitely.
- Rendering depends on wall-clock time, so tests must inject a clock rather than call `Date.now()`
  — a real testing constraint we accept.
- A document reopened after a month shows a clean slate, which is correct.

---

## ADR-0007 — Fractional indexing with lexicographic string keys

**Status:** accepted

**Context.** Inserting a paragraph between two others must not renumber the ones after it.
Integer `order` columns require rewriting every subsequent row — at 2,000 blocks that is a
whole-document write, forbidden by ADR-0003.

**Decision.** `Block.order` is a **string** key ordered lexicographically, generated between its
neighbours (base-62 fractional indexing, the approach used by Figma and the `fractional-indexing`
package). Inserting between two blocks writes one record.

**Alternatives considered.**

- *Integer order with renumbering.* Whole-document write per insert. Disqualified.
- *Floating-point midpoints* (`(a + b) / 2`) — **this was the original specification and it is a
  latent bug.** IEEE-754 doubles exhaust their mantissa after roughly 50 sequential inserts
  between the same pair of neighbours, after which midpoints silently collide and block order
  becomes non-deterministic. Fifty inserts in one spot is an ordinary afternoon of writing, not
  an edge case. String keys have no such bound: they grow one character at a time.
- *Linked list (`afterBlockId`).* Order is correct by construction, but "give me blocks 400–430 in
  order" requires walking the list, which defeats the indexed range query the virtualiser needs.
  We keep `afterBlockId` in the event payload as the *intent*, and resolve it to an order key at
  fold time.

**Consequences.**

- Inserts and moves are single-record writes at any position.
- `[docId+order]` gives the virtualiser a directly indexed, correctly ordered range query.
- Keys lengthen under repeated insertion at the same point. Bounded in practice, and a
  rebalancing pass exists if a key ever exceeds a sanity threshold.
- Ordering is string comparison, never numeric. Sorting these as numbers anywhere is a bug.

---

## ADR-0008 — The projection is written in the same transaction as the event

**Status:** accepted

**Context.** ADR-0001 says the log is the only truth, but the read path needs head state to be
immediately available without replay, so we maintain a `blocks` table. That table is *overwritten*
on every edit — it is precisely the mutable state event sourcing claims to have eliminated. A
crash between appending the event and updating the projection leaves the document silently wrong:
the log says one thing, the table another, and the user sees the table.

**Decision.** Every mutation performs four steps inside **one Dexie `readwrite` transaction**:

1. allocate `seq` by bumping a counter on the `docs` record (ADR-0020)
2. append the event to `events`
3. apply `fold()` to update `blocks`
4. advance `docs.lastAppliedSeq` to the new `seq`

All four commit or none do. On open, if `lastAppliedSeq !== max(events.seq)` the projection is
stale; replay the tail before trusting it.

**Alternatives considered.**

- *Write the event, update the projection afterwards.* The failure this ADR exists to prevent.
- *No projection at all; replay on every open.* Honest, and far too slow.
- *Rebuild the projection from the log on every open.* Correct by construction, but it is the
  replay cost we are avoiding — and the watermark gives us the same guarantee for the cost of one
  integer comparison.

**Consequences.**

- The claim "crash safety is structural" becomes true rather than aspirational.
- The `blocks` table is formally a *cache*: it can be dropped and rebuilt at any time, and there
  is a maintenance command that does exactly that.
- Every write pays for a slightly larger transaction. Measured as negligible against the 400 ms
  commit cadence.
- The same `fold()` runs incrementally and in batch, so the two paths cannot diverge.

---

## ADR-0009 — Snapshots serve time travel, not cold open

**Status:** accepted · supersedes the snapshot strategy in the original brief

**Context.** The brief specified a snapshot every 500 events, read on open with the tail replayed
after it, to meet the 1.5 s cold-open budget.

**Decision.** Snapshots are **not on the cold-open path at all.** Because ADR-0008 keeps `blocks`
transactionally consistent with the log, cold open is one indexed get plus one indexed range
query and involves no replay. Snapshots exist for one purpose: **anchoring historical
reconstruction** for the time-lapse scrub, which must materialise arbitrary past states at
interactive drag rates.

Retention follows a **logarithmic ladder**: at most one anchor per octave of age, so anchors are
dense near head and progressively sparser going back, and total snapshot storage stays O(log n) in
log length.

The resulting guarantee — and the reason it is safe to drop the oldest anchors — is that
**reconstructing any past state never replays more events than lie between that state and the
present.** A state early in the log needs no anchor at all, because replaying it from empty is
bounded by its own position, which is small precisely because it is early. Asserted across several
log sizes in `tests/unit/snapshots.test.ts`.

**Alternatives considered.**

- *Snapshot every 500 events, keep all.* Unbounded growth. At 100k words a full snapshot is
  ~600 KB; every 500 events is roughly every 10–20 minutes of writing. Days of work produce
  hundreds of megabytes of snapshots.
- *Snapshot every 500 events, keep the last 3.* Bounds storage, but makes time travel to anything
  older than the last ~1,500 events require replay from empty — which is the case the scrub cares
  about most.
- *No snapshots; replay from empty for the scrub.* Fine at 1,000 events, unusable at 200,000.

**Consequences.**

- Cold open no longer depends on snapshot cadence at all, removing it as a performance variable.
- Time travel to any point costs a bounded replay.
- Snapshot storage is O(log n) rather than O(n).
- Replay runs in a Web Worker so scrubbing never competes with typing.
- Snapshots become disposable: losing them costs speed on one feature, never data.

---

## ADR-0010 — Never commit during IME composition

**Status:** accepted

**Context.** Malayalam is typed through input methods that use composition events — on Android,
on iOS, and via transliteration keyboards where a sequence of Latin keystrokes resolves into
Malayalam glyphs. During composition the field holds provisional text that the IME still owns.
ADR-0004's 400 ms idle commit will fire in the middle of that window during ordinary typing.

Writing to the field, or re-rendering it, while composition is active resets the IME buffer. The
symptoms are the classic broken-Malayalam-editor report: half-formed conjuncts committed as
separate characters, the cursor jumping to the start, duplicated vowel signs. **In practice this
causes more visible breakage than incorrect grapheme handling**, and the original brief did not
mention it.

**Decision.** The editor tracks composition state via `compositionstart` / `compositionend`. While
`isComposing` is true: no commit, no controlled-value write, no re-render of the focused field.
The idle timer is *restarted* by `compositionend`, so a commit happens only after composition has
finished and the field has been quiet. Blur commits are also gated — blur during composition
finalises the composition first.

Never trust `event.key` alone: during composition Chrome reports `keyCode` 229 for everything.
`KeyboardEvent.isComposing` is authoritative and is what the signal collector must check too, or
hesitation and backspace-density measurements will be nonsense on IME input.

**Alternatives considered.**

- *Commit on a timer regardless.* The bug.
- *Only commit on blur.* Safe, but on a phone blur may not happen for many minutes, widening the
  crash-loss window well past what is acceptable.
- *Uncontrolled field, read on commit.* Part of the answer and what we do — but insufficient on
  its own, because re-rendering the surrounding list can still disturb composition. The explicit
  guard is required.

**Consequences.**

- Commit cadence is "400 ms idle **after** composition ends", slightly lazier than specified.
- The focused editor is uncontrolled; React must not drive its value while focused.
- The guard is covered by `tests/e2e/ime.spec.ts`, which drives genuine composition sessions
  through CDP `Input.imeSetComposition`. Verified by mutation: removing the `isComposing` check
  makes those tests commit an empty block. (An earlier version of this ADR said composition could
  not be tested synthetically. That was wrong — `type()` cannot produce a composition session, but
  CDP can.)
- Platform IME behaviour — real Gboard, iOS keyboards, transliteration keyboards, swipe typing,
  autocorrect — is still only covered by the manual checklist in `docs/MALAYALAM.md`.
- Signal capture must exclude composing keystrokes.

---

## ADR-0011 — Accept the loss of cross-block selection; mitigate explicitly

**Status:** accepted

**Context.** ADR-0004 gives us exactly one editable node at a time. Native selection therefore
cannot span blocks: no dragging from paragraph 3 into paragraph 7, no ⌘A over the document, no
multi-paragraph copy, and browser find-in-page only sees rendered blocks.

**Decision.** Accept the limitation. Do not attempt to make native selection work across a
virtualised list. Mitigate with three explicit affordances:

1. **Range-select mode** — a deliberate mode selecting *whole blocks* by tap and extend, which is
   the granularity a long-form writer actually moves text at.
2. **Copy affordances** — copy block, copy selected range, copy whole document, from the menu.
3. **In-app search** (ADR-0015) replacing browser find-in-page, which cannot work on virtualised
   content anyway and would be needed regardless.

**Alternatives considered.**

- *Synthesise selection across blocks with a custom overlay.* Reimplements selection handles,
  autoscroll, and touch behaviour per platform. Large, fragile, and it must stay correct as blocks
  mount and unmount underneath it.
- *Render the whole document to enable selection when a "select" mode is entered.* 600 KB of DOM
  on demand — a multi-second freeze on the exact device class we are targeting.
- *Abandon virtualisation.* Fails every performance budget.

**Consequences.**

- On a phone — the primary target — this is close to unnoticeable; text selection there is
  already tap-and-handle rather than drag-across-pages.
- On desktop it is jarring, and we say so in the README rather than letting it be discovered.
- Block-granular selection is arguably better for restructuring prose than character-granular.
- Export exists partly to serve "I want the whole text somewhere else".

---

## ADR-0012 — Omit derivable `prevText`; derive edit pairs at export

**Status:** accepted

**Context.** The brief specified that every `update` event carry both `text` and `prevText`, to
accumulate (before, after) pairs for the edit corpus (ADR-0016).

This roughly doubles log size, and the doubled part is redundant. For any block, the previous
event's `text` **is** the current event's `prevText` — the log already contains it. Concretely: a
500-character paragraph revised 40 times stores ~40 KB of `prevText` that is recoverable by
walking back one event. Across 2,000 blocks in a heavily-edited manuscript that is tens of
megabytes of pure duplication, on a device whose storage can be evicted under pressure
(ADR-0013). Storage is not free here; it is the resource most likely to lose the user's work.

**Decision.** `prevText` is **optional** and written only when it is *not* derivable from the log:

- the first `update` to a block whose creating `insert` predates the oldest retained event
- a block whose history begins at an import boundary
- `delete` events, which always store the full text being removed — this is what ghost markers
  restore from (ADR-0018), and there is no later event to recover it from

The corpus exporter reconstructs (before, after) pairs by walking the log per block, using stored
`prevText` when present and the preceding event's `text` otherwise. **The corpus is unaffected in
content**; only its derivation moves from read time to export time, which is a batch operation
where cost does not matter.

**Compaction.** The corpus wants *meaningful* revisions, not keystroke noise. Two mechanisms:

- **Session coalescing at export.** Consecutive `update`s to the same block within one
  `sessionId` and inside a 5-minute window collapse to a single pair: the text at the start of the
  run and the text at the end. This is what "how did this sentence change" actually means; 40
  intermediate autosaves are an artefact of our 400 ms commit cadence, not 40 acts of revision.
- **Triviality filter at export.** Pairs are dropped when the change is a single grapheme
  cluster, is pure whitespace or punctuation, or has a normalised edit distance below threshold
  with no word-boundary change. Typo corrections are not style.

Both are **export-time filters over an intact log**. Nothing is discarded from storage, so the
thresholds can be changed later and re-run over all history. The log stays append-only and
lossless; only the *derived* corpus is compacted.

**Alternatives considered.**

- *Always store `prevText`.* The specified design. Doubles the log for data already present.
- *Store a compact diff instead of full `prevText`.* Smaller than full text, but adds a diff
  format, a patch applier, and a class of subtle bugs around Unicode boundaries — to reconstruct
  something already sitting in the previous record.
- *Compact the log itself, discarding intermediate revisions.* Would bound growth more
  aggressively, but destroys the ability to reconstruct the document at an arbitrary past moment
  (ADR-0009) and makes the corpus thresholds permanent. Rejected: the log is the asset.

**Consequences.**

- Roughly halves log growth for the common case, at zero cost to any feature.
- The corpus exporter must walk per-block history in order rather than reading pairs directly —
  more code in one batch path, which is the right place for it.
- `delete` still carries full text; deletions are the events we can least afford to lose.
- Corpus quality is tunable retroactively because the raw material is never thrown away.
- Requires a per-block ordered index on the log to walk history efficiently: `[docId+blockId+seq]`.

---

## ADR-0013 — Treat storage eviction as the primary data risk; back up out of the browser

**Status:** accepted

**Context.** IndexedDB is evictable. On iOS, storage for a site not installed to the home screen
can be reclaimed under pressure and, on some versions, after a period of disuse. Android and
desktop Chrome evict under storage pressure when the origin is not persistent.

For an application whose entire value is holding a 100,000-word manuscript, **this is a larger
risk to the user than every performance concern in this document combined.** A slow editor is
annoying. An evicted manuscript is a catastrophe with no recourse. The original brief placed PWA
concerns in Phase 8; this belongs in Phase 1, before the app is ever trusted with real writing.

**Decision.** Three layers, all in Phase 1:

1. **Request persistence.** Call `navigator.storage.persist()` on first write and record the
   result on the doc metadata. Where available, `navigator.storage.estimate()` is polled to warn
   before quota pressure.
2. **Tell the truth.** If persistence is denied or unavailable, say so plainly in the UI. Do not
   present unprotected storage as safe. Installing to the home screen materially improves the
   odds on iOS, so the app explains that at the point where it matters.
3. **Scheduled backups out of the browser.** A backup is a single self-contained JSON file
   containing the full event log and document metadata — sufficient to rebuild everything, since
   the log is the only truth (ADR-0001). The app tracks `lastBackupAt`, prompts on a schedule,
   and escalates as it ages. Uses the File System Access API to write to a chosen folder where
   supported, falling back to an ordinary download.

Layer 3 is the only one that actually survives eviction. The UI treats it as the real protection
and layers 1–2 as best-effort — a design stance, not an implementation detail.

**Alternatives considered.**

- *Rely on `navigator.storage.persist()`.* It is a request, not a guarantee; Safari may refuse or
  ignore it. Betting a manuscript on it is not defensible.
- *Automatic cloud backup.* Directly contradicts the no-server non-goal, and would make the
  privacy guarantee conditional.
- *Warn once at first run.* A dialogue nobody reads, protecting nothing.
- *Backup only on explicit user action.* The user will not remember. The schedule exists because
  the failure is silent and total.

**Consequences.**

- The app is opinionated about backups in a way most web apps are not. This is deliberate.
- The backup file is plain JSON, readable and restorable without this application — appropriate
  for something holding a person's book.
- Restore must handle merging into an existing log, not only restoring to empty.
- Adds a first-run permission prompt, accepted as the cost of not losing a manuscript.

---

## ADR-0014 — Normalise NFC for comparison; preserve original bytes for round trip

**Status:** accepted

**Context.** The brief contains a direct contradiction. It requires normalising input to NFC
(without which chillu and atomic-chillu forms silently fail to match in search), *and* requires a
byte-faithful round trip for imported `.txt` and `.md`. If an imported file is not already NFC,
these cannot both hold: normalising on input changes the bytes, so export cannot reproduce the
original.

**Decision.** Separate the two concerns.

- **Storage preserves what arrived.** Imported text is stored as it was received. Text the user
  types is stored as the platform's IME produced it.
- **Normalisation happens at comparison time**, not at write time. Search, matching, dedup, and
  the corpus triviality filter all normalise both sides to NFC before comparing. `text/normalize.ts`
  is the only place this happens, and comparison helpers are the only public API — so no caller
  can accidentally compare raw strings.
- **The round-trip guarantee is stated precisely**: import → export is byte-faithful. There is an
  explicit, non-default "normalise document to NFC" command, which is a visible edit that appends
  events like any other change.

**Alternatives considered.**

- *Normalise on input.* The specified design. Breaks byte-faithful round trip, and silently edits
  the user's text on import — for a manuscript, changing bytes without being asked is not
  acceptable, even when the change is semantically null.
- *Store both raw and normalised forms.* Doubles storage for something computable in microseconds.
- *Drop the byte-faithful requirement.* Possible, but round-trip fidelity is what makes the app
  safe to put an existing manuscript into. Worth more than the simplification.

**Consequences.**

- Comparison paths must be disciplined; every comparison goes through `text/normalize.ts`.
- Two visually identical strings can differ in storage. Correct, and the reason all matching is
  normalised.
- Round trip is genuinely byte-faithful, so importing a manuscript is non-destructive.
- Word and grapheme counts normalise before counting, so they stay stable regardless of input
  form.

---

## ADR-0015 — Search the store, not the DOM

**Status:** accepted

**Context.** Only ~30 of 2,000 blocks are in the DOM (ADR-0004), so browser find-in-page and any
DOM-based search are structurally incapable of finding most of the document.

**Decision.** Search runs as a cursor over the `blocks` store in IndexedDB, NFC-normalising both
needle and haystack per ADR-0014. Results are block references, and selecting one scrolls the
virtualiser to that block. Search never materialises the document in memory or in the DOM.

**Alternatives considered.**

- *Browser find-in-page.* Cannot see unrendered blocks. Not a partial solution — a wrong one.
- *Full-text index (inverted index over terms).* Faster for repeated queries, but adds an index to
  maintain transactionally on every write, and Malayalam tokenisation for indexing is a
  substantially harder problem than substring matching. Revisit if linear scan proves too slow;
  at 2,000 blocks it will not.
- *Load all text into memory and search there.* Violates the memory budget.

**Consequences.**

- Search is O(document) per query, which at 600 KB is a few milliseconds — run off the main thread
  if measurement says otherwise.
- Works identically regardless of scroll position.
- Regex and whole-word search come nearly free; ranking and fuzzy matching do not, and are out of
  scope for v1.

---

## ADR-0016 — Export the edit corpus as a first-class artefact

**Status:** accepted

**Context.** Because the log retains every revision (ADR-0001) and (before, after) pairs are
recoverable from it (ADR-0012), normal writing accumulates a complete record of how this writer
improves a Malayalam sentence. Editors throw this away because they save documents instead of
decisions. Malayalam is a low-resource language and this material does not otherwise exist.

**Decision.** A supported export emits JSONL:

```json
{"before": "...", "after": "...", "ts": 0, "revisionIndex": 1}
```

Subject to the session coalescing and triviality filtering in ADR-0012. This is a documented
feature with tests, not a debug utility.

**Alternatives considered.**

- *Do not build it.* The material accrues anyway; refusing to export it only makes it
  inaccessible.
- *Export raw pairs without filtering.* Dominated by autosave noise and typo fixes; the signal
  disappears.
- *Upload or share it anywhere.* Violates the local-only guarantee. Export writes a file to the
  user's device and nothing else.

**Consequences.**

- The user owns a genuinely rare dataset, produced for free.
- Filter thresholds are tunable and re-runnable over full history, since the log is never
  compacted.
- Export is batch, so cost is irrelevant.
- The privacy guarantee makes this the user's asset alone. It leaves the device only if he
  chooses to move the file.

---

## ADR-0017 — Dwell must exclude inattention

**Status:** accepted

**Context.** "Longest dwelled" is destination 3 of the resume strip, and is described as *where
attention actually was*. The specified implementation — `IntersectionObserver` plus timestamps —
does not measure attention. It measures *pixels on screen*, which diverges from attention in two
ways that are not edge cases:

- A phone left face-up on a desk accrues dwell indefinitely. The winning block becomes wherever
  the writer was when he was interrupted, which is the least useful destination in the document.
- A block at the top of the viewport accrues the same dwell as the block being read at the bottom.

Uncorrected, the feature is not merely imprecise — it is *confidently wrong*, which is worse than
absent, because the writer will follow it.

**Decision.** Dwell accrues only under an explicit attention model:

1. **Stop on `visibilitychange`.** Backgrounded tab accrues nothing.
2. **Idle cutoff.** No keystroke, scroll or touch for 60 s stops accrual for all blocks. Time
   already banked is kept; the gap is not.
3. **Centre weighting.** Accrual is weighted by proximity to viewport centre, so the block being
   read outscores blocks merely on screen.
4. **Require settling.** Blocks passing through during a fling accrue nothing; a block must be
   stable for ≥ 1 s before accruing at all. This is also what distinguishes scrolling-as-searching
   from scrolling-as-reading.

**Alternatives considered.**

- *Raw IntersectionObserver time.* The specified design; measures where the phone was when the
  writer stopped paying attention.
- *Require keystrokes for dwell.* Would only ever surface blocks that were edited — which is
  already destination 1, making destination 3 redundant. Reading without typing is real attention.
- *Device motion or camera attention detection.* Invasive, unreliable, and contrary to the
  privacy stance.

**Consequences.**

- Dwell becomes a defensible proxy for attention rather than a proxy for screen-on time.
- More state in the collector, all of it cheap and all of it batched (2 s flush) so it never
  competes with typing.
- Requires a synthetic-session test asserting that an idle gap does not inflate dwell.
- The 60 s and 1 s constants are guesses. They are named constants in one module, and revisiting
  them after real use is expected.

---

## ADR-0018 — Soft delete with ghost markers

**Status:** accepted

**Context.** Deletions are often the most significant edit, and they leave nothing to mark —
there is no block left to put a margin bar beside. A writer who cuts three paragraphs and later
wants them back has, in a conventional editor, no path to them.

**Decision.** `delete` is a soft delete: the block is marked with `deletedAt` and excluded from
rendering, but its record and its text remain. At the join where blocks were removed, render a
2 px seam marker. Tap reveals the deleted text; tap again restores it (which appends an event
like any other change). `delete` events always carry the full removed text (ADR-0012).

**Alternatives considered.**

- *Hard delete, recover by replay.* The text is recoverable from the log in principle, but there
  is no *affordance* — the writer would have to know to go time-travelling, and would have no clue
  where. The seam marker is the discovery mechanism, and it is the whole feature.
- *Trash can / deleted-items list.* Separates deletions from the place they happened, which is the
  only context that makes them meaningful.
- *Tombstone blocks rendered inline at zero height.* Complicates virtualiser measurement for no
  gain over a seam on the neighbouring block.

**Consequences.**

- Deleted text stays in `blocks` as well as in the log; storage cost accepted.
- Every query over blocks must filter `deletedAt`. A single accessor enforces this — forgetting it
  in one place would resurrect deleted paragraphs into the document.
- Restore is an ordinary event, so it participates in history like everything else.
- Consecutive deletions must collapse into one seam rather than stacking markers.

---

## ADR-0019 — Ship one Malayalam font; never subset away layout features

**Status:** accepted

**Context.** The brief specified bundling subsetted woff2 of both Manjari and Noto Sans Malayalam.
Two risks. First, **subsetting Malayalam by codepoint range is dangerous**: conjunct formation
lives in the font's GSUB/GPOS tables, and a subsetter run with default settings strips layout
features, producing exactly the broken conjuncts the font bundling exists to prevent. Second, two
full Malayalam faces cost roughly 400 KB against a cold-open budget of 1.5 s and an offline cache
that must be fetched on install.

**Decision.**

- **Manjari is the bundled default**, shipped with the complete Malayalam block and **all layout
  features preserved** (`pyftsubset --layout-features='*'`, keeping the Malayalam and Latin ranges
  plus ZWJ/ZWNJ). Noto Sans Malayalam is an *optional* download, fetched and cached on request.
- Latin text uses the system UI font. It needs no bundling and adding one costs cold-open time for
  a script every device already renders well.
- `scripts/subset-fonts.sh` documents the exact invocation, and a test asserts that a known
  conjunct string shapes to the expected glyph count.

**Alternatives considered.**

- *Bundle both, fully subsetted by codepoint.* Specified, and the configuration most likely to
  ship broken conjuncts.
- *Bundle both unsubsetted.* Safe rendering, ~400 KB+ against the cold-open budget.
- *Rely on device fonts.* Rejected in the brief and correctly so: Malayalam rendering varies
  enormously across devices, and line length shifting between sessions damages the writer's
  physical sense of the text.

**Consequences.**

- One face to load, so cold open and offline install stay cheap.
- Conjunct rendering is protected by a test rather than by hope.
- A user who prefers Noto can have it at the cost of one download.
- Font files live in the service worker's precache; the optional face is cached on first use.

---

## ADR-0020 — Allocate `seq` inside the transaction; order by `(seq, deviceId)`

**Status:** accepted

**Context.** `seq` is monotonic per document and `[docId+seq]` is a key. Allocating it by reading
the current maximum and adding one races: two browser tabs on the same document are two IndexedDB
connections, and their reads can interleave, producing duplicate `seq` values and a corrupt log.

**Decision.** `seq` is allocated by **bumping a counter field on the `docs` record inside the same
`readwrite` transaction** that appends the event (ADR-0008). The transaction's lock on `docs`
serialises allocation across tabs.

Additionally, the canonical sort key is **`(seq, deviceId)`**, not `seq` alone.

**Alternatives considered.**

- *Read max seq, then append.* The race described above.
- *Use a timestamp as `seq`.* Clocks are not monotonic — NTP corrections and daylight-saving
  changes move them backwards, and two events in the same millisecond collide.
- *Web Locks API.* Would work, but adds a second coordination mechanism when the transaction we
  already need provides the guarantee for free.
- *Sort by `seq` alone.* Sufficient today. But `BlockEvent` already carries `deviceId` and
  `sessionId`, which means the schema anticipates multiple devices — and a single per-document
  counter is precisely the structure that cannot merge two devices' logs. Including `deviceId` in
  the sort key costs nothing now and means a future merge produces a deterministic total order
  rather than a schema migration over the user's entire history.

**Consequences.**

- Concurrent tabs are safe, which is a real scenario the moment a document is open in two places.
- Sync remains a non-goal, but the door is left open at zero present cost. This is a deliberate,
  documented hedge — not a promise that sync will be built.
- Allocation is one extra field write inside a transaction we were already opening.
- Every comparator sorts by `(seq, deviceId)`. There is one comparator, in `core/order.ts`.

---

## ADR-0021 — Bucket the minimap; do not draw per-block ticks

**Status:** accepted

**Context.** The minimap shows the whole document as a narrow column of ticks shaded by recency
and revision count. At 2,000 blocks in a ~600 px column, each block gets 0.3 px. Drawn naively,
ticks alias into an even grey wash — and worse, whether a given edit is visible depends on
sub-pixel rounding, so a real edit can vanish entirely.

**Decision.** The minimap renders **buckets, not blocks.** Blocks are assigned to buckets by
document position, one bucket per device pixel row. Each bucket draws the **maximum** intensity of
its members, never the average. Tapping a bucket jumps to the highest-intensity block inside it.

Maximum rather than average is the decision that matters: the minimap answers "is there anything
here I should look at", and one hot block among twenty cold ones must be visible.

**Alternatives considered.**

- *One tick per block.* Aliases; edits disappear at sub-pixel sizes.
- *Average intensity per bucket.* A single recent edit surrounded by old text averages down to
  invisible — the exact case the feature exists for.
- *Scale the minimap to fit blocks.* Would require ~2,000 px of height; the point is that the
  whole document is visible at once.

**Consequences.**

- Rendering cost is proportional to column height, not document length, so the minimap is O(1) in
  document size.
- Drives the minimap from the compact in-memory block index; no text is read.
- Bucket-to-block mapping is a pure function, and it is unit tested.
- Tap targeting is approximate by construction; landing within a bucket is accepted.

---

## ADR-0022 — Haptics are Android-only; do not build the product around them

**Status:** accepted

**Context.** The brief describes firing `navigator.vibrate(8)` as the writer scrolls past edited
regions, and frames it as a headline differentiator. **`navigator.vibrate` does not exist on iOS
Safari** — not degraded, absent. There is no Web API that produces haptic feedback on iOS Safari.
Android Chrome supports it, though some versions require a prior user gesture in the page.

**Decision.** Build it, gate it, and be honest about it. Feature-detect `navigator.vibrate`;
throttle to at most one pulse per 300 ms; user-toggleable and **off by default** until enabled.
Where the API is absent, the setting is shown as unavailable with the reason, rather than silently
doing nothing.

On iOS there is no equivalent, and we do not pretend otherwise. A subtle visual pulse on the
margin bar is offered as a separate, cross-platform setting — not as a claimed substitute.

**Alternatives considered.**

- *Build it as specified and assume it works.* Inert for every iPhone user, with no indication why.
- *Skip it.* It works well on Android and costs little.
- *Audio-based feedback as an iOS fallback.* Requires an audio context and is intrusive while
  writing.

**Consequences.**

- The feature is genuinely platform-split, and that is stated in the UI and the README.
- Planning should not treat it as a primary differentiator, because it is unavailable to a large
  share of the target users.
- Throttling is required regardless: unthrottled vibration during a fling is unpleasant and drains
  battery.

---

## ADR-0023 — Fixed resume-strip order; learn the default, not the layout

**Status:** accepted

**Context.** The resume strip offers four destinations, and the brief specifies remembering which
the user picks most and reordering accordingly.

Reordering a four-item strip on a small sample makes the layout unstable exactly while the user is
forming muscle memory for it. Two picks can flip positions 1 and 2; the target moves under a thumb
that had learned where it was. The cost lands on the most frequent interaction in the app.

**Decision.** **Positions are fixed** — last edited, last read, longest dwelled, most rewritten.
Preference is learned and expressed as the **pre-selected default**: the favourite is visually
emphasised and is what a keyboard Enter or a strip-level tap activates. Selection counts are
tracked and require at least five picks before any emphasis appears.

**Alternatives considered.**

- *Reorder by frequency, as specified.* Destroys positional stability for the benefit of saving a
  few pixels of thumb travel.
- *Fully static, no learning.* Loses genuinely useful personalisation; the writer probably does
  have one destination that is usually right.
- *Let the user pin an order manually.* A settings screen for four buttons.

**Consequences.**

- The strip is positionally stable from the first use, so it can be operated without reading it.
- Personalisation still happens, in the dimension that does not move targets.
- The five-pick floor prevents early thrash.
- If real use shows one destination dominating overwhelmingly, collapsing to one primary action
  with three secondary is a better answer than reordering — noted as a revisit trigger.

---

## ADR-0024 — Correcting ADR-0019: the subsetter's defaults are not the danger

**Status:** accepted · corrects the stated premise of ADR-0019; its decision stands

**Context.** ADR-0019, `scripts/subset-fonts.sh` and `docs/MALAYALAM.md` Rule 7 all asserted that
*"pyftsubset strips layout features it does not think are needed by default"*, and that
`--layout-features='*'` is what prevents broken conjuncts. Phase 3 ran the script for the first
time. The claim is false, and a false reason for a correct rule is worse than no reason: the next
person to read it either trusts the wrong mental model or, finding it wrong, discards the rule
with it.

Measured against Manjari-Regular (912 glyphs) with fontTools 4.63, subsetting to the Malayalam
block plus Latin-1 and the joiners:

| Invocation | Glyphs | GSUB features | Conjuncts |
|---|---|---|---|
| defaults | 811 | akhn blwf blws half haln pref pres pstf psts | **form correctly** |
| `--layout-features='*'` | 828 | the above + aalt salt tnum zero | form correctly |
| `--layout-features=''` | 323 | *(none)* | **broken** |
| `--no-layout-closure` | 323 | akhn half haln pref | **broken** |

pyftsubset's default `--layout-features` is a 68-tag list that already contains every feature
Indic shaping needs, and layout closure — which retains glyphs reachable only through GSUB — is on
by default. What `'*'` actually adds is discretionary features: alternates, tabular figures,
slashed zero.

**Decision.** Keep everything ADR-0019 decided. Change only the reason.

- `--layout-features='*'` stays. It costs 17 glyphs, it is explicit, and an explicit flag cannot be
  changed underneath us by a fontTools release. It is cheap insurance, not the load-bearing part.
- The two invocations that genuinely break Malayalam are named in the script, and both are things
  a person has to type deliberately: an empty or narrowed `--layout-features`, and
  `--no-layout-closure`. The second is the quieter one — it leaves the feature list intact, so a
  check that only reads feature tags passes while the conjunct glyphs those features substitute in
  are gone. That is why `verify-font.py` and the unit test both assert a glyph-count floor.
- The guarantee moves from the flags to the output. `scripts/verify-font.py` fails the subsetting
  run, `tests/unit/fonts.test.ts` fails CI on the committed file, and `tests/e2e/fonts.spec.ts`
  measures a conjunct against its ZWNJ-suppressed form in a real shaper.

**Two clarifications of ADR-0019 while we are here.**

- *One face means one face.* Only Manjari Regular is bundled. Bold would be another 72 KB of
  precache for what is currently one word of UI chrome; the script builds it on demand.
- *Manjari's own Latin is kept in the subset.* ADR-0019 says Latin uses the system UI font and
  also lists `U+0000-00FF` in the codepoint range, which cannot both be true inside a block. The
  range wins: Malayalam and English interleave within one paragraph constantly (Rule 6), and
  switching face mid-line is more visible than the 11 KB the Latin glyphs cost. UI chrome outside
  the document still uses the system font.

**Alternatives considered.**

- *Silently fix the comment.* The project keeps a "Corrections made so far" section in `HANDOFF.md`
  precisely because a wrong claim that has been repeated in three files is itself a finding.
- *Drop `--layout-features='*'` now that we know the default is safe.* It would be defensible and
  saves nothing worth having. The flag documents intent at the point of use.
- *Rely on the flags and skip the verifier.* This is what ADR-0019 effectively did, and it is how
  the wrong reason survived from Phase 1 to Phase 3 unchallenged.

**Consequences.**

- The rule survives with a reason that holds up, and the two real failure modes are named.
- Anyone re-subsetting gets a pass/fail at the point of running the script, not at the point of
  reading a rendered page in Malayalam and wondering whether it looks right.
- The claim "a rendering test asserts the expected shaped width" is now true; it was aspirational.

---

## ADR-0025 — Sample the rendered rows on a timer; do not observe intersections

**Status:** accepted · refines the mechanism named in `docs/SIGNALS.md`; ADR-0017's model is
unchanged

**Context.** `docs/SIGNALS.md` lists dwell as captured from *"`IntersectionObserver` + the
attention model"*, and ADR-0017 names IO as the naive approach it corrects. Phase 4 built the
collector and IO turned out to be the wrong tool twice over.

- **IO reports crossings; the model needs a value over time.** Gates 3 and 4 — centre weighting
  and settling — are not answered by "this block became 50% visible at t". Accrual has to be
  computed over intervals, so a timer is required no matter what. IO does not replace the timer;
  it only feeds it geometry, and geometry that is stale by however long ago the last threshold
  was crossed.
- **The question IO exists to answer is already answered.** IO is for finding the few interesting
  elements among thousands. There are no thousands: the document is virtualised, so about a dozen
  rows exist in the DOM at any moment (ADR-0004). Every element IO could tell us about is one we
  can enumerate directly.

Against that, IO costs real complexity: an observer to attach and detach on every row the
virtualiser recycles, which in React means a ref callback per row — and a ref callback that closes
over a block id is a new function every render, so the rows would detach and reattach on every
scroll frame, and `BlockRow`'s memoisation would stop working.

**Decision.** Sample `[data-block-id]` inside the scroller on a `SAMPLE_INTERVAL_MS` timer
(1 s), read a rect per row, and weight each by the centre of its *visible* extent. No
`IntersectionObserver` anywhere in `src/signals/`.

Accrual is computed from timestamps rather than tick counts, so the interval sets the model's
resolution and not its accuracy: a block half-way through settling at a sample boundary accrues
exactly the settled part of the interval.

**Alternatives considered.**

- *IO with many thresholds, plus a timer.* Two mechanisms where one will do, the observer
  bookkeeping above, and geometry that is stale between crossings.
- *Read positions from the virtualiser instead of the DOM.* Its `VirtualItem`s carry offsets, so
  no layout read at all — but they are positions within the scrolled content, and the model needs
  positions relative to the viewport. That means combining them with `scrollTop` and the
  scroller's height, which is a second copy of geometry the browser already has and will be wrong
  in exactly the cases measurement exists for (a mid-scroll sample, a resize in flight).
- *Sample only on scroll.* Cheaper, and wrong in the case that matters most: a writer reading
  without scrolling is the clearest attention there is.

**Consequences.**

- One mechanism, ~12 `getBoundingClientRect` calls a second, none of it on the typing path. The
  perf suite showed no measurable change against the Phase 3 numbers.
- A forced layout once a second while scrolling. Bounded by the virtualiser and, at 1 Hz against
  a 60 Hz frame budget, below the noise floor of the scroll measurement.
- The sampler is a plain method, so the unit tests drive a synthetic session through it in
  milliseconds instead of waiting out a 60-second idle cutoff in real time.
- `docs/SIGNALS.md` is corrected to match. The four gates of ADR-0017 are untouched — this is how
  the model is fed, not what it decides.

---

## ADR-0026 — "Last read" is the deepest paragraph dwelled on, not the furthest scroll position

**Status:** accepted · refines destination 2 of ADR-0023; the strip's shape is unchanged

**Context.** `docs/SIGNALS.md` defined resume destination 2 as *"furthest scroll position from
last session"*. Building it in Phase 5 made two problems visible.

- **A scroll offset is not a place in the document.** It is a pixel measurement against a layout
  that depends on viewport width, the font that was loaded, and the height cache. Restore it after
  a rotation, a split-screen resize, or a fallback-font first paint and it lands somewhere else —
  not near where the reader was, but at whatever text now occupies that many pixels. Everything
  else in this app addresses blocks (ADR-0003) precisely because blocks survive relayout.
- **Scrolling to the end is not reading to the end.** A fling that comes to rest at the bottom
  sets "furthest scroll" to the last paragraph. That is ADR-0017's error in a less obvious
  disguise: a measure of pixels offered to the writer as a measure of attention, confidently
  wrong, and followed.

**Decision.** Destination 2 is the block with the greatest `Block.order` among the blocks that
accrued **gated** dwell in the last session. It reuses the attention model rather than standing a
second, weaker measure of the same thing beside it, and it needs nothing stored: the signals are
already there.

Comparison is lexicographic on `order`, like every other comparison of that field (ADR-0007).

**Alternatives considered.**

- *Store a scroll offset per session.* The specified design. New state, layout-dependent, and it
  rewards flinging.
- *Store the deepest block that was rendered.* Better than pixels — it is a block — but it still
  counts a paragraph that crossed the viewport during a fling, which is the case ADR-0017's settle
  gate exists to exclude.
- *Drop destination 2 and offer three.* "Last read" is the only destination that answers *I was
  reading, not editing*, which for a 100,000-word manuscript is most of what a session is.

**Consequences.**

- A session spent only flinging produces no "last read" at all. That is correct — nothing was
  read — and the slot renders disabled rather than guessing.
- The destination is empty on the first relaunch after an import, because no earlier session
  exists to have dwelled in one.
- A writer who revises *backwards* through a manuscript, from the end towards the beginning, gets
  "deepest" when he means "where I stopped". Noted as a revisit trigger: the alternative is the
  **latest** dwelled block by timestamp rather than the deepest by order, and the data to switch
  is already in the store.

---

## ADR-0027 — The margin bar marks revision, not arrival

**Status:** accepted · refines ADR-0005 and ADR-0006 for the case they did not name

**Context.** ADR-0005 puts a margin bar on each block with opacity for recency and saturation for
revision count, and ADR-0006 computes the opacity purely from `updatedAt`. Neither says what
happens the moment after an import. Import (ADR-0014, ADR-0003) writes every block with
`updatedAt` set to the import time, so a bar keyed on `updatedAt` alone lights the **entire
document** at full opacity the instant it is brought in, then fades it uniformly over a week.

That is not what requirement 2 asks for. "Make edited lines identifiable at a glance" is a
question about where the *writer worked*, and an import is not the writer working — it is the same
distinction the "last edited" resume destination already draws, and draws with the same data. A
document that is uniformly lit conveys exactly as much as one that is uniformly dark.

**Decision.** The margin bar is drawn only for blocks with `revisionCount > 0`. Opacity still
comes from `updatedAt` decayed in ADR-0006's bands; saturation still comes from `revisionCount`.
A never-revised block — every block just after an import, and the tail half of a paragraph split
in the middle — carries no bar. `markIntensity` returns `null` for it, so the minimap scores it
zero and the row draws nothing, with no caller having to re-decide the question.

This is the same filter, for the same reason, as `lastEdited` in the resume strip
(`src/features/resume/destinations.ts`): `revisionCount > 0` is what separates two thousand blocks
that arrived together from the handful the writer has actually changed.

**Alternatives considered.**

- *Key the bar on `updatedAt` alone, as ADR-0006 literally reads.* Lights the whole document
  after import; the feature conveys nothing until a week has passed.
- *Suppress the bar for a grace period after an import.* A time-based special-case with a
  threshold to guess, papering over the real distinction, which is revision not recency.
- *Record an "imported" flag per block and exclude it.* New stored state for something already
  answered by a field the fold maintains.

**Consequences.**

- After an import the document is a clean slate; bars appear only as the writer revises.
- A brand-new paragraph typed by the writer is marked as soon as its first commit lands, because
  that commit is an `update` (ADR-0004's idle commit), which increments `revisionCount`.
- The tail of a mid-paragraph split is a fresh block at `revisionCount 0` and so is briefly
  unmarked until edited. Defensible: that text is existing prose relocated, not new writing.
- The minimap inherits the rule for free, because it shades from the same `markIntensity`.

---

## ADR-0028 — A merge is not a deletion, and leaves no ghost

**Status:** accepted · refines ADR-0018 for the merge case it did not name

**Context.** ADR-0018 makes a `delete` a soft delete and marks the join with a ghost seam that
reveals and restores the removed text. But the editor's merge — Backspace at the start of a block —
is *implemented* as a soft delete too: the block's text is appended to its neighbour, and the now-
empty block is deleted (`DocumentView.mergeBack`). The event type is identical, so a ghost marker
built naively renders a seam after every merge.

That seam is wrong twice over. The text it offers to reveal is not gone — it is sitting in the
neighbour it merged into, so the reveal shows the reader something already on screen. And restoring
it re-inserts the block as a separate paragraph while the merged copy stays in the neighbour, so a
"restore" **duplicates** the text. A merge is a join the writer performed deliberately; treating it
as a recoverable deletion misrepresents what happened.

**Decision.** The `delete` event carries `mergedInto` when it is the second half of a merge, naming
the block the text was folded into. The fold records it on `Block.meta.mergedInto`
(`meta` is the extension point ADR-0003 kept for exactly this). Ghost-marker seam computation
(`computeSeams`) skips blocks with `mergedInto` set: a merge shows no seam. A deliberate delete
omits it, and that is what leaves a ghost.

Deliberate deletion needs an affordance, since until now the only path to a soft delete was the
merge. A **Delete** control appears on the focused block; it deletes with no `mergedInto`, so the
text is genuinely gone from the document and the seam is how it is found again.

**Alternatives considered.**

- *Show a ghost for merges too.* Restoring one duplicates text; revealing one shows text already
  visible. Both are confusing in the way ADR-0017 warns about — a feature that is confidently wrong.
- *Make restore "unmerge": strip the merged suffix from the neighbour and re-split.* The neighbour
  may have been edited since, so the suffix is no longer identifiable. Fragile, and it turns a
  recovery into a guess.
- *A separate event type for merge.* A fifth event type (ADR-0001 resists new ones) for what is a
  delete with one extra fact. A payload field records that fact without a new fold branch.

**Consequences.**

- Ghost markers mark only genuine losses, which is the only case where recovery is meaningful.
- `meta.mergedInto` records where a merge's text went, which is also what a future "unmerge" would
  need — recorded now at no cost, built when there is a reason to.
- The fold gains one deterministic line; the equivalence property test is unaffected, since the
  random sequence generator never sets `mergedInto` and both fold paths set the same meta when it is.
- A deliberate-delete affordance now exists, which the editor lacked; it is the entry point every
  ghost in the document comes from.

---

## ADR-0029 — The scrub owns its state in the Worker and receives windows

**Status:** accepted · builds on ADR-0009

**Context.** ADR-0009 put historical replay in a Web Worker so that scrubbing never competes with
typing, and stopped there. Three questions were left open, and each has a wrong answer that looks
obvious.

*What comes back from a replay?* The materialised document is the natural answer. It is also
600 KB of block text structured-cloned across a thread boundary, per scrub position, on a device
whose memory budget exists because mid-range Android reclaims background tabs (`docs/PERFORMANCE.md`).
The present is never all resident; there is no reason history should be.

*What happens to the positions a drag passes through?* A drag emits positions far faster than a
replay answers them. Sent as they arrive, a two-second drag queues sixty replays, the document
lurches through sixty states nobody asked to see, and the one the thumb stopped on arrives last.

*Where can the slider stop?* Not at every event. Events are distributed neither evenly in time nor
evenly in interest: an import writes 1,563 of them at one instant, an afternoon writes a few
hundred over four hours, and the months between two drafts write none.

**Decision.**

**The Worker keeps the materialised state; the main thread asks for windows of it.** A
materialisation returns `{seq, blockCount, wordCount}`; text crosses only as a window of blocks.
Every window reply carries the seq it was taken from, because the Worker holds exactly one state
and a window that lands after the scrub has moved on would otherwise put the wrong paragraphs
under the date on screen.

**Materialisation is coalesced: one replay in flight, one waiting, and the waiting one is
replaced by wherever the thumb has since moved.** A superseded request resolves to `null` rather
than rejecting — during a drag, being overtaken is the normal case and not a failure. This is the
same reasoning as dropping a frame.

**The slider addresses instants, not events.** Events written in one transaction share a `ts` and
are one stop, so an import is one position rather than sixteen hundred. Beyond a cap, stops are
thinned evenly, preferring the end of a writing session over a stop a counter produced.

**The reading position is fixed and time moves.** Scrubbing does not return to the top of the
document. Watching one passage change is the question a writer actually has about their own
history; a series of unrelated first paragraphs is not.

**Alternatives considered.**

- *Post the whole document per position.* Simplest, and it puts the largest allocation in the app
  on the hottest interaction in the feature.
- *Cancel the running replay.* There is no way to interrupt a fold mid-flight without checking a
  flag inside it, which puts scrub concerns into `core/`. Coalescing the queue gets the same
  result — at most one wasted replay — with nothing added to the fold.
- *Debounce the slider instead of coalescing.* Equivalent while dragging and worse when stopped:
  a debounce waits before starting the replay the reader is already waiting for.
- *Let the panel restore a past state.* Out of scope, and not a small feature: the honest
  implementation replays forward into new events, and the dishonest one is a whole-document write
  (Rule 1). A viewer that also rewrites the document is two features.

**Consequences.**

- Opening the panel on the 80k-word corpus — Worker start, a cursor over every event, and a full
  replay — measures 180–191 ms, and a scrub to the earliest stop 74–83 ms, against budgets of 2 s
  and 400 ms.
- Time-lapse holds a second copy of the document, in the Worker, for as long as the panel is
  open. The Worker is created with the panel and terminated with it.
- The main thread's memory profile is unchanged by history: it holds one window.
- Mid-drag positions are never rendered, which is the intended behaviour and would look like
  dropped updates to anyone reading the client without this note.

---

## ADR-0030 — A revision is a change to prose that already existed

**Status:** accepted · refines ADR-0012 and ADR-0016

**Context.** ADR-0016 exports (before, after) pairs and ADR-0012 says how they are derived and
compacted. Neither says what counts as a revision, and the log contains several things that
produce a well-formed pair and teach nothing:

- a `delete`, which carries the full removed text (ADR-0012) and pairs to an empty `after`
- the first write into a paragraph created empty, which pairs from an empty `before`
- a `move`, which changes no text at all
- a paragraph re-encoded rather than rewritten — `അവന്‍` to `അവൻ` — which a keyboard change does
  to every chillu in a manuscript at once

**Decision.** A pair is emitted only for a change to text that already existed and still exists.
Concretely: `delete` ends a coalescing run and produces no pair; a pair with an effectively empty
side is dropped; `move` is transparent and does not split a run; and both sides are folded
(`text/normalize.ts`) before being compared, so re-encoding is not a revision.

Everything here is an **export-time** rule over an intact log, as ADR-0012 requires. Deletions
remain in the log with their text, and a future exporter that wants them can have them.

**Alternatives considered.**

- *Emit deletions as `(text, "")`.* They are real acts and the data is there. But the corpus
  exists to record how this writer improves a Malayalam sentence, and "the sentence was removed"
  answers a different question. Including them would also dominate the file for any writer who
  cuts as much as they add, which is most of them.
- *Emit composition as `("", text)`.* Same shape of mistake: writing is not revising, and the
  document itself is a better record of what was written.
- *Compare unfolded, so re-encoding shows up.* Then switching keyboards produces a revision for
  every paragraph in the manuscript, each with a before and after that are identical on screen.
  The corpus would be mostly that.
- *Treat a `move` as ending a run.* Reordering a paragraph between two typing bursts would then
  split one act of revision in two, for a change that touched no text.

**Consequences.**

- The corpus is smaller and every record in it is a rewrite.
- A document that has only been imported exports nothing at all, which is correct and needs
  saying in the UI — otherwise it reads as a broken button.
- `revisionIndex` counts coalesced acts of revision before triviality filtering, so indices in an
  exported file have gaps. That is information: index 7 means the seventh time this paragraph was
  worked over, and the six that were filtered are part of what the record says.

---

## ADR-0031 — File names handed to the browser are ASCII

**Status:** accepted

**Context.** Two features write files: backups (ADR-0013) and the corpus (ADR-0016). Both named
the file after the document, and the document is called `എഴുത്ത്`.

Measured in the Chromium this project tests against: a `download` attribute containing any
non-ASCII character is discarded whole, and the file is saved as `download` — no extension, and
colliding with every other download the browser has ever named that. `നോവൽ` and `café` fail
identically, so this is not a Malayalam problem and not a shaping problem; it is what the
attribute carries.

**Decision.** The title contributes to a file name only through an ASCII-safe stem, and is
omitted when nothing survives. The timestamp identifies the file: `ezhuthu-2026-08-10T09-30-00.json`.

This applies **only to file names handed to the browser.** It is not a rule about text anywhere
else, and it is nearly the opposite of the rules that govern content: stored text keeps its
original bytes (ADR-0014), comparison folds rather than strips (`docs/MALAYALAM.md` Rule 5),
and the corpus and backup files are Malayalam throughout.

**Alternatives considered.**

- *Keep the Unicode name.* Correct on browsers that carry it, and on the ones that do not, a
  backup called `download`, then `download(1)`. For the file ADR-0013 calls the only real
  protection against eviction, an unnamed extensionless duplicate is the failure wearing the
  appearance of success.
- *Percent-encode the title.* Survives, and produces `ezhuthu-%E0%B4%8E%E0%B4%B4...json`, which is
  worse to read than no title at all.
- *Transliterate to Latin.* Inventing a romanisation of the user's title, badly, in a project
  whose premise is that Malayalam deserves better than that.
- *Feature-detect at runtime.* There is nothing to detect: the attribute is set and the file is
  named by the browser afterwards, with no result the page can read.

**Consequences.**

- Every exported file has a name and an extension on every browser.
- A Malayalam-titled document's backups are distinguished by timestamp alone. Acceptable while
  there is one document; worth revisiting when there are several.
- The rule lives in one function, `fileNameStem` in `src/ui/download.ts`, with the measurement in
  its comment so the next reader does not widen the keep-set back.

---

## ADR-0032 — Judge a revision by the word that changed, not by the paragraph

**Status:** accepted · corrects the threshold in ADR-0012, not its intent

**Context.** ADR-0012 drops a pair when it "has a normalised edit distance below threshold with no
word-boundary change". Implemented literally, that is: change ÷ paragraph length below 5%, and the
same number of words on both sides.

Phase 7 ran it against a real manuscript for the first time — 116 prose paragraphs of a
4,400-word Malayalam narration script. It dropped **every word swap in the document, 27 of 27**,
which is the single thing ADR-0016 exists to collect.

The measurements say the rule could not have worked. A paragraph in that script averages 145
grapheme clusters.

| Change | Clusters | Of the paragraph | Words |
|---|---|---|---|
| `അയാൾ` → `അയാള` (typo) | 1 | 0.7% | unchanged |
| `കപ്പൽ` → `നൗക` (word choice) | 3 | 2.1% | unchanged |

No proportional cutoff separates 0.7% from 2.1%. What such a cutoff *does* separate is short
paragraphs from long ones — so the identical decision by the identical writer survived in a
sentence and vanished in a page, which is not a distinction anyone wants a corpus to encode.

**Decision.** The sub-threshold rule is replaced. A pair is a correction when the two sides have
the same number of words **and every word that differs is at most `TRIVIAL_MAX_WORD_CLUSTERS`
(1) from the word it replaced**. Nothing is measured against the paragraph.

This is what "typo corrections are not style" meant in ADR-0012; only the mechanism changes. The
other three rules — unchanged, single-cluster, punctuation — are untouched, and all of them were
correct against the real text on the first run.

**Alternatives considered.**

- *Lower the ratio.* Moves the boundary, does not create one: a typo and a word choice stay 3×
  apart at every paragraph length, and 3× is not enough when the absolute figures are 0.7% and
  2.1%.
- *Raise the absolute cluster threshold instead.* `TRIVIAL_MAX_CLUSTERS = 3` would drop word
  choices in short paragraphs, which is the same failure with a different constant.
- *Require exactly one word to differ.* Would keep a burst-coalesced revision that fixed two
  typos in one sitting. Every differing word being a misspelling is the same idea without the
  arbitrary count.
- *Drop the rule and keep everything.* The single-cluster rule already catches most typos, and
  this one catches the rest — two letters fixed in one word, a vowel sign and its neighbour. Worth
  keeping, now that it means something.

**Consequences.**

- Word choices survive at every paragraph length, which is the point.
- A one-cluster change is still dropped even when it is semantically enormous (`അവൻ` → `അവൾ`).
  That was already ADR-0012's accepted cost and is unchanged.
- The paragraph-level distance now only ever answers "at most one cluster", so its cutoff falls
  from 64 to 2 and the ratio is never computed. The filter got cheaper as well as correcter.
- `TrivialReason` gains `correction` and loses `sub-threshold`. The reason names are part of what
  the export reports, and the old name described a mechanism that no longer exists.
- The thresholds have now been run against real Malayalam prose. They had never been, and
  `HANDOFF.md` said so; that entry is what prompted the run.
