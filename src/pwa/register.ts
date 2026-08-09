/**
 * Service worker registration. Deliberately quiet: a failure here costs
 * offline capability on the next load, never data.
 */

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  if (import.meta.env.DEV) return; // the dev server serves its own assets

  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      // Offline capability is unavailable this session. Nothing else breaks:
      // the document lives in IndexedDB, not in the network cache.
    });
  });
}
