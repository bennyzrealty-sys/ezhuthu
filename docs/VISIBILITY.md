# Visibility — edited lines at a glance

Requirement 2 of the project: **make edited lines identifiable at a glance**, so work is findable
inside a 100,000-word document without scrolling through it. Everything here reads from state the
log already maintains — `updatedAt`, `revisionCount`, soft-delete markers, and the `scrollback`
signal — so, like the resume strip, **it stores nothing of its own.**

## The intensity model (`src/features/visibility/intensity.ts`)

One value per block, two dimensions, computed at render time and never stored (ADR-0006):

| Dimension | From | Meaning |
|---|---|---|
| **opacity** | `updatedAt`, decayed in bands | how recently it was edited |
| **saturation** | `revisionCount` | how many times |

Decay bands (ADR-0006): < 1 hour → 100%, < 1 day → 60%, < 1 week → 25%, older → 0%. A document
reopened after a month shows a clean slate. Saturation is a monotonic curve that separates a
paragraph fought over forty times from one lightly edited, without either pinning flat.

**The mark is for revision, not arrival (ADR-0027).** `markIntensity` returns `null` for a block
with `revisionCount === 0`, so an import — which sets every block's `updatedAt` to now but edits
none of them — lights nothing. The same `revisionCount > 0` filter the "last edited" resume
destination uses, for the same reason.

Time is a parameter throughout (CLAUDE.md rule 8). The render layer reads an injected clock once
per render, so the whole document ages against one instant and the decay stays testable.

## The margin bar (ADR-0005) — `src/render/MarginBar.tsx`

A 4 px bar in the left gutter of each edited block. The colour is one hue — the accent — mixed
toward a neutral grey by saturation and faded by opacity, so the signal is **opacity and
saturation, never hue**, which makes it colour-blind safe. The text itself is never restyled:
colouring Malayalam glyphs fights their conjunct density, and legibility is the product.

It renders as a sibling of the block inside the absolutely-positioned item, so it cannot reflow a
glyph, and it is the same bar whether the block is a read-only row or the focused editor.

## The minimap (ADR-0021) — `src/render/Minimap.tsx`

The whole document as a narrow column on the right edge, shaded by intensity. **Buckets, not
blocks:** one per device-pixel row, each taking the *maximum* intensity of the blocks in it, never
the average — one hot paragraph among twenty cold ones must survive, and an average would drown it.
A tap jumps to the winning block exactly, or to a proportional position where the column is cold.

Drawn to a `<canvas>` (bucketing is `src/features/visibility/minimap.ts`, pure). Cost is the
column's height, not the document's length — O(1) in document size — and it reads only the compact
index, never block text. It is memoised on the index, so it does not redraw while scrolling.

## Ghost markers (ADR-0018) — `src/render/Seam.tsx`

A deletion leaves nothing to mark, so it leaves a **seam**: a 2 px rule at the join where blocks
were removed, which reveals the deleted text on a tap and restores it on another. Deleted text is
recoverable from the log regardless; the seam is what tells the reader it is there. Restore is an
`insert` naming the soft-deleted block with no position, so it returns to where it was. Consecutive
deletions collapse into one seam. Seam placement is pure (`src/features/visibility/seams.ts`).

**A merge is not a deletion (ADR-0028).** Backspace at the start of a block is *implemented* as a
soft delete, but the text survives in the neighbour, so a ghost of it would reveal text already on
screen and restoring it would duplicate that text. The delete event carries `mergedInto`, the fold
records it on `meta`, and seam computation skips it. A deliberate **Delete** control on the focused
block is what produces a real ghost — the entry point every seam in the document comes from.

## Scroll-back auto-bookmarks (`src/features/visibility/bookmarks.ts`)

The `scrollback` signal (Phase 4) fires when the writer scrolls up and settles — going back to
check a reference. Nobody asked to bookmark those places; the returning *is* the bookmark. The
Bookmarks panel lists them, ranked by how *often* a block was returned to (then how long), windowed
and with deleted blocks dropped. Reached from the toolbar, each row jumps to the block.

## Scroll-past feedback (ADR-0022) — `src/features/visibility/feedback.ts`

A haptic tick and/or a visual pulse on the margin bar as an edited region crosses the viewport
centre. **Both opt-in, off by default.** Honest about the platform split: `navigator.vibrate` is
absent on iOS Safari, so haptics are feature-detected and the setting is shown disabled with the
reason where the API is missing, rather than silently doing nothing. The visual pulse is a separate
cross-platform setting — not a claimed substitute — and it is suppressed under
`prefers-reduced-motion`.

The when-to-pulse decision is pure (`EditedRegionPulse`): one pulse per edited region entered, never
more than one per 300 ms. The scroll handler finds the centre block from the virtualiser's
content-relative offsets, so it forces no layout, and it skips its body entirely when neither
feedback is enabled.

## Performance

Against the 80,022-word corpus, Phase 6 changed no budget. The margin bar is a few map lookups per
rendered row (~12), the minimap is a canvas redrawn only when the index changes, seams are computed
in the one ordered read the index already does, and the scroll-feedback handler does nothing until a
setting turns it on. See [`PERFORMANCE.md`](PERFORMANCE.md) and the table in the README.

## The modules

| File | What |
|---|---|
| `features/visibility/intensity.ts` | decay + saturation, pure, the value behind the bar and the minimap |
| `features/visibility/minimap.ts` | bucketing (max per bucket) + jump targeting, pure |
| `features/visibility/seams.ts` | where ghost markers go, pure |
| `features/visibility/bookmarks.ts` | scroll-back auto-bookmarks, a query over the signal |
| `features/visibility/feedback.ts` | haptics + visual pulse: detection, throttle, settings |
| `render/MarginBar.tsx` | the 4 px gutter bar |
| `render/Minimap.tsx` | the canvas column |
| `render/Seam.tsx` | the ghost marker: reveal + restore |
| `features/visibility/BookmarksPanel.tsx` | the auto-bookmarks list |
