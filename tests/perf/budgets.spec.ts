/**
 * The budgets from docs/PERFORMANCE.md, measured against the 80k-word
 * synthetic Malayalam corpus. "It feels fast" is not evidence.
 *
 *   npm run corpus:generate   # once
 *   npm run test:perf
 *
 * These do NOT run in CI: shared runners have noisy CPU, and a budget that
 * fails at random teaches everyone to ignore red builds. Run locally on a
 * consistent machine and put the numbers in the commit body.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { importCorpusFile, resetDatabase } from '../e2e/helpers';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = resolve(HERE, '../fixtures/generated/corpus-80k.txt');

const BUDGET = {
  coldOpenMs: 1500,
  keystrokeMs: 16,
  memoryMb: 150,
  frameMs: 16.7,
  // Not a frame budget: search runs on a deliberate action, not during typing
  // or scrolling. This is the threshold at which ADR-0015's decision to skip a
  // full-text index stops being defensible and the scan belongs in a Worker.
  searchMs: 250,
  /*
   * Opening the panel is the expensive half of time-lapse: a Worker start, a
   * cursor over every event to build the timeline, and a replay. It happens
   * once, on a deliberate action, so the budget is the point at which a reader
   * stops believing the button worked.
   */
  timelapseOpenMs: 2_000,
  /*
   * A scrub step is not a frame budget either — the drag is coalesced, so what
   * this bounds is how long the document lags the thumb once it settles. Past
   * this the slider stops feeling attached to the text.
   */
  scrubMs: 400,
  /*
   * The corpus is a batch export over the whole log. Nothing waits on it but
   * the person who asked, and the budget exists to catch the shape of the walk
   * changing — one cursor becoming one query per block, say.
   */
  corpusMs: 5_000,
};

/** Must match DEBOUNCE_MS in features/search/SearchPanel.tsx. */
const DEBOUNCE_MS = 180;

test.beforeAll(() => {
  if (!existsSync(CORPUS)) {
    throw new Error(`missing corpus — run \`npm run corpus:generate\` first (${CORPUS})`);
  }
});

/** Seed once per test: import the corpus, then reload so the DB is warm. */
async function seed(page: import('@playwright/test').Page): Promise<void> {
  await resetDatabase(page);
  await importCorpusFile(page, CORPUS);
}

test('cold open renders the first block within budget', async ({ page }) => {
  await seed(page);

  // The real second-launch path: a populated database, a fresh navigation.
  const started = Date.now();
  await page.reload();
  await page.locator('.block-row').first().waitFor({ state: 'visible' });
  const elapsed = Date.now() - started;

  const stats = await page.locator('.doc-toolbar .stat').textContent();
  console.log(`cold open: ${elapsed}ms  (${stats?.trim()})`);

  expect(elapsed).toBeLessThan(BUDGET.coldOpenMs);
});

test('renders a bounded window regardless of document size', async ({ page }) => {
  await seed(page);

  const rendered = await page.locator('.doc-item').count();

  /*
   * Poll for the count rather than reading it once. The toolbar shows an
   * ellipsis until the status load finishes, and on this corpus that load walks
   * the log to check the projection — comfortably longer than the import takes
   * to put rows on screen. A one-shot read captures the ellipsis, or a count
   * from before the import, and reports "0 blocks": indistinguishable from the
   * virtualiser rendering a document that is not there.
   */
  const blockCount = () =>
    page.evaluate(() =>
      Number(document.querySelector('.doc-toolbar .stat')?.textContent?.match(/([\d,]+) blocks/)?.[1]?.replace(/,/g, '') ?? 0),
    );
  await expect.poll(blockCount, { timeout: 30_000 }).toBeGreaterThan(1000);
  const blocks = await blockCount();

  console.log(`rendered ${rendered} of ${blocks} blocks`);
  expect(blocks).toBeGreaterThan(1000);
  expect(rendered).toBeLessThan(60);
});

