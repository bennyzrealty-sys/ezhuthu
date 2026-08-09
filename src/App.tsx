/**
 * Phase 1 shell.
 *
 * There is no editor yet — that is Phase 2. What this screen does is expose
 * exactly what Phase 1 built, so the foundation can be exercised by hand:
 * the event log and its watermark, and the storage-durability layer that has
 * to exist before the app is trusted with real writing (ADR-0013).
 */

import { useCallback, useEffect, useState } from 'react';
import { db } from './db/schema';
import { createDoc, insertBlock } from './core/events';
import { checkProjection, logHeadSeq } from './core/replay';
import {
  estimateStorage,
  getBackupStatus,
  requestPersistence,
  runBackup,
  type BackupStatus,
  type PersistenceState,
} from './db/persistence';
import type { Doc } from './db/types';

const DOC_ID = 'primary';

interface Status {
  doc: Doc;
  headSeq: number;
  consistent: boolean;
  backup: BackupStatus;
  persistence: PersistenceState;
  usageMb: number | null;
}

async function loadStatus(): Promise<Status> {
  let doc = await db.docs.get(DOC_ID);
  if (doc === undefined) doc = await createDoc(db, { docId: DOC_ID, title: 'എഴുത്ത്' });

  const [{ consistent }, headSeq, backup, persistence, storage] = await Promise.all([
    checkProjection(db, DOC_ID),
    logHeadSeq(db, DOC_ID),
    getBackupStatus(db, DOC_ID),
    requestPersistence(),
    estimateStorage(),
  ]);

  return {
    doc,
    headSeq,
    consistent,
    backup,
    persistence,
    usageMb: storage.usageBytes === null ? null : storage.usageBytes / (1024 * 1024),
  };
}

const PHASES: Array<[name: string, done: boolean]> = [
  ['1 · Foundation', true],
  ['2 · Editing', false],
  ['3 · Malayalam', false],
  ['4 · Signals', false],
  ['5 · Resume', false],
  ['6 · Visibility', false],
  ['7 · Time-lapse + export', false],
  ['8 · PWA polish', false],
];

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(() => {
    loadStatus().then(setStatus).catch((error: unknown) => {
      setMessage(error instanceof Error ? error.message : String(error));
    });
  }, []);

  useEffect(refresh, [refresh]);

  const onBackup = useCallback(() => {
    setBusy(true);
    runBackup(db)
      .then((result) => {
        setMessage(
          `Backed up ${result.eventCount} events (${Math.round(result.bytes / 1024)} KB) via ${result.destination}.`,
        );
        refresh();
      })
      .catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setBusy(false));
  }, [refresh]);

  const onAppend = useCallback(() => {
    setBusy(true);
    insertBlock(db, DOC_ID, `ഖണ്ഡിക ${Date.now() % 10_000}`)
      .then(() => {
        setMessage(null);
        refresh();
      })
      .finally(() => setBusy(false));
  }, [refresh]);

  if (status === null) {
    return (
      <main className="app">
        <h1>എഴുത്ത്</h1>
        <p className="lede">{message ?? 'Opening…'}</p>
      </main>
    );
  }

  const { doc, headSeq, consistent, backup, persistence, usageMb } = status;

  return (
    <main className="app">
      <h1>എഴുത്ത് · ezhuthu</h1>
      <p className="lede">
        Foundation is in place. The editor arrives in Phase 2 — this screen exercises the event
        log and the storage-durability layer underneath it.
      </p>

      <section className="card">
        <h2>Document</h2>
        <dl>
          <div className="row">
            <dt>Blocks</dt>
            <dd>{doc.blockCount}</dd>
          </div>
          <div className="row">
            <dt>Words</dt>
            <dd>{doc.wordCount.toLocaleString()}</dd>
          </div>
          <div className="row">
            <dt>Events in log</dt>
            <dd>{headSeq.toLocaleString()}</dd>
          </div>
          <div className="row">
            <dt>Projection</dt>
            <dd className={consistent ? 'state-ok' : 'state-danger'}>
              {consistent ? 'in step with the log' : 'stale — repair needed'}
            </dd>
          </div>
        </dl>
      </section>

      <section className="card">
        <h2>Storage durability</h2>
        <dl>
          <div className="row">
            <dt>Eviction protection</dt>
            <dd className={persistence === 'granted' ? 'state-ok' : 'state-warn'}>
              {persistence === 'granted'
                ? 'persistent storage granted'
                : persistence === 'denied'
                  ? 'not granted — evictable'
                  : 'unsupported — assume evictable'}
            </dd>
          </div>
          <div className="row">
            <dt>Used</dt>
            <dd>{usageMb === null ? 'unknown' : `${usageMb.toFixed(1)} MB`}</dd>
          </div>
          <div className="row">
            <dt>Last backup</dt>
            <dd
              className={
                backup.urgency === 'ok'
                  ? 'state-ok'
                  : backup.urgency === 'urgent'
                    ? 'state-danger'
                    : 'state-warn'
              }
            >
              {backup.lastBackupAt === null
                ? 'never'
                : new Date(backup.lastBackupAt).toLocaleString()}
            </dd>
          </div>
          <div className="row">
            <dt>Unbacked edits</dt>
            <dd>{backup.unbackedEvents.toLocaleString()}</dd>
          </div>
        </dl>

        {persistence !== 'granted' && (
          <p className="note">
            The browser has not promised to keep this data. Installing to the home screen
            improves the odds, but a backup is the only thing that actually survives eviction.
          </p>
        )}

        <div className="actions" style={{ marginTop: '0.9rem' }}>
          <button className="primary" onClick={onBackup} disabled={busy}>
            Back up now
          </button>
          <button onClick={onAppend} disabled={busy}>
            Append a test block
          </button>
        </div>
      </section>

      <section className="card">
        <h2>Build progress</h2>
        <ul className="phase-list">
          {PHASES.map(([name, done]) => (
            <li key={name}>
              <span>{name}</span>
              <span className={done ? 'done' : 'todo'}>{done ? 'done' : 'not started'}</span>
            </li>
          ))}
        </ul>
      </section>

      {message !== null && <p className="note">{message}</p>}
    </main>
  );
}
