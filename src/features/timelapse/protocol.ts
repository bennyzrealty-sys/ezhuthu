/**
 * The Worker protocol. Types only — shared by both sides of the boundary so a
 * change to one is a compile error on the other.
 */

import type { DocId } from '../../db/types';
import type { PastBlock, PastSummary } from './materialise';
import type { Timeline } from './timeline';

export type TimelapseRequest =
  | { kind: 'timeline'; id: number; docId: DocId }
  | { kind: 'materialise'; id: number; docId: DocId; targetSeq: number }
  | { kind: 'window'; id: number; docId: DocId; from: number; count: number };

export type TimelapseResponse =
  | { kind: 'timeline'; id: number; timeline: Timeline }
  | { kind: 'materialise'; id: number; summary: PastSummary }
  /**
   * `seq` is the state the window was taken from. The Worker holds ONE
   * materialised state, so a window that arrives after the scrub has moved on
   * describes a moment the panel is no longer showing — and rendering it puts
   * yesterday's paragraphs under today's date. The caller compares.
   */
  | { kind: 'window'; id: number; seq: number; from: number; blocks: PastBlock[] }
  | { kind: 'error'; id: number; message: string };

/**
 * The part of `Worker` this code uses.
 *
 * Narrow on purpose: the client is the piece with the coalescing logic worth
 * testing, and a real Worker in a unit test would mean bundling one.
 */
export interface WorkerLike {
  postMessage(message: TimelapseRequest): void;
  addEventListener(type: 'message', listener: (event: { data: TimelapseResponse }) => void): void;
  terminate(): void;
}