test('scrolling stays within the frame budget', async ({ page }) => {
  await seed(page);

  const result = await page.evaluate(async () => {
    const scroller = document.querySelector('.doc-scroll');
    if (scroller === null) throw new Error('no scroller');

    const frames: number[] = [];
    let last = performance.now();
    let running = true;

    const tick = () => {
      const now = performance.now();
      frames.push(now - last);
      last = now;
      if (running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    // A scripted fling down the document.
    for (let i = 0; i < 60; i++) {
      scroller.scrollTop += 600;
      await new Promise((r) => requestAnimationFrame(r));
    }
    running = false;
    await new Promise((r) => setTimeout(r, 50));

    const sorted = [...frames].sort((a, b) => a - b);
    return {
      frames: frames.length,
      p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
      worst: sorted.at(-1) ?? 0,
      scrolled: scroller.scrollTop,
    };
  });

  console.log(
    `scroll: ${result.frames} frames, p95 ${result.p95.toFixed(1)}ms, worst ${result.worst.toFixed(1)}ms`,
  );

  expect(result.scrolled).toBeGreaterThan(10_000);
  // p95 rather than the average: an average hides exactly the stutter that
  // makes scrolling feel bad.
  expect(result.p95).toBeLessThan(BUDGET.frameMs * 2);
});

test('keystroke to paint stays under one frame', async ({ page }) => {
  await seed(page);

  await page.locator('.block-row').first().click();
  await expect(page.locator('.block-editor')).toBeFocused();

  const result = await page.evaluate(async () => {
    const field = document.querySelector('.block-editor') as HTMLTextAreaElement;

    // Two separate measurements, because "keystroke to paint" cannot be timed
    // by waiting for the next animation frame: rAF is quantised to the display
    // refresh, so that approach reports ~16.7ms however fast the handler is.
    //
    //   handler — synchronous cost of our onInput, including React's discrete
    //             render and the forced layout the auto-grow does. This is the
    //             work that has to fit inside a frame.
    //   frames  — intervals between consecutive frames WHILE typing. If the
    //             handler overruns, frames are dropped and this doubles.
    const handler: number[] = [];
    const frames: number[] = [];

    let last = performance.now();
    let running = true;
    const tick = () => {
      const now = performance.now();
      frames.push(now - last);
      last = now;
      if (running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    for (let i = 0; i < 200; i++) {
      const started = performance.now();
      field.value += 'ക';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      handler.push(performance.now() - started);
      await new Promise((r) => requestAnimationFrame(r));
    }
    running = false;
    await new Promise((r) => setTimeout(r, 50));

    const pick = (xs: number[], q: number) => {
      const sorted = [...xs].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length * q)] ?? 0;
    };

    return {
      handlerMedian: pick(handler, 0.5),
      handlerP95: pick(handler, 0.95),
      frameP95: pick(frames.slice(1), 0.95),
    };
  });

  console.log(
    `keystroke: handler median ${result.handlerMedian.toFixed(2)}ms, ` +
      `p95 ${result.handlerP95.toFixed(2)}ms · frame p95 ${result.frameP95.toFixed(1)}ms`,
  );

  // The handler must fit inside one frame with room to spare.
  expect(result.handlerMedian).toBeLessThan(BUDGET.keystrokeMs);
  expect(result.handlerP95).toBeLessThan(BUDGET.keystrokeMs);
  // ...and typing must not drop frames.
  expect(result.frameP95).toBeLessThan(BUDGET.frameMs * 2);
});

test('memory stays within budget after a full scroll pass', async ({ page }) => {
  await seed(page);

  // Worst case: the height cache has an entry for every block scrolled past.
  await page.evaluate(async () => {
    const scroller = document.querySelector('.doc-scroll');
    if (scroller === null) return;
    for (let i = 0; i < 120; i++) {
      scroller.scrollTop += 2000;
      await new Promise((r) => requestAnimationFrame(r));
    }
  });

  const bytes = await page.evaluate(async () => {
    const api = (performance as { measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }> })
      .measureUserAgentSpecificMemory;
    // The method EXISTS without cross-origin isolation and throws SecurityError
    // when called, so checking for it is not enough — the call itself has to be
    // guarded. `crossOriginIsolated` is supplied by preview.headers in
    // vite.config.ts; if those are ever removed this skips instead of failing.
    if (typeof api !== 'function' || !globalThis.crossOriginIsolated) return null;
    try {
      return (await api.call(performance)).bytes;
    } catch {
      return null;
    }
  });

  if (bytes === null) {
    // Reported rather than silently skipped, so the gap stays visible.
    console.log('memory: measureUserAgentSpecificMemory unavailable — NOT MEASURED');
    test.skip();
    return;
  }

  const mb = bytes / (1024 * 1024);
  console.log(`memory: ${mb.toFixed(1)} MB`);
  expect(mb).toBeLessThan(BUDGET.memoryMb);
});

test('search scans the whole document within budget', async ({ page }) => {
  await seed(page);
  await page.getByTestId('search-toggle').click();

  /*
   * ADR-0015 accepted a linear scan over the store on the grounds that at this
   * size it is "a few milliseconds", and deferred a full-text index until
   * measurement said otherwise. This is that measurement — without it, the
   * decision not to build an index rests on an estimate.
   *
   * Measured through the real panel rather than a test-only handle on
   * searchDocument, for the same reason the e2e helpers import through the
   * file input: a seam measures a path no user takes. The cost of that is that
   * the number includes the 180 ms debounce and the result render, so it is
   * "keystroke to results", not scan time. Scan time is the reported figure
   * minus the debounce, and the budget below allows for both.
   */
  const measure = (needle: string) =>
    page.evaluate(async (text) => {
      const input = document.querySelector<HTMLInputElement>('[data-testid="search-input"]');
      const summary = document.querySelector('[data-testid="search-summary"]');
      if (input === null || summary === null) return null;

      const settled = new Promise<number>((resolve) => {
        const observer = new MutationObserver(() => {
          const shown = summary.textContent ?? '';
          // The in-progress state ends with an ellipsis; anything else is a
          // finished scan reporting its count.
          if (shown !== '' && !shown.endsWith('…')) {
            observer.disconnect();
            resolve(performance.now());
          }
        });
        observer.observe(summary, { childList: true, subtree: true, characterData: true });
      });

      // React owns the input's value, so set it through the prototype and
      // dispatch the event React is listening for.
      const started = performance.now();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));

      const finished = await settled;
      return { ms: finished - started, summary: summary.textContent ?? '' };
    }, needle);

  // Warm the store's page cache first; the interesting number is the second
  // query, not the one that paid for the first read of the object store.
  await measure('കടൽ');

  // Three shapes: a miss (scans every block, so it is the honest worst case
  // for scan cost), a very common word, and one that only matches in full
  // through the chillu fold.
  const cases: Array<[name: string, needle: string]> = [
    ['miss', 'ഇങ്ങനെയൊരു വാക്ക് ഇവിടെ ഇല്ല'],
    ['common', 'മരം'],
    ['chillu', 'അവൻ'],
  ];

  const summaries: Record<string, string> = {};

  for (const [name, needle] of cases) {
    const result = await measure(needle);
    expect(result).not.toBeNull();
    summaries[name] = result!.summary;
    console.log(
      `search (${name}): ${result!.ms.toFixed(0)}ms keystroke-to-results ` +
        `(~${Math.max(0, result!.ms - DEBOUNCE_MS).toFixed(0)}ms scan) · ${result!.summary}`,
    );
    expect(result!.ms).toBeLessThan(DEBOUNCE_MS + BUDGET.searchMs);
  }

  /*
   * Not a timing assertion, but the corpus is the only place we can make it:
   * scripts/generate-corpus.ts writes അവൻ 754 times atomically and 819 times
   * as the ZWJ sequence. A search on raw bytes finds 754 of them. The fold is
   * what turns that into 1,573 — over eight hundred paragraphs of a manuscript
   * that would otherwise be invisible to search.
   */
  expect(summaries.chillu).toContain('1,573');
});

