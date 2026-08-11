/**
 * Service worker registration. Deliberately quiet: a failure here costs
 * offline capability on the next load, never data.
 */

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  if (import.meta.env.DEV) return; // the dev server serves its own assets

  // Both the script URL and the scope come from the base the app was built
  // for: under a GitHub Pages project site the app lives at /<repo>/, and a
  // worker registered at the origin root would be out of scope there (and
  // 404 besides). BASE_URL is '/' for a root deployment. See ADR-0034.
  const base = import.meta.env.BASE_URL;

  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).catch(() => {
      // Offline capability is unavailable this session. Nothing else breaks:
      // the document lives in IndexedDB, not in the network cache.
    });
  });
}
