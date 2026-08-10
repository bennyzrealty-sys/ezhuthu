/**
 * Phase 3 shell: the document, search, and the Phase 1 status panel behind a
 * toggle.
 *
 * Deliberately thin. Resume, visibility, minimap and time-lapse are Phases 4-7
 * and are not stubbed here — an empty button is worse than an absent one.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { db } from './db/schema';
import { openDoc } from './core/events';
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
import { pruneSignals } from './signals/queries';
import { SnapshotScheduler } from './features/timelapse/snapshotting';
import { TimelapsePanel } from './features/timelapse/TimelapsePanel';
import type { Doc } from './db/types';

const DOC_ID = 'primary';

interface Status {
  doc: Doc;
  headSeq: number;
  backup: BackupStatus;
  persistence: PersistenceState;
  usageMb: number | null;
}

/**
 * The document record, created on first run.
 *
 * Everything that writes has to go through this first. `loadStatus` runs in an
 * effect, so on a genuinely empty database an Import fired before that effect
 * settles reaches `importBlocks` with no `docs` row and throws
 * "import: unknown document primary" — the toolbar shows the error, the app
 * shows an empty document, and nothing says to try again. Rare in ordinary use
 * and reliably reproducible with a fast enough first tap.
 */
async function ensureDoc(): Promise<Doc> {
  return openDoc(db, { docId: DOC_ID, title: 'എഴുത്ത്' });
}

async function loadStatus(): Promise<Status> {
  await ensureDoc();

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
  const [timelapsing, setTimelapsing] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const view = useRef<DocumentViewHandle | null>(null);

  /*
   * Last call wins. Two status loads overlap on the ordinary import path — the
   * one this component fires on mount and the one the import fires when it
   * finishes — and on a large document the first is the slower of the two,
   * because it walks the log to check the projection. Without a ticket its
   * result lands last and the toolbar reports the document as it was BEFORE
   * the import: "0 words · 0 blocks" over 80,000 words that are on screen, with
   * no further refresh coming to correct it.
   */
  const loadTicket = useRef(0);

  const refresh = useCallback(() => {
    const ticket = ++loadTicket.current;
    loadStatus()
      .then((fresh) => {
        if (ticket === loadTicket.current) setStatus(fresh);
      })
      .catch((error: unknown) =>
        setMessage(error instanceof Error ? error.message : String(error)),
      );
  }, []);

  useEffect(refresh, [refresh]);

  /*
   * Anchors for the time-lapse scrub (ADR-0009). Asked for after every
   * committed change and written from idle, at most one at a time; the
   * scheduler decides that nothing is due, which is the answer on all but every
   * five-hundredth commit.
   *
   * Not in the append transaction, deliberately. A snapshot is disposable —
   * losing one costs a slower scrub and never data — so it must not be able to
   * fail or slow a write of real work.
   */
  const snapshots = useRef<SnapshotScheduler | null>(null);
  useEffect(() => {
    const scheduler = new SnapshotScheduler(db, DOC_ID);
    snapshots.current = scheduler;
    return () => {
      scheduler.stop();
      snapshots.current = null;
    };
  }, []);

  const onDocumentChange = useCallback(() => {
    refresh();
    snapshots.current?.request();
  }, [refresh]);

  /*
   * Signals older than the retention window have no reader — the queries ask
   * about the last session and a recent window — and they accumulate for as
   * long as the app is used. Deleted rather than kept, because unlike the
   * document they are telemetry about the work and not the work itself
   * (docs/SIGNALS.md).
   *
   * After the first status load, not alongside it. Maintenance on a store
   * nobody is waiting for has no business competing with opening the document,
   * which on a 100k-word log is already a projection check and a head-seq read.
   * Not awaited and not surfaced either: a failure here must change nothing the
   * writer sees.
   */
  const pruned = useRef(false);
  useEffect(() => {
    if (status === null || pruned.current) return;
    pruned.current = true;
    void pruneSignals(db).catch(() => undefined);
  }, [status]);

  const onImport = useCallback(
    async (file: File) => {
      setBusy('Importing…');
      try {
        const text = await file.text();
        // Not just belt and braces: on first run this can be reached before
        // the effect that creates the document has finished.
        await ensureDoc();
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
        <button
          onClick={() => setTimelapsing(true)}
          disabled={busy !== null}
          data-testid="timelapse-toggle"
        >
          Time-lapse
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

      <DocumentView ref={view} key={reloadKey} db={db} docId={DOC_ID} onChange={onDocumentChange} />

      {/*
        * Mounted only while open, so the Worker exists only while it is being
        * used and the document behind it is untouched — the panel is a reader
        * of history, not a mode the editor enters.
        */}
      {timelapsing && <TimelapsePanel docId={DOC_ID} onClose={() => setTimelapsing(false)} />}
    </div>
  );
}
