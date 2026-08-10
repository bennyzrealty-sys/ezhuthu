/**
 * The replay Worker (ADR-0009).
 *
 * Deliberately thin: it owns a Dexie connection and one `PastDocument`, and
 * every decision it could make is somewhere else. Worker code is the hardest
 * code in the project to test, so there is as little of it as possible.
 *
 * Its own connection to the same IndexedDB, opened read-only in practice. It
 * never writes: history is materialised from the log and the log belongs to the
 * append path on the main thread.
 */

import { EzhuthuDB } from '../../db/schema';
import type { DocId } from '../../db/types';
import { PastDocument } from './materialise';
import type { TimelapseRequest, TimelapseResponse } from './protocol';

const db = new EzhuthuDB();

let docId: DocId | null = null;
let past: PastDocument | null = null;

function documentFor(id: DocId): PastDocument {
  if (past === null || docId !== id) {
    docId = id;
    past = new PastDocument(db, id);
  }
  return past;
}

async function handle(request: TimelapseRequest): Promise<TimelapseResponse> {
  switch (request.kind) {
    case 'timeline': {
      return { kind: 'timeline', id: request.id, timeline: await documentFor(request.docId).timeline() };
    }
    case 'materialise': {
      const summary = await documentFor(request.docId).materialise(request.targetSeq);
      return { kind: 'materialise', id: request.id, summary };
    }
    case 'window': {
      const document = documentFor(request.docId);
      return {
        kind: 'window',
        id: request.id,
        seq: document.current.seq,
        from: request.from,
        blocks: document.window(request.from, request.count),
      };
    }
  }
}

self.addEventListener('message', (event: MessageEvent<TimelapseRequest>) => {
  void handle(event.data)
    .then((response) => {
      (self as unknown as Worker).postMessage(response);
    })
    .catch((error: unknown) => {
      // A failure here costs one feature, never data. It is reported rather
      // than swallowed so the panel can say so instead of showing a document
      // frozen at the wrong moment.
      const message: TimelapseResponse = {
        kind: 'error',
        id: event.data.id,
        message: error instanceof Error ? error.message : String(error),
      };
      (self as unknown as Worker).postMessage(message);
    });
});
