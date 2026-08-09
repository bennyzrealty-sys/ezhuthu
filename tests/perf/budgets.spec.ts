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
};

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
  const blocks = await page.evaluate(() =>
    Number(document.querySelector('.doc-toolbar .stat')?.textContent?.match(/([\d,]+) blocks/)?.[1]?.replace(/,/g, '') ?? 0),
  );

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
