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
import { BookmarksPanel } from './features/visibility/BookmarksPanel';
import { ResumeStrip } from './features/resume/ResumeStrip';
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
import { corpusFilename, downloadCorpus, exportCorpus } from './features/io/corpus/export';
import { documentFilename, downloadDocument, exportDocument } from './features/io/export';
import { canUndo, undoLast } from './features/undo/apply';
import {
  DEFAULT_FEEDBACK,
  hapticsSupported,
  loadFeedback,
  saveFeedback,
  type FeedbackSettings,
} from './features/visibility/feedback';
import { useInstall } from './pwa/useInstall';
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
  const [undoable, setUndoable] = useState(false);
  const [bookmarking, setBookmarking] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackSettings>(DEFAULT_FEEDBACK);
  const { availability: installable, promptInstall } = useInstall();
  const [installHelp, setInstallHelp] = useState(false);
  /*
   * The strip is an opening offer, not a panel. It is shown once per launch —
   * requirement 1 is "on open, return the writer to where he was working" — and
   * once he has gone somewhere, or said no, it is gone until the next launch.
   * It renders nothing at all until a destination resolves, so a fresh install
   * never sees it.
   */
  const [resuming, setResuming] = useState(true);
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

  /*
   * Whether undo has anything to reach for. Re-asked after every change rather
   * than tracked in memory, because the answer lives in the log and a stack
   * held in a component would be wrong the moment a second tab wrote to the
   * same document (ADR-0033).
   */
  const refreshUndo = useCallback(() => {
    canUndo(db, DOC_ID)
      .then(setUndoable)
      .catch(() => setUndoable(false));
  }, []);

  useEffect(refreshUndo, [refreshUndo]);

  const onDocumentChange = useCallback(() => {
    refresh();
    refreshUndo();
    snapshots.current?.request();
  }, [refresh, refreshUndo]);

  const onUndo = useCallback(() => {
    undoLast(db, DOC_ID)
      .then((outcome) => {
        if (outcome.refused === 'not-reversible') {
          setMessage('That change cannot be undone.');
          return;
        }
        if (outcome.undone === 0) {
          setMessage('Nothing left to undo in this session.');
          return;
        }
        setMessage(null);
        // The change was appended from here, so the document view is holding a
        // copy that predates it.
        view.current?.reload();
        refresh();
        refreshUndo();
      })
      .catch((e: unknown) => setMessage(e instanceof Error ? e.message : String(e)));
  }, [refresh, refreshUndo]);

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

  // Scroll-past feedback preferences (ADR-0022), off by default.
  useEffect(() => {
    void loadFeedback(db).then(setFeedback);
  }, []);

  const updateFeedback = useCallback(
    (patch: Partial<FeedbackSettings>) => {
      setFeedback((current) => {
        const next = { ...current, ...patch };
        void saveFeedback(db, next);
        return next;
      });
    },
    [],
  );

  /*
   * Commit whatever the writer is in the middle of typing, before anything
   * reads the document as a whole.
   *
   * Download, Back up and Export corpus all read committed state — the `blocks`
   * projection or the event log — and the paragraph under the caret is in
   * neither for up to `IDLE_COMMIT_MS` after the last keystroke (ADR-0036). On
   * the browsers where tapping a button moves focus, the editor's own blur
   * happened to commit first and this was invisible; on the ones where it does
   * not (Safari and iOS do not focus a button on tap), the file arrived without
   * the writer's most recent work, and a paragraph begun and downloaded in the
   * same breath arrived EMPTY.
   *
   * Awaited, so the append has committed before the read starts.
   */
  const flushEdits = useCallback(async () => {
    return (await view.current?.flushPendingEdit()) ?? null;
  }, []);

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

  /*
   * The corpus (ADR-0016). A batch walk of the whole log, so it is put behind a
   * busy state and its result is reported in numbers the writer can check
   * against their own memory of the work — "412 revisions, 180 exported" says
   * something; "exported" does not.
   *
   * Never automatic and never uploaded. This writes a file to the device and
   * does nothing else.
   */
  /*
   * The document, as a file the writer can read, send, or open anywhere —
   * the same plain-text format Import accepts, so it round-trips.
   *
   * Distinct from the two exports that already existed and which nobody asked
   * for by this name: Back up writes the event log as JSON (a restore file),
   * and Export corpus writes revision pairs, which are deliberately empty for
   * a document that has only been written (ADR-0030).
   */
  const onDownload = useCallback(() => {
    setBusy('Preparing the file…');
    const now = Date.now();
    flushEdits()
      .then((pending) => exportDocument(db, DOC_ID, pending))
      .then(({ text, blocks, characters }) => {
        if (blocks === 0) {
          setMessage('Nothing to download yet — the document is empty.');
          return;
        }
        downloadDocument(documentFilename(status?.doc.title ?? '', now), text);
        setMessage(
          `Downloaded ${blocks.toLocaleString()} paragraphs (${Math.max(1, Math.round(characters / 1024)).toLocaleString()} KB) as plain text.`,
        );
      })
      .catch((e: unknown) => setMessage(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null));
  }, [flushEdits, status?.doc.title]);

  const onExportCorpus = useCallback(() => {
    setBusy('Building the corpus…');
    const now = Date.now();
    flushEdits()
      .then(() => exportCorpus(db, DOC_ID))
      .then(({ jsonl, stats }) => {
        if (stats.emitted === 0) {
          setMessage(
            stats.revisions === 0
              ? 'No revisions yet — the corpus is built from paragraphs you come back to.'
              : `${stats.revisions.toLocaleString()} revisions, all of them corrections. Nothing to export yet.`,
          );
          return;
        }
        const title = status?.doc.title ?? '';
        downloadCorpus(corpusFilename(title, now), jsonl);
        setMessage(
          `Exported ${stats.emitted.toLocaleString()} of ${stats.pairs.toLocaleString()} revisions ` +
            `across ${stats.blocks.toLocaleString()} paragraphs.`,
        );
      })
      .catch((e: unknown) => setMessage(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null));
  }, [flushEdits, status?.doc.title]);

  const onBackup = useCallback(() => {
    setBusy('Backing up…');
    // A backup that omits the sentence the writer is looking at is the one
    // failure ADR-0013 exists to prevent, dressed as a success.
    flushEdits()
      .then(() => runBackup(db))
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
  }, [flushEdits, refresh]);

  /*
   * One button for three platforms' worth of reality. Where the browser has
   * handed over a deferred prompt, firing it from the click IS the one-tap
   * install — and it must be fired from the gesture; browsers reject it from
   * anywhere else. Everywhere else — iOS Safari, the in-app browser views
   * links actually open in, Chromium before its engagement heuristic — no web
   * API can install anything, so the same button opens the honest steps
   * instead of pretending, or not existing.
   */
  const onInstall = useCallback(() => {
    if (installable !== 'promptable') {
      setInstallHelp((v) => !v);
      return;
    }
    setInstallHelp(false);
    void promptInstall().then((outcome) => {
      if (outcome === 'dismissed') {
        // The deferred event is spent — the browser offers it once per visit —
        // so from here the button falls back to showing the manual steps.
        setMessage('Not installed. The Install button now shows the manual steps instead.');
      } else if (outcome === 'unavailable') {
        // A second tap raced the first, or the event was spent: show the steps.
        setInstallHelp(true);
      }
    });
  }, [installable, promptInstall]);

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
        {installable !== 'installed' && (
          <button
            onClick={onInstall}
            data-testid="install"
            aria-expanded={installHelp}
            title="Add എഴുത്ത് to the home screen — an installed app is much less likely to have its storage evicted"
          >
            Install
          </button>
        )}
        <button
          onClick={() => {
            if (searching) return closeSearch();
            setBookmarking(false);
            setSearching(true);
          }}
          aria-expanded={searching}
          data-testid="search-toggle"
        >
          {searching ? 'Close search' : 'Search'}
        </button>
        <button
          onClick={onUndo}
          disabled={!undoable || busy !== null}
          data-testid="undo"
          title="Undo the last change made in this session"
        >
          Undo
        </button>
        <button
          onClick={() => {
            if (bookmarking) return setBookmarking(false);
            closeSearch();
            setBookmarking(true);
          }}
          aria-expanded={bookmarking}
          data-testid="bookmarks-toggle"
        >
          {bookmarking ? 'Close bookmarks' : 'Bookmarks'}
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
        <button onClick={onDownload} disabled={busy !== null} data-testid="download-document">
          Download
        </button>
        <button onClick={onExportCorpus} disabled={busy !== null} data-testid="corpus-export">
          Export corpus
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

      {busy !== null && (
        <p className="note" style={{ padding: '0 1rem' }} data-testid="busy">
          {busy}
        </p>
      )}
      {message !== null && (
        <p className="note" style={{ padding: '0 1rem' }} data-testid="message" aria-live="polite">
          {message}
        </p>
      )}

      {installHelp && installable !== 'installed' && (
        <div style={{ padding: '0 1rem' }}>
          <section className="card" data-testid="install-help">
            <h2>Add എഴുത്ത് to the home screen</h2>
            <p className="note">
              This browser will not hand over an install dialog, so it is done from the browser's
              own controls:
            </p>
            <ul className="note">
              <li>
                Reading this inside another app (Gmail, WhatsApp…)? Its viewer cannot install
                anything. Use its menu to Open in Chrome (or your browser) first, then come back to
                this button.
              </li>
              <li>Android, Chrome: menu (⋮) → Add to Home screen → Install.</li>
              <li>iPhone and iPad, Safari: Share → Add to Home Screen.</li>
            </ul>
            <p className="note">
              Installed, the app opens full screen from its own icon, works with no connection, and
              the browser is far less likely to evict its storage — which is where the manuscript
              lives (ADR-0013).
            </p>
            <button onClick={() => setInstallHelp(false)}>Close</button>
          </section>
        </div>
      )}

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
                <dt>Home screen</dt>
                <dd
                  className={installable === 'installed' ? 'state-ok' : 'state-warn'}
                  data-testid="install-state"
                >
                  {installable === 'installed' ? 'installed' : 'running in a browser tab'}
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
            {installable === 'manual' && (
              <p className="note" data-testid="install-hint">
                This browser will not hand over an install dialog. The Install button in the
                toolbar shows where it lives instead — on iOS, Share and then Add to Home Screen;
                elsewhere, Install app in the browser menu.
              </p>
            )}
          </section>

          <section className="card">
            <h2>Scrolling feedback</h2>
            <label className="toggle-row">
              <span>
                Haptic tick past edits
                {!hapticsSupported() && (
                  <span className="note" style={{ margin: 0 }}>
                    {' '}
                    — unavailable on this device
                  </span>
                )}
              </span>
              <input
                type="checkbox"
                checked={feedback.haptics && hapticsSupported()}
                disabled={!hapticsSupported()}
                data-testid="feedback-haptics"
                onChange={(e) => updateFeedback({ haptics: e.target.checked })}
              />
            </label>
            <label className="toggle-row">
              <span>Visual pulse past edits</span>
              <input
                type="checkbox"
                checked={feedback.visualPulse}
                data-testid="feedback-visual"
                onChange={(e) => updateFeedback({ visualPulse: e.target.checked })}
              />
            </label>
          </section>
        </div>
      )}

      {resuming && (
        <ResumeStrip
          db={db}
          docId={DOC_ID}
          onGo={(destination) => {
            setResuming(false);
            // `position` is a hint the view corrects by id when it is wrong,
            // and here it is always wrong — the destinations are resolved from
            // the store, which has no opinion about the rendered index.
            view.current?.reveal({ blockId: destination.blockId, position: -1 });
          }}
          onDismiss={() => setResuming(false)}
        />
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

      {bookmarking && (
        <BookmarksPanel
          db={db}
          docId={DOC_ID}
          // position is a hint the view corrects by id; the store has no opinion
          // about the rendered index.
          onReveal={(blockId) => view.current?.reveal({ blockId, position: -1 })}
          onClose={() => setBookmarking(false)}
        />
      )}

      {/*
        * `onDocumentChange` rather than `refresh`: Phase 7 also asks for a
        * snapshot after every commit, which is what gives the scrub its anchors
        * (ADR-0009).
        */}
      <DocumentView
        ref={view}
        key={reloadKey}
        db={db}
        docId={DOC_ID}
        onChange={onDocumentChange}
        feedback={feedback}
      />

      {/*
        * Mounted only while open, so the Worker exists only while it is being
        * used and the document behind it is untouched — the panel is a reader
        * of history, not a mode the editor enters.
        */}
      {timelapsing && <TimelapsePanel docId={DOC_ID} onClose={() => setTimelapsing(false)} />}
    </div>
  );
}