/**
 * Revise one paragraph, so the log has a revision in it and the timeline has
 * more than one stop. Through the real editor: a seam that wrote events
 * directly would measure a path no writer takes, and would also bypass the
 * projection the editor maintains.
 */
async function reviseFirstBlock(page: import('@playwright/test').Page): Promise<void> {
  const first = page.locator('.block-row').first();
  await expect(first).not.toHaveText('');
  await first.click();
  const editor = page.locator('.block-editor');
  await editor.fill('തിരുത്തിയ ഖണ്ഡിക — കടൽ ഇളകിമറിഞ്ഞു, ആകാശം ഇരുണ്ടു, കാറ്റ് ഉയർന്നു.');
  await editor.blur();
  await expect(page.locator('.block-row').first()).toContainText('തിരുത്തിയ');
}

test('time-lapse opens and materialises a past state within budget', async ({ page }) => {
  await seed(page);
  await reviseFirstBlock(page);

  /*
   * Measured in the page rather than by polling from Node. Playwright's default
   * poll interval is 100 ms, which is a quarter of the scrub budget below — a
   * ruler that coarse would report the same number for a fast implementation
   * and a slow one.
   */
  const openMs = await page.evaluate(async () => {
    const started = performance.now();
    const settled = new Promise<number>((resolve) => {
      const observer = new MutationObserver(() => {
        const label = document.querySelector('[data-testid="timelapse-label"]');
        if (label !== null && /\d+ paragraphs/.test(label.textContent ?? '')) {
          observer.disconnect();
          resolve(performance.now());
        }
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    });

    document.querySelector<HTMLButtonElement>('[data-testid="timelapse-toggle"]')!.click();
    return (await settled) - started;
  });

  const label = await page.getByTestId('timelapse-label').textContent();
  console.log(`time-lapse open: ${openMs.toFixed(0)}ms  (${label?.trim()})`);
  expect(openMs).toBeLessThan(BUDGET.timelapseOpenMs);

  // A scrub step: all the way back to the import, which is the longest replay
  // this document can ask for.
  const scrubMs = await page.evaluate(async () => {
    const doc = document.querySelector('[data-testid="timelapse-doc"]')!;
    const slider = document.querySelector<HTMLInputElement>('[data-testid="timelapse-slider"]')!;
    const before = doc.textContent ?? '';

    const settled = new Promise<number>((resolve) => {
      const observer = new MutationObserver(() => {
        if ((doc.textContent ?? '') !== before) {
          observer.disconnect();
          resolve(performance.now());
        }
      });
      observer.observe(doc, { childList: true, subtree: true, characterData: true });
    });

    const started = performance.now();
    // React owns the value, so it is set through the prototype and the event
    // React is listening for is dispatched by hand.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(slider, '0');
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));

    return (await settled) - started;
  });

  console.log(`time-lapse scrub to the earliest stop: ${scrubMs.toFixed(0)}ms`);
  expect(scrubMs).toBeLessThan(BUDGET.scrubMs);
});

test('the corpus export walks the whole log within budget', async ({ page }) => {
  await seed(page);
  await reviseFirstBlock(page);

  const result = await page.evaluate(async () => {
    const started = performance.now();
    const settled = new Promise<string>((resolve) => {
      const observer = new MutationObserver(() => {
        const message = document.querySelector('[data-testid="message"]');
        const shown = message?.textContent ?? '';
        if (shown.includes('Exported') || shown.includes('revisions')) {
          observer.disconnect();
          resolve(shown);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    });

    document.querySelector<HTMLButtonElement>('[data-testid="corpus-export"]')!.click();
    const message = await settled;
    return { ms: performance.now() - started, message };
  });

  console.log(`corpus export: ${result.ms.toFixed(0)}ms · ${result.message}`);
  expect(result.ms).toBeLessThan(BUDGET.corpusMs);
});
