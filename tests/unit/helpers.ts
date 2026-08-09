import type { BlockEvent, BlockEventType, DocId } from '@/db/types';

/**
 * Deterministic PRNG. Randomised property tests are worthless if a failure
 * cannot be reproduced — seeds are printed on failure so a case can be replayed.
 */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

export interface EventFactoryOptions {
  docId?: DocId;
  deviceId?: string;
  sessionId?: string;
}

/** Builds well-formed events with monotonic seq, so tests state only what matters. */
export function eventFactory(opts: EventFactoryOptions = {}) {
  const docId = opts.docId ?? 'doc-1';
  const deviceId = opts.deviceId ?? 'dev-1';
  const sessionId = opts.sessionId ?? 'ses-1';
  let seq = 1;
  let ts = 1_700_000_000_000;

  return {
    get nextSeq() {
      return seq;
    },
    make(
      type: BlockEventType,
      blockId: string,
      payload: BlockEvent['payload'] = {},
      overrides: Partial<BlockEvent> = {},
    ): BlockEvent {
      const event: BlockEvent = {
        id: `ev-${seq}`,
        seq: seq++,
        ts: (ts += 1000),
        sessionId,
        deviceId,
        docId,
        blockId,
        type,
        payload,
        ...overrides,
      };
      return event;
    },
  };
}

/** Malayalam sample text for tests that need realistic shaping, not ASCII. */
export const ML_SAMPLES = [
  'കടൽ ശാന്തമായിരുന്നു.',
  'അവൻ ഒരു software engineer ആണ്.',
  'വർഷം തോറും മഴ പെയ്യുന്നു.',
  'സ്ത്രീകൾ ന്യായം ചോദിച്ചു.',
  'ഗ്ദ്ധ എന്ന കൂട്ടക്ഷരം.',
] as const;
