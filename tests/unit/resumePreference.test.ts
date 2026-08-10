/**
 * The preference the resume strip learns (ADR-0023).
 *
 * The brief asked the strip to reorder itself by what gets picked most.
 * ADR-0023 refused, and kept the learning: it moved from *where the buttons
 * are* to *which one is the default*. These cover the floor before any
 * emphasis appears, the tie-break, and that the counts survive a relaunch.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EzhuthuDB } from '@/db/schema';
import {
  MIN_PICKS_FOR_DEFAULT,
  favouriteOf,
  loadPreference,
  recordPick,
  PICKS_KEY,
} from '@/features/resume/preference';

let db: EzhuthuDB;
let dbCounter = 0;

beforeEach(async () => {
  db = new EzhuthuDB(`ezhuthu-resume-pref-${dbCounter++}`);
  await db.open();
});

afterEach(async () => {
  db.close();
  await db.delete();
});

describe('learned preference', () => {
  it('emphasises nothing until the floor is cleared', async () => {
    for (let i = 0; i < MIN_PICKS_FOR_DEFAULT - 1; i++) {
      const preference = await recordPick(db, 'lastRead');
      expect(preference.favourite).toBeNull();
    }
    const preference = await recordPick(db, 'lastRead');
    expect(preference.total).toBe(MIN_PICKS_FOR_DEFAULT);
    expect(preference.favourite).toBe('lastRead');
  });

  it('counts survive a reload', async () => {
    for (let i = 0; i < 6; i++) await recordPick(db, 'mostRewritten');
    const loaded = await loadPreference(db);
    expect(loaded.counts.mostRewritten).toBe(6);
    expect(loaded.favourite).toBe('mostRewritten');
  });

  it('breaks a tie by the fixed order rather than by recency', async () => {
    // A dead heat that resolved by "most recent" would make the default
    // oscillate between launches — the instability ADR-0023 exists to avoid,
    // one level down.
    for (let i = 0; i < 3; i++) await recordPick(db, 'longestDwelled');
    for (let i = 0; i < 3; i++) await recordPick(db, 'lastEdited');
    expect((await loadPreference(db)).favourite).toBe('lastEdited');
  });

  it('reads a corrupted setting as no preference at all', async () => {
    // Persisted state a future version may have written differently. Losing the
    // counts costs an unemphasised strip; throwing here would cost the strip.
    await db.settings.put({ key: PICKS_KEY, value: { lastRead: 'lots', nonsense: 4 } });
    const loaded = await loadPreference(db);
    expect(loaded.counts).toEqual({});
    expect(loaded.favourite).toBeNull();
  });

  it('favouriteOf is pure and agrees with the stored path', () => {
    expect(favouriteOf({ lastEdited: 2, lastRead: 2 })).toBeNull();
    expect(favouriteOf({ lastEdited: 2, lastRead: 4 })).toBe('lastRead');
  });
});
