/**
 * Phase 3 shell: the document, search, and the Phase 1 status panel behind a
 * toggle.
 *
 * Deliberately thin. Resume, visibility, minimap and time-lapse are Phases 4-7
 * and are not stubbed here — an empty button is worse than an absent one.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { db } from './db/schema';
import { createDoc } from './core/events';
import { checkProjection, logHeadSeq, repairProjection } from './core/replay';
import { importText } from './features/io/import';
import { DocumentView, type DocumentViewHandle } from './render/DocumentView';
import { SearchPanel } from './features/search/SearchPanel';
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
  backup: BackupStatus;
  persistence: PersistenceState;
  usageMb: number | null;
}

async function loadStatus(): Promise<Status> {
  let doc = await db.docs.get(DOC_ID);
  if (doc === undefined) doc = await createDoc(db, { docId: DOC_ID, title: 'എഴുത്ത്' });

  // If a crash landed between the event append and the block write, the
  // projection is behind the log. Repair before showing anything (ADR-0008).
  const check = await checkProjection(db, DOC_ID);
  if (!check.consistent) await repairProjection(db, DOC_ID);

  const [headSeq, backup, persistence, storage] = await Promise.all([
    logHeadSeq(db, DOC_ID),
    getBackupStatus(db, DOC_ID),
    requestPersistence(),
    estimateStorage(),
  ]);

  const fresh = (await db.docs.get(DOC_ID))!;
  return {
    doc: fresh,
    headSeq,
    backup,
    persistence,
    usageMb: storage.usageBytes === null ? null : storage.usageBytes / (1024 * 1024),
  };
}

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [showStatus, setShowStatus] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [searching, setSearching] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const view = useRef<DocumentViewHandle | null>(null);

  const refresh = useCallback(() => {
    loadStatus()
      .then(setStatus)
      .catch((error: unknown) =>
        setMessage(error instanceof Error ? error.message : String(error)),
      );
  }, []);

  useEffect(refresh, [refresh]);

  const onImport = useCallback(
    async (file: File) => {
      setBusy('Importing…');
      try {
        const text = await file.text();
        const result = await importText(db, DOC_ID, text);
        setMessage(
          `Imported ${result.blocksAdded.toLocaleString()} blocks · ${result.wordsAdded.toLocaleString()} words.`,
        );
        setReloadKey((k) => k + 1);
        refresh();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  /*
   * One close path, used by the toolbar toggle, the panel's own button and
   * Escape. Leaving the toggle to flip `searching` on its own was a real bug:
   * the panel closed and the mark stayed behind on the paragraph, pointing at
   * a search the reader had dismissed.
   */
  const closeSearch = useCallback(() => {
    setSearching(false);
    view.current?.clearHighlight();
  }, []);

  const onBackup = useCallback(() => {
    setBusy('Backing up…');
    runBackup(db)
      .then((r) =>
        setMessage(
          `Backed up ${r.eventCount.toLocaleString()} events (${Math.round(r.bytes / 1024)} KB) via ${r.destination}.`,
        ),
      )
      .catch((e: unknown) => setMessage(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        setBusy(null);
        refresh();
      });
  }, [refresh]);

  return (
    <div className="doc-layout">
      <div className="doc-toolbar">
        <strong>എഴുത്ത്</strong>
        <span className="stat">
          {status === null
            ? '…'
            : `${status.doc.wordCount.toLocaleString()} words · ${status.doc.blockCount.toLocaleString()} blocks`}
        </span>
        <span className="spacer" />
        {status !== null && status.backup.urgency !== 'ok' && (
          <span
            className={status.backup.urgency === 'urgent' ? 'state-danger' : 'state-warn'}
            title={`${status.backup.unbackedEvents} edits not backed up`}
          >
            backup {status.backup.urgency}
          </span>
        )}
        <button
          onClick={() => (searching ? closeSearch() : setSearching(true))}
          aria-expanded={searching}
          data-testid="search-toggle"
        >
          {searching ? 'Close search' : 'Search'}
        </button>
        <button onClick={() => fileInput.current?.click()} disabled={busy !== null}>
          Import
        </button>
        <button onClick={onBackup} disabled={busy !== null}>
          Back up
        </button>
        <button onClick={() => setShowStatus((v) => !v)} aria-expanded={showStatus}>
          {showStatus ? 'Hide status' : 'Status'}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".txt,.md,text/plain,text/markdown"
          className="visually-hidden"
          data-testid="import-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void onImport(file);
          }}
        />
      </div>

      {busy !== null && <p className="note" style={{ padding: '0 1rem' }}>{busy}</p>}
      {message !== null && <p className="note" style={{ padding: '0 1rem' }}>{message}</p>}

      {showStatus && status !== null && (
        <div style={{ padding: '0 1rem' }}>
          <section className="card">
            <h2>Storage durability</h2>
            <dl>
              <div className="row">
                <dt>Eviction protection</dt>
                <dd className={status.persistence === 'granted' ? 'state-ok' : 'state-warn'}>
                  {status.persistence === 'granted'
                    ? 'persistent storage granted'
                    : status.persistence === 'denied'
                      ? 'not granted — evictable'
                      : 'unsupported — assume evictable'}
                </dd>
              </div>
              <div className="row">
                <dt>Used</dt>
                <dd>{status.usageMb === null ? 'unknown' : `${status.usageMb.toFixed(1)} MB`}</dd>
              </div>
              <div className="row">
                <dt>Events in log</dt>
                <dd>{status.headSeq.toLocaleString()}</dd>
              </div>
              <div className="row">
                <dt>Unbacked edits</dt>
                <dd>{status.backup.unbackedEvents.toLocaleString()}</dd>
              </div>
            </dl>
            {status.persistence !== 'granted' && (
              <p className="note">
                The browser has not promised to keep this data. Installing to the home screen
                improves the odds, but a backup is the only thing that survives eviction.
              </p>
            )}
          </section>
        </div>
      )}

      {searching && (
        <SearchPanel
          db={db}
          docId={DOC_ID}
          onReveal={(hit, matchIndex) =>
            view.current?.reveal({
              blockId: hit.blockId,
              position: hit.position,
              match: hit.matches[matchIndex],
            })
          }
          onClose={closeSearch}
        />
      )}

      <DocumentView ref={view} key={reloadKey} db={db} docId={DOC_ID} onChange={refresh} />
    </div>
  );
}
