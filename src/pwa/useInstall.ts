import { useCallback, useSyncExternalStore } from 'react';
import { installController, type InstallAvailability, type InstallOutcome } from './install';

/**
 * React's view of the install controller. Kept separate so `install.ts` stays
 * free of React and can be tested against a fake window.
 *
 * `useSyncExternalStore` rather than an effect and state: the controller
 * exists before the component mounts (main.tsx creates it), so there is a
 * value to read on the first render and nothing to synchronise on mount.
 */
export function useInstall(): {
  availability: InstallAvailability;
  promptInstall: () => Promise<InstallOutcome>;
} {
  const controller = installController();

  const availability = useSyncExternalStore(
    useCallback((listener: () => void) => controller.subscribe(listener), [controller]),
    useCallback(() => controller.availability(), [controller]),
    // Server snapshot: never rendered on a server, but React wants it and
    // "not installed, no prompt" is the honest static answer.
    () => 'manual' as const,
  );

  return {
    availability,
    promptInstall: useCallback(() => controller.prompt(), [controller]),
  };
}
