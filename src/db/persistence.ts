/**
 * Storage durability and backups (ADR-0013).
 *
 * IndexedDB is evictable. On iOS, storage for a site not installed to the home
 * screen can be reclaimed under pressure and, on some versions, after a period
 * of disuse. For an application whose whole value is holding a 100,000-word
 * manuscript, this is a larger risk to the user than every performance concern
 * in the project combined: a slow editor is annoying, an evicted manuscript is
 * a catastrophe with no recourse.
 *
 * Three layers, in increasing order of how much they actually protect:
 *   1. request persistence   — a request, not a guarantee
 *   2. report the result honestly — never present unprotected storage as safe
 *   3. scheduled backups out of the browser — the only layer that survives
 *      eviction, and therefore the one the UI treats as the real protection
 */

import { rebuildProjection, type EzhuthuDB } from './schema';
import type { BackupFile, BlockEvent, Doc } from './types';
import { compareEvents } from '../core/order';

const BACKUP_DIR_HANDLE_KEY = 'backup.directoryHandle';

// ---------------------------------------------------------------------------
// Layer 1 + 2 — persistence request and honest reporting
// ---------------------------------------------------------------------------

export type PersistenceState =
  | 'granted' // storage.persist() said yes
  | 'denied' // asked, refused — data is evictable
  | 'unsupported'; // no API at all (older WebKit) — assume evictable

export async function requestPersistence(): Promise<PersistenceState> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return 'unsupported';
  try {
    if (await navigator.storage.persisted?.()) return 'granted';
    return (await navigator.storage.persist()) ? 'granted' : 'denied';
  } catch {
    return 'unsupported';
  }
}

export interface StorageEstimate {
  usageBytes: number | null;
  quotaBytes: number | null;
  /** 0–1, or null when the browser will not say. */
  fraction: number | null;
}

export async function estimateStorage(): Promise<StorageEstimate> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
    return { usageBytes: null, quotaBytes: null, fraction: null };
  }
  try {
    const { usage, quota } = await navigator.storage.estimate();
    const usageBytes = usage ?? null;
    const quotaBytes = quota ?? null;
    return {
      usageBytes,
      quotaBytes,
      fraction: usageBytes !== null && quotaBytes ? usageBytes / quotaBytes : null,
    };
  } catch {
    return { usageBytes: null, quotaBytes: null, fraction: null };
  }
}

/**
 * Called on first write. Records the answer on the document so the UI can tell
 * the truth about it without re-asking.
 */
export async function ensurePersistence(db: EzhuthuDB, docId: string): Promise<PersistenceState> {
  const state = await requestPersistence();
  await db.docs.update(docId, { persistGranted: state === 'granted' });
  return state;
}

// ---------------------------------------------------------------------------
// Layer 3 — backups
// ---------------------------------------------------------------------------

/** A day. Long enough not to nag, short enough to bound what a loss costs. */
export const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type BackupUrgency = 'ok' | 'due' | 'overdue' | 'urgent';

export interface BackupStatus {
  urgency: BackupUrgency;
  lastBackupAt: number | null;
  ageMs: number | null;
  /** Events written since the last backup — what a loss would actually cost. */
  unbackedEvents: number;
}

export function backupUrgency(lastBackupAt: number | null, now: number): BackupUrgency {
  if (lastBackupAt === null) return 'due';
  const age = now - lastBackupAt;
  if (age < BACKUP_INTERVAL_MS) return 'ok';
  if (age < BACKUP_INTERVAL_MS * 3) return 'due';
  if (age < BACKUP_INTERVAL_MS * 7) return 'overdue';
  return 'urgent';
}

export async function getBackupStatus(
  db: EzhuthuDB,
  docId: string,
  now = Date.now(),
): Promise<BackupStatus> {
  const doc = await db.docs.get(docId);
  if (doc === undefined) throw new Error(`getBackupStatus: unknown document ${docId}`);
  const lastBackupAt = doc.lastBackupAt ?? null;

  // Counting events since the backup makes the warning concrete: "you would
  // lose 340 edits" lands where "backup overdue" does not.
  const unbackedEvents =
    lastBackupAt === null
      ? await db.events.where('ts').aboveOrEqual(0).count()
      : await db.events.where('ts').above(lastBackupAt).count();

  return {
    urgency: backupUrgency(lastBackupAt, now),
    lastBackupAt,
    ageMs: lastBackupAt === null ? null : now - lastBackupAt,
    unbackedEvents,
  };
}

/**
 * Build the backup payload.
 *
 * Contains only `docs` and `events` — the two irreplaceable stores. `blocks`
 * and `snapshots` are derivable from the log (ADR-0001) and including them
 * would inflate the file with data it already holds.
 *
 * Plain JSON, restorable without this application. For a file holding
 * someone's book, that is the right format.
 */
export async function buildBackup(db: EzhuthuDB, now = Date.now()): Promise<BackupFile> {
  const docs = await db.docs.toArray();
  const events = await db.events.toArray();
  events.sort(compareEvents);
  return { format: 'ezhuthu-backup', version: 1, exportedAt: now, docs, events };
}

export function backupFilename(docs: readonly Doc[], now: number): string {
  const stamp = new Date(now).toISOString().slice(0, 19).replaceAll(':', '-');
  const title = docs.length === 1 ? (docs[0]!.title || 'untitled') : 'all-documents';
  const safe = title.replaceAll(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 60);
  return `ezhuthu-${safe}-${stamp}.json`;
}

