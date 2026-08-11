/**
 * Build-generated precache manifest for the service worker (Phase 8, ADR-0035).
 *
 * The worker's shell list used to be five paths typed by hand, which is a list
 * that goes stale the first time the build emits a chunk nobody remembered —
 * and it had: the time-lapse replay Worker is its own chunk, so a first
 * *offline* open could not start it.
 *
 * The list is injected into the built copy of `sw.js` rather than written to a
 * side-car file the worker fetches. That is the whole point and it is not an
 * implementation detail: a browser decides whether to install a new worker by
 * byte-comparing the script it already has. A list living anywhere else leaves
 * `sw.js` byte-identical from one deploy to the next, so the update is never
 * noticed and the shell in the cache is whatever shipped first.
 *
 * The pure half — which files, in what order, and the revision they hash to —
 * is exported separately from the plugin so it can be unit-tested without
 * running a build.
 */

import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'vite';

const MARKER_START = '// --- build-injected: scripts/precache.ts ---';
const MARKER_END = '// --- end build-injected ---';

/**
 * Everything the build emits is shell, with three exceptions. An allowlist was
 * the old design and the old bug; the default has to be "cache it", so that a
 * new chunk is covered by existing code rather than by someone remembering.
 *
 * - `sw.js` — a worker must not precache itself. The copy in the cache would
 *   be served in place of the updated one and the shell would freeze forever.
 * - `404.html` — a byte-for-byte duplicate of `index.html`, added by the Pages
 *   workflow because Pages has no rewrite rules (ADR-0034). Offline
 *   navigations are answered from the cached index; caching it twice buys
 *   nothing.
 * - `.map` and `.txt` — source maps are several times the size of everything
 *   else combined and are fetched only by devtools, and the only `.txt` is the
 *   font licence. Neither is on any path the reader takes.
 */
export function isPrecachable(relativePath: string): boolean {
  if (relativePath === 'sw.js' || relativePath === '404.html') return false;
  const extension = path.posix.extname(relativePath);
  return extension !== '.map' && extension !== '.txt';
}

/**
 * Sorted, so that two builds of identical output produce an identical worker.
 * Without it the revision below would change whenever the filesystem felt like
 * returning directory entries in a different order, and every deploy would
 * throw away a cache that was already correct.
 */
export function selectPrecache(relativePaths: readonly string[]): string[] {
  return relativePaths.filter(isPrecachable).sort();
}

/**
 * The cache name's version segment: content, not a timestamp or a counter.
 *
 * Hashing the *contents* rather than the names matters for the files whose
 * names carry no hash — `index.html`, the manifest, the font, the icons. A
 * rebuild that changes only `index.html` still has to invalidate the cache,
 * and a rebuild that changes nothing must not.
 */
export function revisionOf(entries: readonly { path: string; hash: string }[]): string {
  const digest = createHash('sha256');
  for (const entry of [...entries].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    digest.update(`${entry.path}:${entry.hash}\n`);
  }
  return digest.digest('hex').slice(0, 12);
}

export function hashOf(contents: Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex');
}

/**
 * Replace the block between the markers in `sw.js`.
 *
 * A missing marker throws rather than warning. The failure it prevents is
 * silent and remote: a worker that ships with the two-entry development
 * fallback still installs, still serves, and is only wrong when someone is
 * offline.
 */
export function injectManifest(source: string, entries: readonly string[], revision: string): string {
  const start = source.indexOf(MARKER_START);
  const end = source.indexOf(MARKER_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      'precache: sw.js has no build-injected block. Restore the marker comments ' +
        `(${MARKER_START} … ${MARKER_END}) or update scripts/precache.ts.`,
    );
  }

  const injected = [
    MARKER_START,
    `const BUILD = ${JSON.stringify(revision)};`,
    `const PRECACHE = ${JSON.stringify(entries, null, 2)};`,
    MARKER_END,
  ].join('\n');

  return source.slice(0, start) + injected + source.slice(end + MARKER_END.length);
}

async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix === '' ? entry.name : path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(root, relative)));
    else files.push(relative);
  }
  return files;
}

/**
 * Runs at `closeBundle`, which is after Vite has copied `public/` into the
 * output directory — the font, the icons, the manifest and `sw.js` itself all
 * arrive that way, and precaching a list taken before the copy would miss
 * every one of them.
 */
export function precacheManifest(): Plugin {
  let outDir = 'dist';

  return {
    name: 'ezhuthu:precache',
    apply: 'build',

    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },

    async closeBundle() {
      const entries = selectPrecache(await listFiles(outDir));
      const hashed = await Promise.all(
        entries.map(async (entry) => ({
          path: entry,
          hash: hashOf(await readFile(path.join(outDir, entry))),
        })),
      );
      const revision = revisionOf(hashed);

      const swPath = path.join(outDir, 'sw.js');
      const source = await readFile(swPath, 'utf8');
      await writeFile(swPath, injectManifest(source, entries, revision), 'utf8');

      this.info(`precache: ${entries.length} assets, revision ${revision}`);
    },
  };
}
