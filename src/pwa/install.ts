/**
 * Home-screen install (Phase 8).
 *
 * Installing is not decoration on this app. iOS grants an installed PWA much
 * better odds against storage eviction than a tab (ADR-0013), and the whole
 * durability story — a manuscript that lives only in IndexedDB — rests on the
 * browser not throwing it away.
 *
 * Three states, because there are genuinely three:
 *
 * - `installed`   already running from the home screen. Nothing to offer.
 * - `promptable`  the browser has offered us a prompt to defer and fire on a
 *                 gesture. Chromium only.
 * - `manual`      no prompt exists. This is iOS Safari, and it is also every
 *                 browser before the user has met whatever engagement
 *                 heuristic it applies. The honest thing is to say where the
 *                 install lives in the browser's own menu, not to hide.
 *
 * No user-agent sniffing anywhere: `manual` is inferred from the absence of an
 * event, which is the thing we actually care about, and stays correct on a
 * browser nobody here has heard of.
 *
 * Deliberately not React. The event fires when the browser decides, which is
 * routinely before the app has mounted — the controller is created at module
 * load from main.tsx so the listener is attached as early as it can be.
 */

export type InstallAvailability = 'installed' | 'promptable' | 'manual';

export type InstallOutcome = 'accepted' | 'dismissed' | 'unavailable';

/**
 * `beforeinstallprompt` is not in lib.dom — it is not in any standard. Typed
 * here to the two members we use.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * The window surface this needs, so the unit tests can hand it a fake without
 * a browser. `navigator.standalone` is the iOS-only signal.
 */
export interface InstallHost {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  matchMedia(query: string): { matches: boolean };
  navigator: { standalone?: boolean };
}

export interface InstallController {
  availability(): InstallAvailability;
  subscribe(listener: () => void): () => void;
  /**
   * Must be called from a user gesture — browsers reject a deferred prompt
   * fired from anywhere else, which is why this is not called on mount.
   */
  prompt(): Promise<InstallOutcome>;
}

/**
 * Already running installed?
 *
 * `display-mode: standalone` matches what the manifest asks for, and iOS
 * Safari answers `navigator.standalone` instead of implementing the media
 * query. A tab in a browser matches neither.
 */
function isStandalone(host: InstallHost): boolean {
  return host.matchMedia('(display-mode: standalone)').matches || host.navigator.standalone === true;
}

export function createInstallController(host: InstallHost): InstallController {
  let deferred: BeforeInstallPromptEvent | null = null;
  let installed = isStandalone(host);
  const listeners = new Set<() => void>();

  const announce = (): void => {
    for (const listener of listeners) listener();
  };

  host.addEventListener('beforeinstallprompt', (event) => {
    // Without preventDefault the event is consumed by the browser's own UI and
    // cannot be replayed later, so there is nothing to put behind a button.
    event.preventDefault();
    deferred = event as BeforeInstallPromptEvent;
    announce();
  });

  host.addEventListener('appinstalled', () => {
    // A prompt is single-use, and after this one there is nothing left to
    // install anyway.
    deferred = null;
    installed = true;
    announce();
  });

  return {
    availability() {
      if (installed) return 'installed';
      return deferred === null ? 'manual' : 'promptable';
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async prompt() {
      const event = deferred;
      if (event === null) return 'unavailable';

      // Cleared before awaiting, not after: the event cannot be used twice,
      // and a second tap while the first prompt is open would otherwise call
      // `prompt()` again on a spent event and throw.
      deferred = null;
      announce();

      await event.prompt();
      const { outcome } = await event.userChoice;
      // `appinstalled` is what marks it installed — the accepted outcome only
      // means the browser took the request.
      return outcome;
    },
  };
}

let shared: InstallController | null = null;

/**
 * The app's one controller. Created on first call, which main.tsx makes at
 * startup so that a `beforeinstallprompt` arriving before React mounts is
 * still caught.
 */
export function installController(): InstallController {
  shared ??= createInstallController(window as unknown as InstallHost);
  return shared;
}