/**
 * Where the browser supports it, backups go to a folder the user picked once,
 * so the schedule can actually run rather than prompting for a download every
 * day. The handle is structured-cloneable, which is why it lives in IndexedDB
 * and not localStorage.
 */
export async function chooseBackupDirectory(db: EzhuthuDB): Promise<boolean> {
  const picker = (globalThis as { showDirectoryPicker?: (o?: unknown) => Promise<unknown> })
    .showDirectoryPicker;
  if (typeof picker !== 'function') return false;
  try {
    const handle = await picker({ id: 'ezhuthu-backups', mode: 'readwrite' });
    await db.settings.put({ key: BACKUP_DIR_HANDLE_KEY, value: handle });
    return true;
  } catch {
    return false; // user cancelled
  }
}

interface DirectoryHandleLike {
  queryPermission?: (d: { mode: string }) => Promise<PermissionState>;
  requestPermission?: (d: { mode: string }) => Promise<PermissionState>;
  getFileHandle: (name: string, o?: { create?: boolean }) => Promise<{
    createWritable: () => Promise<{ write: (d: string) => Promise<void>; close: () => Promise<void> }>;
  }>;
}

async function getWritableBackupDirectory(db: EzhuthuDB): Promise<DirectoryHandleLike | null> {
  const setting = await db.settings.get(BACKUP_DIR_HANDLE_KEY);
  const handle = setting?.value as DirectoryHandleLike | undefined;
  if (!handle?.getFileHandle) return null;
  try {
    if (handle.queryPermission) {
      let state = await handle.queryPermission({ mode: 'readwrite' });
      if (state === 'prompt' && handle.requestPermission) {
        state = await handle.requestPermission({ mode: 'readwrite' });
      }
      if (state !== 'granted') return null;
    }
    return handle;
  } catch {
    return null;
  }
}

export type BackupDestination = 'directory' | 'download';

export interface BackupResult {
  destination: BackupDestination;
  filename: string;
  bytes: number;
  eventCount: number;
}

/**
 * Write a backup, preferring the chosen folder and falling back to a download.
 *
 * `lastBackupAt` is stamped only after the write succeeds — a failed backup
 * must not reset the nag, or the schedule quietly stops protecting anything.
 */
export async function runBackup(
  db: EzhuthuDB,
  opts: { now?: number; forceDownload?: boolean } = {},
): Promise<BackupResult> {
  const now = opts.now ?? Date.now();
  const backup = await buildBackup(db, now);
  const json = JSON.stringify(backup);
  const filename = backupFilename(backup.docs, now);

  let destination: BackupDestination = 'download';
  const dir = opts.forceDownload ? null : await getWritableBackupDirectory(db);

  if (dir) {
    const fileHandle = await dir.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(json);
    await writable.close();
    destination = 'directory';
  } else {
    downloadJson(filename, json);
  }

  await db.docs.toCollection().modify({ lastBackupAt: now });

  return { destination, filename, bytes: json.length, eventCount: backup.events.length };
}

function downloadJson(filename: string, json: string): void {
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

export interface RestoreResult {
  docsRestored: number;
  eventsAdded: number;
  eventsSkipped: number;
}

export function parseBackup(json: string): BackupFile {
  const parsed: unknown = JSON.parse(json);
  const file = parsed as Partial<BackupFile>;
  if (file.format !== 'ezhuthu-backup') throw new Error('not an ezhuthu backup file');
  if (file.version !== 1) throw new Error(`unsupported backup version ${String(file.version)}`);
  if (!Array.isArray(file.docs) || !Array.isArray(file.events)) {
    throw new Error('backup is missing docs or events');
  }
  return file as BackupFile;
}

/**
 * Restore a backup, merging into whatever is already here rather than assuming
 * an empty database — restoring onto a device that has since been written to
 * is the case that actually happens.
 *
 * Events already present (same id) are skipped, so restoring twice is a no-op.
 * Projections are rebuilt from the merged log afterwards, since `blocks` and
 * `snapshots` are caches.
 */
export async function restoreBackup(db: EzhuthuDB, file: BackupFile): Promise<RestoreResult> {
  let eventsAdded = 0;
  let eventsSkipped = 0;

  await db.transaction('rw', db.docs, db.events, async () => {
    for (const doc of file.docs) {
      const existing = await db.docs.get(doc.id);
      if (existing === undefined) {
        await db.docs.add(doc);
      } else {
        // Keep whichever counter is further ahead so a later append cannot
        // reuse a seq that the restored log already occupies.
        await db.docs.update(doc.id, {
          seqCounter: Math.max(existing.seqCounter, doc.seqCounter),
          title: existing.title || doc.title,
        });
      }
    }

    const incoming: BlockEvent[] = [...file.events].sort(compareEvents);
    for (const event of incoming) {
      if ((await db.events.get(event.id)) !== undefined) {
        eventsSkipped += 1;
        continue;
      }
      await db.events.add(event);
      eventsAdded += 1;
    }
  });

  const docIds = new Set(file.docs.map((d) => d.id));
  for (const docId of docIds) await rebuildProjection(db, docId);

  return { docsRestored: file.docs.length, eventsAdded, eventsSkipped };
}
