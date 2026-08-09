/**
 * Ordering. Two separate concerns, both easy to get wrong:
 *
 *  1. Block order — fractional indexing over lexicographic string keys so an
 *     insert between two blocks touches ONE record (ADR-0007).
 *  2. Event order — (seq, deviceId), never `ts`, never `seq` alone (ADR-0020).
 *
 * Pure. No Dexie, no DOM.
 */

import type { BlockEvent, OrderKey } from '../db/types';

// ---------------------------------------------------------------------------
// Event order
// ---------------------------------------------------------------------------

/**
 * THE comparator for event order. Every sort of events goes through this.
 *
 * `ts` is deliberately not consulted: wall clocks move backwards (NTP
 * correction, DST, manual change), so ordering by time can interleave events
 * incorrectly and make replay non-deterministic. `deviceId` breaks ties so
 * that if two devices' logs are ever merged the result has a deterministic
 * total order rather than an arbitrary one (ADR-0020).
 */
export function compareEvents(a: BlockEvent, b: BlockEvent): number {
  if (a.seq !== b.seq) return a.seq - b.seq;
  return a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Block order — fractional indexing
// ---------------------------------------------------------------------------

/**
 * Base-62 digits in ASCII order: 0-9 (48-57) < A-Z (65-90) < a-z (97-122).
 * Because the alphabet is ASCII-ascending with no gaps used, plain string
 * comparison on keys equals numeric comparison of the fractions they encode.
 */
export const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * A key is `<integer part><fractional part>`.
 *
 * The integer part's first character encodes its own length, which is what
 * lets keys stay short when appending repeatedly at the end of a document —
 * the dominant case when writing prose. Without it, sequential appends grow
 * the key by a character every few inserts, and 2,000 paragraphs would
 * produce 300-character keys.
 *
 *   'a'..'z' → length 2..27   (integers >= 0, growing upward)
 *   'Z'..'A' → length 2..27   (integers < 0, growing downward)
 */
function getIntegerLength(head: string): number {
  if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 97 + 2;
  if (head >= 'A' && head <= 'Z') return 90 - head.charCodeAt(0) + 2;
  throw new Error(`invalid order key head: ${head}`);
}

function getIntegerPart(key: string): string {
  const len = getIntegerLength(key.charAt(0));
  if (len > key.length) throw new Error(`invalid order key: ${key}`);
  return key.slice(0, len);
}

function validateInteger(int: string): void {
  if (int.length !== getIntegerLength(int.charAt(0))) {
    throw new Error(`invalid integer part of order key: ${int}`);
  }
}

/**
 * Keys must never end in the zero digit. Otherwise "1" and "10" encode the
 * same fraction but compare differently, and lexicographic order stops
 * matching numeric order — which is the entire premise.
 */
export function validateOrderKey(key: string, digits = BASE62): void {
  if (key === 'A' + digits[0]!.repeat(26)) throw new Error(`invalid order key: ${key}`);
  const i = getIntegerPart(key);
  const f = key.slice(i.length);
  if (f.slice(-1) === digits[0]) throw new Error(`invalid order key: ${key}`);
}

function incrementInteger(x: string, digits: string): string | null {
  validateInteger(x);
  const [head, ...digs] = x.split('') as [string, ...string[]];
  let carry = true;
  for (let i = digs.length - 1; carry && i >= 0; i--) {
    const d = digits.indexOf(digs[i]!) + 1;
    if (d === digits.length) {
      digs[i] = digits[0]!;
    } else {
      digs[i] = digits[d]!;
      carry = false;
    }
  }
  if (!carry) return head + digs.join('');
  if (head === 'Z') return 'a' + digits[0];
  if (head === 'z') return null;
  const h = String.fromCharCode(head.charCodeAt(0) + 1);
  if (h > 'a') digs.push(digits[0]!);
  else digs.pop();
  return h + digs.join('');
}

function decrementInteger(x: string, digits: string): string | null {
  validateInteger(x);
  const [head, ...digs] = x.split('') as [string, ...string[]];
  let borrow = true;
  for (let i = digs.length - 1; borrow && i >= 0; i--) {
    const d = digits.indexOf(digs[i]!) - 1;
    if (d === -1) {
      digs[i] = digits.slice(-1);
    } else {
      digs[i] = digits[d]!;
      borrow = false;
    }
  }
  if (!borrow) return head + digs.join('');
  if (head === 'a') return 'Z' + digits.slice(-1);
  if (head === 'A') return null;
  const h = String.fromCharCode(head.charCodeAt(0) - 1);
  if (h < 'Z') digs.push(digits.slice(-1));
  else digs.pop();
  return h + digs.join('');
}

/**
 * A string strictly between the fractions `a` and `b`, where "" means 0 and
 * `undefined` for `b` means 1. Both arguments are fractional parts only.
 */
function midpoint(a: string, b: string | undefined, digits: string): string {
  const zero = digits[0]!;
  if (b !== undefined && a >= b) throw new Error(`${a} >= ${b}`);
  if (a.slice(-1) === zero || (b && b.slice(-1) === zero)) {
    throw new Error('trailing zero in fractional part');
  }
  if (b !== undefined) {
    // Strip the common prefix and recurse on what differs.
    let n = 0;
    while ((a[n] ?? zero) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n), digits);
  }
  const digitA = a ? digits.indexOf(a[0]!) : 0;
  const digitB = b !== undefined ? digits.indexOf(b[0]!) : digits.length;
  if (digitB - digitA > 1) {
    return digits[Math.round(0.5 * (digitA + digitB))]!;
  }
  // Adjacent digits: there is no room at this position, so go one deeper.
  if (b !== undefined && b.length > 1) return b.slice(0, 1);
  return digits[digitA]! + midpoint(a.slice(1), undefined, digits);
}

