/**
 * Identity: event ids, block ids, and the stable device / session identifiers
 * that appear on every event.
 */

const DEVICE_ID_KEY = 'ezhuthu.deviceId';

export function uuid(): string {
  const c: Crypto = crypto;
  if (typeof c.randomUUID === 'function') return c.randomUUID();

  // Older WebKit. Still cryptographically random, just assembled by hand.
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0'));
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-');
}

/**
 * Stable per browser install. Part of the event sort key (ADR-0020).
 *
 * This is the one legitimate use of localStorage in the project (ADR-0002): a
 * few bytes of identity we would not mind regenerating. Losing it costs
 * nothing — a new deviceId still sorts deterministically.
 */
export function getDeviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing) return existing;
    const fresh = uuid();
    localStorage.setItem(DEVICE_ID_KEY, fresh);
    return fresh;
  } catch {
    // Private mode with storage disabled. Ephemeral id is fine.
    return uuid();
  }
}

/** One app launch. Used by corpus session-coalescing (ADR-0012) and signals. */
const SESSION_ID = uuid();

export function getSessionId(): string {
  return SESSION_ID;
}
