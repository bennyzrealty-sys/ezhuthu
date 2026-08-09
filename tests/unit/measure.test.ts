import { describe, expect, it } from 'vitest';
import { HeightCache } from '@/render/measure';

describe('HeightCache', () => {
  it('stores and returns a measurement', () => {
    const cache = new HeightCache();
    cache.set('a', 390, 84);
    expect(cache.get('a', 390)).toBe(84);
  });

  it('misses for a different width', () => {
    const cache = new HeightCache();
    cache.set('a', 390, 84);
    expect(cache.get('a', 768)).toBeUndefined();
  });

  it('buckets sub-pixel widths together', () => {
    // A scrollbar appearing changes the width by a fraction. Without bucketing
    // that misses the cache on every block and triggers a full re-measure for
    // a difference no reader can see.
    const cache = new HeightCache();
    cache.set('a', 390.2, 84);
    expect(cache.get('a', 390.4)).toBe(84);
    expect(cache.get('a', 390)).toBe(84);
  });

  it('invalidates one block at every width', () => {
    const cache = new HeightCache();
    cache.set('a', 390, 84);
    cache.set('a', 768, 56);
    cache.set('b', 390, 84);

    cache.invalidate('a');

    expect(cache.get('a', 390)).toBeUndefined();
    expect(cache.get('a', 768)).toBeUndefined();
    expect(cache.get('b', 390)).toBe(84);
  });

  it('does not invalidate blocks whose id shares a prefix', () => {
    const cache = new HeightCache();
    cache.set('block-1', 390, 40);
    cache.set('block-10', 390, 50);
    cache.invalidate('block-1');
    expect(cache.get('block-1', 390)).toBeUndefined();
    expect(cache.get('block-10', 390)).toBe(50);
  });

  it('drops other widths on a width change', () => {
    // A phone realistically has two or three widths; unbounded retention is a
    // slow leak across a long session.
    const cache = new HeightCache();
    cache.set('a', 390, 84);
    cache.set('b', 390, 60);

    expect(cache.setWidth(768)).toBe(true);
    expect(cache.size).toBe(0);

    cache.set('a', 768, 56);
    expect(cache.setWidth(768)).toBe(false); // no change, no clearing
    expect(cache.get('a', 768)).toBe(56);
  });

  it('estimates taller for longer text and for narrower viewports', () => {
    const cache = new HeightCache();
    const short = cache.estimate(40, 390);
    const long = cache.estimate(400, 390);
    expect(long).toBeGreaterThan(short);
    expect(cache.estimate(400, 200)).toBeGreaterThan(cache.estimate(400, 800));
  });

  it('never estimates zero or negative height', () => {
    const cache = new HeightCache();
    for (const length of [0, 1, 10, 5_000]) {
      for (const width of [0, 1, 320, 1200]) {
        expect(cache.estimate(length, width)).toBeGreaterThan(0);
      }
    }
  });
});