/**
 * Generate an order key strictly between `a` and `b`.
 *
 * `null` means unbounded on that side: `generateKeyBetween(null, null)` is the
 * first key in an empty document, `generateKeyBetween(last, null)` appends.
 *
 * Inserting between two existing blocks writes exactly one record — no
 * renumbering, at any position, at any document size.
 */
export function generateKeyBetween(
  a: OrderKey | null,
  b: OrderKey | null,
  digits = BASE62,
): OrderKey {
  if (a !== null) validateOrderKey(a, digits);
  if (b !== null) validateOrderKey(b, digits);
  if (a !== null && b !== null && a >= b) throw new Error(`${a} >= ${b}`);

  if (a === null) {
    if (b === null) return 'a' + digits[0];
    const ib = getIntegerPart(b);
    const fb = b.slice(ib.length);
    if (ib === 'A' + digits[0]!.repeat(26)) return ib + midpoint('', fb, digits);
    if (ib < b) return ib;
    const res = decrementInteger(ib, digits);
    if (res === null) throw new Error('cannot decrement any more');
    return res;
  }

  if (b === null) {
    const ia = getIntegerPart(a);
    const fa = a.slice(ia.length);
    const i = incrementInteger(ia, digits);
    return i === null ? ia + midpoint(fa, undefined, digits) : i;
  }

  const ia = getIntegerPart(a);
  const fa = a.slice(ia.length);
  const ib = getIntegerPart(b);
  const fb = b.slice(ib.length);
  if (ia === ib) return ia + midpoint(fa, fb, digits);
  const i = incrementInteger(ia, digits);
  if (i === null) throw new Error('cannot increment any more');
  if (i < b) return i;
  return ia + midpoint(fa, undefined, digits);
}

/**
 * `n` evenly-distributed keys between `a` and `b`. Used by import, which
 * creates thousands of blocks at once and would otherwise chain
 * generateKeyBetween calls into needlessly long keys.
 */
export function generateNKeysBetween(
  a: OrderKey | null,
  b: OrderKey | null,
  n: number,
  digits = BASE62,
): OrderKey[] {
  if (n === 0) return [];
  if (n === 1) return [generateKeyBetween(a, b, digits)];

  if (b === null) {
    let c = generateKeyBetween(a, b, digits);
    const result = [c];
    for (let i = 0; i < n - 1; i++) {
      c = generateKeyBetween(c, b, digits);
      result.push(c);
    }
    return result;
  }
  if (a === null) {
    let c = generateKeyBetween(a, b, digits);
    const result = [c];
    for (let i = 0; i < n - 1; i++) {
      c = generateKeyBetween(a, c, digits);
      result.push(c);
    }
    return result.reverse();
  }

  const mid = Math.floor(n / 2);
  const c = generateKeyBetween(a, b, digits);
  return [
    ...generateNKeysBetween(a, c, mid, digits),
    c,
    ...generateNKeysBetween(c, b, n - mid - 1, digits),
  ];
}

/** Lexicographic. Never compare order keys numerically. */
export function compareOrder(a: OrderKey, b: OrderKey): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
