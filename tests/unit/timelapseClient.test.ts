import { describe, expect, it } from 'vitest';
import { TimelapseClient } from '@/features/timelapse/client';
import type { TimelapseRequest, TimelapseResponse, WorkerLike } from '@/features/timelapse/protocol';

const DOC = 'doc-1';

/**
 * A Worker that answers only when told to, so a test can hold a replay open
 * while the thumb keeps moving — which is the whole situation the coalescing
 * exists for.
 */
class StubWorker implements WorkerLike {
  readonly sent: TimelapseRequest[] = [];
  terminated = false;
  private listener: ((event: { data: TimelapseResponse }) => void) | null = null;

  postMessage(message: TimelapseRequest): void {
    this.sent.push(message);
  }

  addEventListener(_type: 'message', listener: (event: { data: TimelapseResponse }) => void): void {
    this.listener = listener;
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Answer the oldest unanswered request of this kind. */
  reply(response: TimelapseResponse): void {
    this.listener?.({ data: response });
  }

  answerMaterialise(id: number, seq = id): void {
    this.reply({ kind: 'materialise', id, summary: { seq, blockCount: 1, wordCount: 1 } });
  }
}

const materialiseRequests = (worker: StubWorker) => worker.sent.filter((r) => r.kind === 'materialise');

describe('coalescing a drag', () => {
  it('sends the first position immediately', async () => {
    const worker = new StubWorker();
    const client = new TimelapseClient(worker);

    const first = client.materialise(DOC, 100);
    expect(materialiseRequests(worker)).toHaveLength(1);

    worker.answerMaterialise(materialiseRequests(worker)[0]!.id, 100);
    expect(await first).toMatchObject({ seq: 100 });
  });

  it('holds one position back while a replay is running', async () => {
    const worker = new StubWorker();
    const client = new TimelapseClient(worker);

    void client.materialise(DOC, 100);
    const second = client.materialise(DOC, 200);

    // Nothing extra reaches the Worker until the first replay is done.
    expect(materialiseRequests(worker)).toHaveLength(1);
    expect(client.busy).toBe(true);

    worker.answerMaterialise(materialiseRequests(worker)[0]!.id, 100);
    expect(materialiseRequests(worker)).toHaveLength(2);
    expect(materialiseRequests(worker)[1]).toMatchObject({ targetSeq: 200 });

    worker.answerMaterialise(materialiseRequests(worker)[1]!.id, 200);
    expect(await second).toMatchObject({ seq: 200 });
  });

  it('drops the positions the thumb passed over', async () => {
    const worker = new StubWorker();
    const client = new TimelapseClient(worker);

    void client.materialise(DOC, 100);
    const passed = [200, 300, 400, 500].map((seq) => client.materialise(DOC, seq));

    // One in flight, one waiting, four intermediate positions dropped.
    expect(materialiseRequests(worker)).toHaveLength(1);
    expect(await Promise.all(passed.slice(0, 3))).toEqual([null, null, null]);

    worker.answerMaterialise(materialiseRequests(worker)[0]!.id, 100);
    expect(materialiseRequests(worker)[1]).toMatchObject({ targetSeq: 500 });

    worker.answerMaterialise(materialiseRequests(worker)[1]!.id, 500);
    expect(await passed[3]).toMatchObject({ seq: 500 });
  });

  it('is idle once the last position has been answered', async () => {
    const worker = new StubWorker();
    const client = new TimelapseClient(worker);

    const only = client.materialise(DOC, 42);
    worker.answerMaterialise(materialiseRequests(worker)[0]!.id, 42);
    await only;

    expect(client.busy).toBe(false);
  });
});

describe('the other requests', () => {
  it('does not queue a timeline behind a replay', async () => {
    const worker = new StubWorker();
    const client = new TimelapseClient(worker);

    void client.materialise(DOC, 100);
    const timeline = client.timeline(DOC);

    // Only materialisation is coalesced; the timeline is asked for once.
    expect(worker.sent).toHaveLength(2);

    const request = worker.sent.find((r) => r.kind === 'timeline')!;
    worker.reply({
      kind: 'timeline',
      id: request.id,
      timeline: { stops: [], sessions: 0, headSeq: 0 },
    });
    expect(await timeline).toEqual({ stops: [], sessions: 0, headSeq: 0 });
  });

  it('says which state a window came from', async () => {
    const worker = new StubWorker();
    const client = new TimelapseClient(worker);

    const window = client.window(DOC, 10, 5);
    const request = worker.sent.at(-1)!;
    worker.reply({
      kind: 'window',
      id: request.id,
      seq: 700,
      from: 10,
      blocks: [{ blockId: 'b', text: 'കടൽ' }],
    });

    // The Worker holds one state; a window that lands after the scrub moved on
    // would otherwise put yesterday's paragraphs under today's date.
    expect(await window).toEqual({ seq: 700, from: 10, blocks: [{ blockId: 'b', text: 'കടൽ' }] });
  });

  it('surfaces a failure rather than hanging', async () => {
    const worker = new StubWorker();
    const client = new TimelapseClient(worker);

    const materialised = client.materialise(DOC, 100);
    worker.reply({ kind: 'error', id: worker.sent.at(-1)!.id, message: 'corrupt log' });

    await expect(materialised).rejects.toThrow('corrupt log');
    // ...and the failure does not leave the client permanently busy.
    expect(client.busy).toBe(false);
  });
});

describe('closing', () => {
  it('terminates the worker and settles everything outstanding', async () => {
    const worker = new StubWorker();
    const client = new TimelapseClient(worker);

    const first = client.materialise(DOC, 100);
    const second = client.materialise(DOC, 200);
    client.close();

    expect(worker.terminated).toBe(true);
    // Closing the panel mid-drag must not leave a promise nobody will settle.
    expect(await first).toBeNull();
    expect(await second).toBeNull();
  });

  it('sends nothing more after closing', () => {
    const worker = new StubWorker();
    const client = new TimelapseClient(worker);

    void client.materialise(DOC, 100);
    void client.materialise(DOC, 200);
    const before = worker.sent.length;
    client.close();
    worker.answerMaterialise(materialiseRequests(worker)[0]!.id, 100);

    expect(worker.sent).toHaveLength(before);
  });
});
