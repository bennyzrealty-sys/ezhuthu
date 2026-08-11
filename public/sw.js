/**
 * Cache-first service worker for the app shell.
 *
 * Plain JS on purpose — it is served straight from /public and never passes
 * through the bundler. The one thing done to it is the precache list below,
 * substituted into the built copy by `scripts/precache.ts` (ADR-0035).
 *
 * IMPORTANT: this worker caches the app shell only. It must never cache or
 * intercept anything carrying document content, because there is no such
 * traffic — the document lives in IndexedDB and never crosses the network.
 */

// Every shell URL is resolved against the registration scope rather than
// written as an origin-absolute path: the app is served from /<repo>/ on a
// GitHub Pages project site and from / everywhere else, and the worker is
// copied verbatim into the build, so it cannot be told which at build time.
// `scope` already ends in a slash. See ADR-0034.
const scoped = (path) => new URL(path, self.registration.scope).href;

/*
 * Everything between the markers is REPLACED AT BUILD TIME with the real asset
 * list and a revision hashed from their contents. Do not edit it, and do not
 * move the list into a file the worker fetches: the browser decides whether to
 * install a new worker by byte-comparing this script, so a list held anywhere
 * else would leave sw.js identical across deploys and the cached shell would
 * never update. ADR-0035.
 *
 * The values below are the fallback for an unbuilt copy — `vite dev` skips
 * registration entirely (src/pwa/register.ts), so nothing normally runs them.
 */
// --- build-injected: scripts/precache.ts ---
const BUILD = 'dev';
const PRECACHE = ['index.html', 'manifest.webmanifest'];
// --- end build-injected ---

// Content-addressed, so `activate` drops the previous shell exactly when the
// shell has actually changed — and, because the previous cache is dropped
// whole, so do any runtime-cached entries left under an older base (ADR-0034).
const CACHE = `ezhuthu-shell-${BUILD}`;

const SHELL_INDEX = scoped('index.html');

// The scope itself is cached alongside index.html: a navigation to the root
// asks for `/`, and the cache is keyed by URL.
//
// The font is in the generated list by rule rather than by hand now, but it is
// still the entry that matters most: it is on the first-paint path with
// `font-display: block` (src/ui/fonts.css), so a cold offline open that has to
// wait for it shows an empty page (ADR-0019).
const SHELL = [self.registration.scope, ...PRECACHE.map(scoped)];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // addAll fails the whole install if any single URL 404s, which would
      // leave the app with no worker at all. Individual puts degrade instead.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations: cache-first on the shell, so a cold offline open works.
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.match(SHELL_INDEX).then((cached) => cached ?? fetch(request)),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});
