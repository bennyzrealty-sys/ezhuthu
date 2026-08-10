/**
 * Scroll-past-an-edit feedback (ADR-0022): a haptic tick, and/or a visual pulse
 * on the margin bar, as the writer scrolls an edited region through the centre
 * of the viewport.
 *
 * The honest part is the platform split. `navigator.vibrate` **does not exist**
 * on iOS Safari — not degraded, absent — and there is no Web API that produces
 * haptics there. So haptics are feature-detected, throttled, and off by default;
 * where the API is missing the setting says so rather than silently doing
 * nothing. The visual pulse is offered as a separate, cross-platform setting —
 * not a claimed substitute for haptics, which it is not.
 *
 * The decision of *when* to pulse is pure and here, so it can be tested without
 * a scroller: one pulse per edited region entered, never more than one per
 * `PULSE_THROTTLE_MS`.
 */

import type { EzhuthuDB } from '../../db/schema';

/** ADR-0022: at most one pulse per 300 ms. Unthrottled vibration during a fling
 * is unpleasant and drains the battery. */
export const PULSE_THROTTLE_MS = 300;

/** The tick itself — short enough to read as a tick, not a buzz. */
export const HAPTIC_MS = 8;

/** How long the margin-bar visual pulse lasts. */
export const VISUAL_PULSE_MS = 320;

/** Whether this device can produce haptics at all (Android yes, iOS Safari no). */
export function hapticsSupported(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
}

/** Fire a haptic tick if the platform has the API. A no-op where it does not. */
export function haptic(): void {
  if (hapticsSupported()) navigator.vibrate(HAPTIC_MS);
}

export interface FeedbackSettings {
  haptics: boolean;
  visualPulse: boolean;
}

/** Off by default (ADR-0022): feedback while scrolling is opt-in. */
export const DEFAULT_FEEDBACK: FeedbackSettings = { haptics: false, visualPulse: false };

export const FEEDBACK_KEY = 'visibility.feedback';

function parse(value: unknown): FeedbackSettings {
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_FEEDBACK };
  const record = value as Record<string, unknown>;
  return {
    haptics: record.haptics === true,
    visualPulse: record.visualPulse === true,
  };
}

export async function loadFeedback(db: EzhuthuDB): Promise<FeedbackSettings> {
  return parse((await db.settings.get(FEEDBACK_KEY))?.value);
}

export async function saveFeedback(db: EzhuthuDB, settings: FeedbackSettings): Promise<void> {
  await db.settings.put({ key: FEEDBACK_KEY, value: settings });
}

/**
 * Decides when a scroll should produce a pulse. Fed the edited block nearest the
 * viewport centre on each scroll sample (or `undefined` when the centre is not
 * an edited block), it fires once per region entered and no more than once per
 * throttle window. Pure — `now` is a parameter.
 */
export class EditedRegionPulse {
  private lastAt = -Infinity;
  private lastBlockId: string | undefined;

  constructor(private readonly throttleMs: number = PULSE_THROTTLE_MS) {}

  shouldPulse(centreEditedBlockId: string | undefined, now: number): boolean {
    if (centreEditedBlockId === undefined) {
      // Left the edited region; re-entering it later is a fresh pulse.
      this.lastBlockId = undefined;
      return false;
    }
    if (centreEditedBlockId === this.lastBlockId) return false;

    // Mark the region seen even when throttled, so a region skipped past during
    // a fling does not pulse late once the window reopens.
    this.lastBlockId = centreEditedBlockId;
    if (now - this.lastAt < this.throttleMs) return false;

    this.lastAt = now;
    return true;
  }
}
