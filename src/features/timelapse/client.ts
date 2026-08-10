/**
 * The main-thread half of the replay Worker.
 *
 * Everything here exists because of one behaviour: a scrub is a drag, and a
 * drag produces positions far faster than a replay can answer them. Sent
 * naively, a two-second drag across a long log queues sixty replays, the
 * document lurches through sixty states the reader did not ask to see, and the
 * one they stopped on arrives last and slowest.
 *
 * So materialisation is COALESCED: at most one replay in flight and at most one
 * waiting, with the waiting one replaced by whatever the thumb has since moved
 * to. Positions passed through mid-drag are dropped, which is exactly what
 * "drop the frame" means everywhere else in the app. A dropped request resolves
 * to `null` rather than hanging or rejecting — being superseded is the normal
 * case, not a failure.
 */

import type { DocId } from '../../db/types';
import type { PastBlock, PastSummary } from './materialise';
import type { Timeline } from './timeline';
import type { TimelapseRequest, TimelapseResponse, WorkerLike } from './protocol';

export interface WindowResult {
  /** The state this window was taken from. Compare before rendering it. */
  seq: number;
  from: number;
  blocks: PastBlock[];
}

interface Waiting {
  resolve: (value: never) => void;
  reject: (error: Error) => void;
}

export class TimelapseClient {
  private nextId = 1;
  private readonly waiting = new Map<number, Waiting>();

  /** The id of the replay the Worker is busy with, if any. */
  private inFlight: number | null = null;
  /** The position the thumb has moved to since. At most one. */
  private queued: { docId: DocId; targetSeq: number; id: number } | null = null;

  private closed = false;

  constructor(private readonly worker: WorkerLike) {
    this.worker.addEventListener('message', (event) => {
      this.receive(event.data);
    });
  }

  timeline(docId: DocId): Promise<Timeline> {
    return this.send<Timeline>({ kind: 'timeline', id: this.nextId++, docId });
  }

  /**
   * Materialise the document at `targetSeq`.
   *
   * Resolves to `null` when a later position superseded this one before the
   * Worker got to it.
   */
  materialise(docId: DocId, targetSeq: number): Promise<PastSummary | null> {
    const id = this.nextId++;
    const request: TimelapseRequest = { kind: 'materialise', id, docId, targetSeq };

    const promise = new Promise<PastSummary | null>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (value: never) => void, reject });
    });

    if (this.inFlight === null) {
      this.inFlight = id;
      this.worker.postMessage(request);
    } else {
      // Whatever was waiting is now a position the thumb has passed.
      this.supersedeQueued();
      this.queued = { docId, targetSeq, id };
    }

    return promise;
  }

  window(docId: DocId, from: number, count: number): Promise<WindowResult> {
    return this.send<WindowResult>({ kind: 'window', id: this.nextId++, docId, from, count });
  }

  /** True while a replay is running or waiting — what the panel shows a spinner for. */
  get busy(): boolean {
    return this.inFlight !== null || this.queued !== null;
  }

  close(): void {
    this.closed = true;
    this.supersedeQueued();
    for (const [, waiter] of this.waiting) waiter.resolve(null as never);
    this.waiting.clear();
    this.inFlight = null;
    this.worker.terminate();
  }

  private send<T>(request: TimelapseRequest): Promise<T> {
    const promise = new Promise<T>((resolve, reject) => {
      this.waiting.set(request.id, { resolve: resolve as (value: never) => void, reject });
    });
    this.worker.postMessage(request);
    return promise;
  }

  private supersedeQueued(): void {
    if (this.queued === null) return;
    this.waiting.get(this.queued.id)?.resolve(null as never);
    this.waiting.delete(this.queued.id);
    this.queued = null;
  }

  private receive(response: TimelapseResponse): void {
    const waiter = this.waiting.get(response.id);
    this.waiting.delete(response.id);

    if (response.id === this.inFlight) {
      this.inFlight = null;
      const next = this.queued;
      this.queued = null;
      if (next !== null && !this.closed) {
        this.inFlight = next.id;
        this.worker.postMessage({
          kind: 'materialise',
          id: next.id,
          docId: next.docId,
          targetSeq: next.targetSeq,
        });
      }
    }

    if (waiter === undefined) return;

    switch (response.kind) {
      case 'timeline':
        waiter.resolve(response.timeline as never);
        break;
      case 'materialise':
        waiter.resolve(response.summary as never);
        break;
      case 'window':
        waiter.resolve({
          seq: response.seq,
          from: response.from,
          blocks: response.blocks,
        } as never);
        break;
      case 'error':
        waiter.reject(new Error(response.message));
        break;
    }
  }
}

/**
 * Start the Worker.
 *
 * Separate from the client so tests can drive the client with a stub. `new
 * URL(..., import.meta.url)` is what makes the bundler emit the Worker as its
 * own chunk rather than inlining it into the main bundle.
 */
export function createReplayWorker(): WorkerLike {
  return new Worker(new URL('./replay.worker.ts', import.meta.url), {
    type: 'module',
    name: 'ezhuthu-replay',
  }) as unknown as WorkerLike;
}
