# Performance

"It feels fast" is not evidence. These budgets are enforced by `tests/perf`.

**Where they run.** Typecheck, unit tests, build and e2e run in CI on every pull request
(`.github/workflows/ci.yml`). The **performance suite deliberately does not.** GitHub's shared
runners have noisy, unpredictable CPU, so frame timings and cold-open measurements taken there are
not comparable between runs — and a budget that fails at random teaches everyone to ignore red
builds, which is worse than not measuring. Run the perf suite locally on a consistent machine and
put the numbers in the commit body.

## Budgets

| Metric | Budget | Why this number |
|---|---|---|
| Cold open, 100k-word document | **< 1.5 s** | Longer than this and the writer perceives a load, not an open. |
| Scroll | **sustained 60 fps** | Below this, navigating a long document feels broken on touch. |
| Keystroke to paint | **< 16 ms** | One frame. Above it, typing feels laggy — the worst failure this app could have. |
| Memory, 100k words | **< 150 MB** | Mid-range Android reclaims background tabs above roughly this. Exceeding it means the app is killed while the writer is in another app, and re-opening costs a cold start. |

## Running them

```bash
npm run corpus:generate   # once — writes the synthetic 80k-word Malayalam fixture
npm run test:perf
```

The `perf` Playwright project is separate from `e2e` because it seeds a large corpus and is slow.
It emulates a Pixel 7 with CPU throttling, so results are stable across machines but are *not*
absolute — they are a regression signal.

The fixture is gitignored (`tests/fixtures/generated/`). Regenerate it rather than committing
~600 KB of synthetic Malayalam.

## How each is measured

**Cold open.** Navigation start → the first block's paint, via `PerformanceObserver` on
element timing. Measured with a pre-seeded database, cold page load, service worker active — the
real second-launch path, not a first install.

**Scroll.** A scripted fling over the full document while recording frame timings. Asserts the
long-task count is zero and the 95th-percentile frame interval stays under 16.7 ms. Average fps is
not asserted — an average hides exactly the stutter that makes scrolling feel bad.

**Keystroke to paint.** `performance.mark()` on `input`, resolved after the next
`requestAnimationFrame`, sampled over a few hundred synthetic keystrokes. Note this measures our
handler and render, not IME composition, which cannot be driven synthetically
(see [`MALAYALAM.md`](MALAYALAM.md)).

**Memory.** `performance.measureUserAgentSpecificMemory()` after a full scroll pass, which is the
worst case because it has populated the height cache for every block.

## Why the app hits these

Not accidents — each budget is met by a specific structural decision.

**Cold open** is one indexed get plus one indexed range query, with no replay. The `blocks`
projection is maintained transactionally (ADR-0008), so opening never folds the log. This is why
snapshot cadence is not a cold-open variable (ADR-0009).

**Scroll** renders 15–30 blocks out of ~2,000. Heights are cached per `blockId` + viewport width,
so re-measurement happens on resize, not on scroll.

**Keystroke** is native — the focused block is a plain field and the browser paints the character
itself. We are only in the loop for the change handler, and the rule is that it **stores a string
and returns**. Word counting, segmentation, signal capture and persistence are all deferred to
idle or to the commit boundary. The budget is met by staying out of the way; it is lost the moment
anything is attached to `onChange`.

**Memory** stays bounded because block text is never all resident. What is held for every block is
a compact index — `{blockId, order, updatedAt, revisionCount, length}`, roughly 100 bytes, so
about 200 KB at 2,000 blocks. That index drives the minimap and the scrollbar. Text is fetched by
range as the viewport needs it; search runs as a cursor over IndexedDB (ADR-0015).

## Rules that keep them met

- The change handler stores a string and returns.
- Nothing that scales with document size runs on the main thread during typing or scrolling.
- Signals batch on a 2 s flush or `visibilitychange` — never a synchronous telemetry write.
- Never load all block text into memory. If you need document-wide data, use the compact index or
  an IndexedDB cursor.
- Historical replay (time-lapse) runs in a Web Worker.
- Any change to `render/` or `core/` reports perf numbers in the commit body.

## Recording results

Put the numbers in the commit body when you change anything on these paths. A trend across commits
is worth more than a single pass, and it is the only way to catch a slow regression that never
individually breaks a budget.
