import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInstallController, type InstallHost } from '@/pwa/install';

/**
 * A window that fires what a browser fires, and nothing else. The real events
 * are not constructible in jsdom — `beforeinstallprompt` is not a standard
 * interface — so the fake carries the two members the controller uses.
 */
function createHost(options: { standalone?: boolean; iosStandalone?: boolean } = {}) {
  const listeners = new Map<string, ((event: Event) => void)[]>();

  const host: InstallHost = {
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) ?? []).filter((l) => l !== listener));
    },
    matchMedia: (query: string) => ({
      matches: query.includes('standalone') && options.standalone === true,
    }),
    navigator: { standalone: options.iosStandalone },
  };

  const emit = (type: string, event: Partial<Event>): void => {
    for (const listener of listeners.get(type) ?? []) listener(event as Event);
  };

  /** Stands in for the deferred prompt the browser hands over. */
  const beforeInstallPrompt = (outcome: 'accepted' | 'dismissed' = 'accepted') => {
    const event = {
      preventDefault: vi.fn(),
      prompt: vi.fn(async () => undefined),
      userChoice: Promise.resolve({ outcome }),
    };
    emit('beforeinstallprompt', event as unknown as Event);
    return event;
  };

  return { host, emit, beforeInstallPrompt };
}

describe('install availability', () => {
  it('is manual until the browser offers a prompt', () => {
    // iOS Safari never offers one, and neither does any browser before its own
    // engagement heuristic is met. Hiding would be dishonest either way.
    const { host } = createHost();
    expect(createInstallController(host).availability()).toBe('manual');
  });

  it('becomes promptable when the browser offers one', () => {
    const { host, beforeInstallPrompt } = createHost();
    const controller = createInstallController(host);
    beforeInstallPrompt();
    expect(controller.availability()).toBe('promptable');
  });

  it('is installed when running from the home screen', () => {
    const { host } = createHost({ standalone: true });
    expect(createInstallController(host).availability()).toBe('installed');
  });

  it('is installed when iOS says so through navigator.standalone', () => {
    // iOS answers this instead of implementing the display-mode media query.
    const { host } = createHost({ iosStandalone: true });
    expect(createInstallController(host).availability()).toBe('installed');
  });

  it('becomes installed when the install completes', () => {
    const { host, emit, beforeInstallPrompt } = createHost();
    const controller = createInstallController(host);
    beforeInstallPrompt();
    emit('appinstalled', {});
    expect(controller.availability()).toBe('installed');
  });
});

describe('the deferred prompt', () => {
  it('is prevented, or the browser consumes it and there is nothing to defer', () => {
    const { host, beforeInstallPrompt } = createHost();
    createInstallController(host);
    expect(beforeInstallPrompt().preventDefault).toHaveBeenCalled();
  });

  it('reports what the writer chose', async () => {
    const { host, beforeInstallPrompt } = createHost();
    const controller = createInstallController(host);
    beforeInstallPrompt('dismissed');
    await expect(controller.prompt()).resolves.toBe('dismissed');
  });

  it('is unavailable when nothing was offered', async () => {
    const { host } = createHost();
    await expect(createInstallController(host).prompt()).resolves.toBe('unavailable');
  });

  it('is spent after one use, and a second tap does not re-fire it', async () => {
    // A used event throws when prompted again; the guard is that `deferred` is
    // cleared before the await rather than after it.
    const { host, beforeInstallPrompt } = createHost();
    const controller = createInstallController(host);
    const event = beforeInstallPrompt();

    const first = controller.prompt();
    const second = controller.prompt();

    await expect(first).resolves.toBe('accepted');
    await expect(second).resolves.toBe('unavailable');
    expect(event.prompt).toHaveBeenCalledTimes(1);
    expect(controller.availability()).toBe('manual');
  });
});

describe('subscribers', () => {
  let controller: ReturnType<typeof createInstallController>;
  let host: ReturnType<typeof createHost>;

  beforeEach(() => {
    host = createHost();
    controller = createInstallController(host.host);
  });

  it('hear about an offer arriving', () => {
    const listener = vi.fn();
    controller.subscribe(listener);
    host.beforeInstallPrompt();
    expect(listener).toHaveBeenCalled();
  });

  it('hear about an install completing', () => {
    const listener = vi.fn();
    controller.subscribe(listener);
    host.emit('appinstalled', {});
    expect(listener).toHaveBeenCalled();
  });

  it('stop hearing once unsubscribed', () => {
    const listener = vi.fn();
    controller.subscribe(listener)();
    host.beforeInstallPrompt();
    expect(listener).not.toHaveBeenCalled();
  });
});
