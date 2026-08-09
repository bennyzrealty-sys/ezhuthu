import { describe, expect, it } from 'vitest';
import {
  BASE62,
  compareEvents,
  compareOrder,
  generateKeyBetween,
  generateNKeysBetween,
  validateOrderKey,
} from '@/core/order';
import type { BlockEvent } from '@/db/types';
import { makeRng } from './helpers';

describe('event order', () => {
  const ev = (seq: number, deviceId: string, ts: number): BlockEvent => ({
    id: `${seq}-${deviceId}`,
    seq,
    ts,
    sessionId: 's',
    deviceId,
    docId: 'd',
    blockId: 'b',
    type: 'update',
    payload: {},
  });

  it('orders by seq', () => {
    expect(compareEvents(ev(1, 'a', 100), ev(2, 'a', 100))).toBeLessThan(0);
  });

  it('breaks ties on deviceId so the total order is deterministic', () => {
    expect(compareEvents(ev(5, 'aaa', 1), ev(5, 'bbb', 1))).toBeLessThan(0);
    expect(compareEvents(ev(5, 'bbb', 1), ev(5, 'aaa', 1))).toBeGreaterThan(0);
    expect(compareEvents(ev(5, 'aaa', 1), ev(5, 'aaa', 1))).toBe(0);
  });

  it('ignores ts entirely — wall clocks move backwards', () => {
    // Event 2 carries an EARLIER timestamp than event 1, which happens after
    // an NTP correction or a DST change. Order must still follow seq.
    expect(compareEvents(ev(1, 'a', 9_999), ev(2, 'a', 1))).toBeLessThan(0);
  });
});

describe('generateKeyBetween', () => {
  it('returns a valid first key for an empty document', () => {
    const k = generateKeyBetween(null, null);
    expect(k).toBe('a0');
    expect(() => validateOrderKey(k)).not.toThrow();
  });

  it('appends strictly after', () => {
    let k = generateKeyBetween(null, null);
    for (let i = 0; i < 100; i++) {
      const next = generateKeyBetween(k, null);
      expect(compareOrder(k, next)).toBeLessThan(0);
      k = next;
    }
  });

  it('keeps keys short when appending repeatedly', () => {
    // The integer-part scheme exists for exactly this: writing a document is
    // 2,000 sequential appends, and without it keys would grow without bound.
    let k = generateKeyBetween(null, null);
    for (let i = 0; i < 2000; i++) k = generateKeyBetween(k, null);
    expect(k.length).toBeLessThanOrEqual(5);
  });

  it('prepends strictly before, unboundedly', () => {
    let k = generateKeyBetween(null, null);
    for (let i = 0; i < 200; i++) {
      const next = generateKeyBetween(null, k);
      expect(compareOrder(next, k)).toBeLessThan(0);
      k = next;
    }
  });

  it('always lands strictly between its neighbours', () => {
    let lo = generateKeyBetween(null, null);
    let hi = generateKeyBetween(lo, null);
    for (let i = 0; i < 500; i++) {
      const mid = generateKeyBetween(lo, hi);
      expect(compareOrder(lo, mid)).toBeLessThan(0);
      expect(compareOrder(mid, hi)).toBeLessThan(0);
      expect(() => validateOrderKey(mid)).not.toThrow();
      // Alternate which side we squeeze, so both branches get exercised.
      if (i % 2 === 0) lo = mid;
      else hi = mid;
    }
  });

  it('rejects reversed bounds', () => {
    const a = generateKeyBetween(null, null);
    const b = generateKeyBetween(a, null);
    expect(() => generateKeyBetween(b, a)).toThrow();
    expect(() => generateKeyBetween(a, a)).toThrow();
  });

  it('rejects malformed keys', () => {
    expect(() => validateOrderKey('')).toThrow();
    expect(() => validateOrderKey('0')).toThrow();
    expect(() => validateOrderKey('a')).toThrow();
    expect(() => validateOrderKey('a00')).toThrow(); // trailing zero
    expect(() => validateOrderKey('!!')).toThrow();
  });

  it('never emits a fractional part ending in the zero digit', () => {
    // Otherwise "a1" and "a10" encode the same fraction but compare
    // differently, and lexicographic order stops matching numeric order.
    //
    // Note the INTEGER part may end in zero — "a0" is the first key ever
    // issued. The invariant is on the fraction, which validateOrderKey checks.
    const keys = [
      ...generateNKeysBetween(null, null, 200),
      ...generateNKeysBetween('a0', 'a1', 50),
    ];
    for (const k of keys) expect(() => validateOrderKey(k)).not.toThrow();

    // And validateOrderKey really does reject one, so the assertion above has
    // teeth rather than passing vacuously.
    expect(() => validateOrderKey(`a1${BASE62[0]!}`)).toThrow();
  });

  it('survives randomised interleaved insertion', () => {
    const rng = makeRng(20260809);
    const keys = [generateKeyBetween(null, null)];

    for (let i = 0; i < 800; i++) {
      const at = Math.floor(rng() * (keys.length + 1));
      const before = at === 0 ? null : keys[at - 1]!;
      const after = at === keys.length ? null : keys[at]!;
      const fresh = generateKeyBetween(before, after);
      keys.splice(at, 0, fresh);
    }

    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual(keys);
  });
});

describe('generateNKeysBetween', () => {
  it('returns n sorted keys strictly between the bounds', () => {
    const a = generateKeyBetween(null, null);
    const b = generateKeyBetween(a, null);
    const keys = generateNKeysBetween(a, b, 50);

    expect(keys).toHaveLength(50);
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(50);
    expect(compareOrder(a, keys[0]!)).toBeLessThan(0);
    expect(compareOrder(keys.at(-1)!, b)).toBeLessThan(0);
  });

  it('handles both open bounds — the bulk import case', () => {
    const keys = generateNKeysBetween(null, null, 2000);
    expect(keys).toHaveLength(2000);
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(2000);
  });

  it('returns nothing for n = 0', () => {
    expect(generateNKeysBetween(null, null, 0)).toEqual([]);
  });
});
