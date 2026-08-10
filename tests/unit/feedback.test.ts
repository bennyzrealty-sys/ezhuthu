/**
 * The pure half of scroll-past feedback (ADR-0022): when to pulse. The haptic
 * and visual effects themselves are thin wrappers; this is the logic worth
 * testing, and it needs no scroller.
 */

import { describe, expect, it } from 'vitest';
import { EditedRegionPulse, PULSE_THROTTLE_MS } from '@/features/visibility/feedback';

describe('EditedRegionPulse', () => {
  it('pulses once when an edited region reaches the centre', () => {
    const pulse = new EditedRegionPulse();
    expect(pulse.shouldPulse('a', 0)).toBe(true);
    // Still on the same region: no repeat, however many samples pass.
    expect(pulse.shouldPulse('a', 100)).toBe(false);
    expect(pulse.shouldPulse('a', 5000)).toBe(false);
  });

  it('does not pulse for a stretch of unedited blocks', () => {
    const pulse = new EditedRegionPulse();
    expect(pulse.shouldPulse(undefined, 0)).toBe(false);
    expect(pulse.shouldPulse(undefined, 1000)).toBe(false);
  });

  it('honours the throttle across two regions crossed quickly', () => {
    const pulse = new EditedRegionPulse();
    expect(pulse.shouldPulse('a', 0)).toBe(true);
    // 'b' arrives inside the throttle window — a fling past both. No second pulse,
    // and it does not fire late once the window reopens on the same region.
    expect(pulse.shouldPulse('b', 100)).toBe(false);
    expect(pulse.shouldPulse('b', 100 + PULSE_THROTTLE_MS + 1)).toBe(false);
  });

  it('pulses again for a region entered after the window and a gap', () => {
    const pulse = new EditedRegionPulse();
    expect(pulse.shouldPulse('a', 0)).toBe(true);
    expect(pulse.shouldPulse('b', PULSE_THROTTLE_MS + 1)).toBe(true);
  });

  it('re-pulses a region left and returned to', () => {
    const pulse = new EditedRegionPulse();
    expect(pulse.shouldPulse('a', 0)).toBe(true);
    expect(pulse.shouldPulse(undefined, 400)).toBe(false); // left it
    expect(pulse.shouldPulse('a', 800)).toBe(true); // came back
  });
});
