/**
 * Cache-first service worker for the app shell.
 *
 * Phase 1 scaffolding: enough that the app opens with the network disabled,
 * which is the minimum for something that claims to be offline-first. Phase 8
 * replaces the hand-maintained asset list with a build-generated precache
 * manifest and adds the install flow and offline verification tests.
 *
 * Plain JS on purpose — it is served straight from /public and never passes
 * through the bundler.
 *
 * IMPORTANT: this worker caches the app shell only. It must never cache or
 * intercept anything carrying document content, because there is no such
 * traffic — the document lives in IndexedDB and never crosses the network.
 */

const CACHE = 'ezhuthu-shell-v1';

const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon.svg'];

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
      caches.match('/index.html').then((cached) => cached ?? fetch(request)),
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
