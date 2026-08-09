import { expect, type Page } from '@playwright/test';

export const SMALL_DOC = [
  'ഒന്നാം ഖണ്ഡിക. കടൽ ശാന്തമായിരുന്നു.',
  'രണ്ടാം ഖണ്ഡിക. അവൻ ഒരു software engineer ആണ്.',
  'മൂന്നാം ഖണ്ഡിക. വർഷം തോറും മഴ പെയ്യുന്നു.',
].join('\n\n');

/**
 * Wipe IndexedDB before each test. Tests share an origin, so without this one
 * test's document leaks into the next.
 *
 * The delete runs from a same-origin page that does NOT boot the app.
 *
 * Doing it from the app — which is what this used to do — deletes a database
 * the page itself has open, so the request fires `blocked` instead of
 * `success` and completes only once that connection closes. Treating `blocked`
 * as done then reloads into a race: sometimes the deferred delete lands after
 * the fresh page has created its document, and the test that follows opens an
 * empty app and times out waiting for a block that was wiped underneath it.
 * That is the "element(s) not found: .block-row" flake, and it fails whichever
 * test happened to draw the short straw.
 *
 * An icon is a convenient host: same origin, no script, no database.
 */
export async function resetDatabase(page: Page): Promise<void> {
  await page.goto('/icons/icon.svg');
  await page.evaluate(async () => {
    const databases = (await indexedDB.databases?.()) ?? [{ name: 'ezhuthu' }];
    await Promise.all(
      databases.map(
        (d) =>
          new Promise<void>((resolve, reject) => {
            if (d.name === undefined) return resolve();
            const request = indexedDB.deleteDatabase(d.name);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(new Error(`delete failed: ${d.name}`));

            /*
             * `blocked` is deliberately NOT resolved. It means a connection is
             * still open — normally the app page we just navigated away from,
             * whose connection closes a moment later — and `success` follows
             * once it does. Resolving here is what made this racy: it reports
             * "deleted" while the deletion is still pending, and the delete
             * then lands on the next page's freshly created document.
             *
             * The timeout keeps a genuinely stuck delete from hanging the test
             * with no explanation.
             */
            setTimeout(() => reject(new Error(`delete never completed: ${d.name}`)), 10_000);
          }),
      ),
    );
  });
  await page.goto('/');
}

/**
 * Import text through the real file input rather than a test-only seam, so
 * what the tests exercise is the path a user actually takes.
 */
export async function importCorpus(page: Page, text: string): Promise<void> {
  await page.setInputFiles('[data-testid="import-input"]', {
    name: 'corpus.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(text, 'utf8'),
  });
  await expect(page.locator('.block-row, .block-editor').first()).toBeVisible({ timeout: 60_000 });
}

/** Import a file already on disk — used by the perf suite for the 80k corpus. */
export async function importCorpusFile(page: Page, path: string): Promise<void> {
  await page.setInputFiles('[data-testid="import-input"]', path);
  await expect(page.locator('.block-row, .block-editor').first()).toBeVisible({ timeout: 120_000 });
}

export interface SignalRow {
  blockId: string;
  kind: string;
  value: number;
  sessionId: string;
  ts: number;
}

/**
 * Read the `signals` store straight from IndexedDB.
 *
 * Through a second connection rather than through the app, for the same reason
 * `countEvents` does: what the app believes it queued is not evidence that a
 * batch was written, and the batch is the part that has to survive.
 */
export async function readSignals(page: Page): Promise<SignalRow[]> {
  return page.evaluate(async () => {
    const request = indexedDB.open('ezhuthu');
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const rows: SignalRow[] = await new Promise((resolve, reject) => {
      const r = db.transaction('signals').objectStore('signals').getAll();
      r.onsuccess = () => resolve(r.result as SignalRow[]);
      r.onerror = () => reject(r.error);
    });
    db.close();
    return rows;
  });
}

/** Total value of one kind of signal, over every block. */
export async function signalTotal(page: Page, kind: string): Promise<number> {
  const rows = await readSignals(page);
  return rows.filter((r) => r.kind === kind).reduce((sum, r) => sum + r.value, 0);
}

/**
 * Count rows in the event log, read straight from IndexedDB.
 *
 * Used to assert that an interaction appended exactly the events it should —
 * and, for composition, that it appended none at all.
 */
export async function countEvents(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const request = indexedDB.open('ezhuthu');
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const count: number = await new Promise((resolve, reject) => {
      const r = db.transaction('events').objectStore('events').count();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    db.close();
    return count;
  });
}
