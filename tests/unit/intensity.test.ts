/**
 * Edit intensity — the value behind the margin bar (ADR-0005) and minimap
 * shading (ADR-0021). Pure, so these drive it directly with an injected clock;
 * there is no database and no DOM in reach.
 */

import { describe, expect, it } from 'vitest';
import {
  intensityScore,
  markIntensity,
  recencyOpacity,
  revisionSaturation,
  SATURATION_HALF_AT,
} from '@/features/visibility/intensity';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const T0 = 1_700_000_000_000;

describe('recency opacity (ADR-0006 bands)', () => {
  it('steps down through the bands and reaches a clean slate', () => {
    expect(recencyOpacity(0)).toBe(1);
    expect(recencyOpacity(HOUR - 1)).toBe(1);
    expect(recencyOpacity(HOUR)).toBe(0.6);
    expect(recencyOpacity(DAY - 1)).toBe(0.6);
    expect(recencyOpacity(DAY)).toBe(0.25);
    expect(recencyOpacity(WEEK - 1)).toBe(0.25);
    expect(recencyOpacity(WEEK)).toBe(0);
    expect(recencyOpacity(30 * DAY)).toBe(0);
  });

  it('treats a negative age — a clock that ran backwards — as freshest', () => {
    // Rounding a bar too bright is a smaller error than one that vanishes.
    expect(recencyOpacity(-HOUR)).toBe(1);
  });
});

describe('revision saturation (ADR-0005)', () => {
  it('is zero at zero revisions and one half at the half point', () => {
    expect(revisionSaturation(0)).toBe(0);
    expect(revisionSaturation(SATURATION_HALF_AT)).toBeCloseTo(0.5, 10);
  });

  it('rises monotonically and never reaches one', () => {
    let previous = -1;
    for (const count of [1, 2, 4, 8, 16, 40, 200]) {
      const value = revisionSaturation(count);
      expect(value).toBeGreaterThan(previous);
      expect(value).toBeLessThan(1);
      previous = value;
    }
  });

  it('still separates a fought-over paragraph from a lightly-edited one', () => {
    // ADR-0012 notes forty revisions is ordinary for one fought over; it must
    // not read the same as eight.
    expect(revisionSaturation(40)).toBeGreaterThan(revisionSaturation(8) + 0.1);
  });
});

describe('markIntensity', () => {
  it('draws nothing for a block that has never been revised', () => {
    // The import case (ADR-0027): every block is "updated" at import time, and
    // none of them is an edit. A bar here would light the whole document.
    expect(markIntensity({ updatedAt: T0, revisionCount: 0 }, T0 + 1)).toBeNull();
  });

  it('draws nothing once the last edit has decayed past a week', () => {
    expect(markIntensity({ updatedAt: T0, revisionCount: 5 }, T0 + WEEK)).toBeNull();
  });

  it('carries recency in opacity and revision count in saturation', () => {
    const mark = markIntensity({ updatedAt: T0, revisionCount: SATURATION_HALF_AT }, T0 + 2 * HOUR);
    expect(mark).not.toBeNull();
    expect(mark!.opacity).toBe(0.6); // < 1 day
    expect(mark!.saturation).toBeCloseTo(0.5, 10);
  });
});

describe('intensityScore', () => {
  it('is zero for an absent mark', () => {
    expect(intensityScore(null)).toBe(0);
  });

  it('lets a recent light edit outrank an old heavy one', () => {
    // The minimap answers "is there anything recent I should look at", so a
    // just-now single revision must beat a week-old fought-over paragraph.
    const recentLight = markIntensity({ updatedAt: T0, revisionCount: 1 }, T0 + 1);
    const oldHeavy = markIntensity({ updatedAt: T0, revisionCount: 40 }, T0 + 6 * DAY);
    expect(intensityScore(recentLight)).toBeGreaterThan(intensityScore(oldHeavy));
  });

  it('breaks a recency tie by revision depth', () => {
    const once = markIntensity({ updatedAt: T0, revisionCount: 1 }, T0 + 1);
    const many = markIntensity({ updatedAt: T0, revisionCount: 20 }, T0 + 1);
    expect(intensityScore(many)).toBeGreaterThan(intensityScore(once));
  });
});
