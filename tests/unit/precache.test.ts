import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  hashOf,
  injectManifest,
  isPrecachable,
  revisionOf,
  selectPrecache,
} from '../../scripts/precache';

// From the working directory, not `import.meta.url`: the unit suite runs in
// jsdom, where `import.meta.url` is an http: URL and cannot be resolved to a
// path. Vitest runs from the repository root.
const SW_SOURCE = readFileSync(path.join(process.cwd(), 'public/sw.js'), 'utf8');

/** A realistic build output, in the order a filesystem might hand it over. */
const BUILD_OUTPUT = [
  'sw.js',
  'index.html',
  'manifest.webmanifest',
  'assets/index-C-VLTkbL.js',
  'assets/index-C-VLTkbL.js.map',
  'assets/index-Cx-HrIcM.css',
  'assets/replay.worker-CU1hBoUW.js',
  'fonts/manjari-regular.woff2',
  'fonts/OFL.txt',
  'icons/icon.svg',
  'icons/icon-192.png',
  '404.html',
];

describe('what gets precached (ADR-0035)', () => {
  it('includes the replay Worker chunk', () => {
    // The bug the generated manifest exists to fix: the Worker is its own
    // chunk, so a hand-written shell list left a first offline open unable to
    // start time-lapse at all.
    expect(selectPrecache(BUILD_OUTPUT)).toContain('assets/replay.worker-CU1hBoUW.js');
  });

  it('covers a new chunk without anyone adding it', () => {
    const withNewChunk = [...BUILD_OUTPUT, 'assets/some-future-feature-Ab12Cd.js'];
    expect(selectPrecache(withNewChunk)).toContain('assets/some-future-feature-Ab12Cd.js');
  });

  it('never precaches the worker itself', () => {
    // A cached sw.js would be served in place of the updated one, and the
    // shell would freeze at whatever shipped first.
    expect(isPrecachable('sw.js')).toBe(false);
  });

  it('skips 404.html, source maps and the font licence', () => {
    expect(isPrecachable('404.html')).toBe(false);
    expect(isPrecachable('assets/index-C-VLTkbL.js.map')).toBe(false);
    expect(isPrecachable('fonts/OFL.txt')).toBe(false);
  });

  it('keeps the first-paint assets', () => {
    const selected = selectPrecache(BUILD_OUTPUT);
    expect(selected).toEqual([
      'assets/index-C-VLTkbL.js',
      'assets/index-Cx-HrIcM.css',
      'assets/replay.worker-CU1hBoUW.js',
      'fonts/manjari-regular.woff2',
      'icons/icon-192.png',
      'icons/icon.svg',
      'index.html',
      'manifest.webmanifest',
    ]);
  });

  it('is sorted, so two builds of the same output agree', () => {
    const shuffled = [...BUILD_OUTPUT].reverse();
    expect(selectPrecache(shuffled)).toEqual(selectPrecache(BUILD_OUTPUT));
  });
});

describe('the cache revision', () => {
  const entries = [
    { path: 'index.html', hash: 'aaa' },
    { path: 'assets/index-C-VLTkbL.js', hash: 'bbb' },
  ];

  it('does not depend on the order it is given', () => {
    expect(revisionOf(entries)).toBe(revisionOf([...entries].reverse()));
  });

  it('changes when a file changes', () => {
    // index.html carries no hash in its name, so nothing else would notice.
    const edited = [{ path: 'index.html', hash: 'zzz' }, entries[1]!];
    expect(revisionOf(edited)).not.toBe(revisionOf(entries));
  });

  it('changes when a file is added', () => {
    expect(revisionOf([...entries, { path: 'icons/icon.svg', hash: 'ccc' }])).not.toBe(
      revisionOf(entries),
    );
  });

  it('does not change when nothing does', () => {
    expect(revisionOf(entries)).toBe(revisionOf(entries));
  });

  it('hashes contents, not names', () => {
    expect(hashOf(new TextEncoder().encode('a'))).not.toBe(
      hashOf(new TextEncoder().encode('b')),
    );
  });
});

describe('injecting the manifest into sw.js', () => {
  it('replaces the fallback in the real worker source', () => {
    // Reads public/sw.js rather than a fixture: if the markers are ever edited
    // out of the file the build actually ships, this is what says so.
    const injected = injectManifest(SW_SOURCE, ['index.html', 'assets/app-1234.js'], 'abc123');

    expect(injected).toContain('const BUILD = "abc123";');
    expect(injected).toContain('"assets/app-1234.js"');
    expect(injected).not.toContain("const BUILD = 'dev';");
    // Everything outside the block survives.
    expect(injected).toContain('const scoped = (path) =>');
    expect(injected).toContain("self.addEventListener('fetch'");
  });

  it('can be applied to its own output, so a rebuild is not a special case', () => {
    const once = injectManifest(SW_SOURCE, ['index.html'], 'aaa');
    const twice = injectManifest(once, ['index.html'], 'bbb');
    expect(twice).toContain('const BUILD = "bbb";');
    expect(twice).not.toContain('const BUILD = "aaa";');
  });

  it('throws rather than shipping the development fallback', () => {
    // The failure it prevents is invisible until someone is offline.
    expect(() => injectManifest('const CACHE = "x";', ['index.html'], 'abc')).toThrow(
      /no build-injected block/,
    );
  });
});
