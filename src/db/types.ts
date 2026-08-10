/**
 * Core domain types. See docs/DATA-MODEL.md for the worked examples.
 *
 * Nothing in here imports Dexie or React — these types are shared by the pure
 * fold in core/, which runs in a Web Worker.
 */

export type DocId = string;
export type BlockId = string;

/**
 * Fractional index. LEXICOGRAPHIC string comparison, never numeric (ADR-0007).
 * Sorting these as numbers anywhere is a bug.
 */
export type OrderKey = string;

export interface Doc {
  id: DocId;
  title: string;
  createdAt: number;
  updatedAt: number;

  /** Next seq to allocate. Bumped inside the append transaction (ADR-0020). */
  seqCounter: number;
  /** Proves `blocks` is in step with the log (ADR-0008). */
  lastAppliedSeq: number;

  /** Denormalised, excludes soft-deleted blocks. */
  blockCount: number;
  /** Denormalised. Maintained by per-block delta, never a full recount. */
  wordCount: number;

  /** Result of navigator.storage.persist() (ADR-0013). */
  persistGranted?: boolean;
  /** Drives the backup nag. */
  lastBackupAt?: number;
}

export interface Block {
  blockId: BlockId;
  docId: DocId;
  order: OrderKey;
  text: string;
  createdAt: number;
  updatedAt: number;
  /** Count of `update` events. Rebuilt on replay. */
  revisionCount: number;
  /** Soft delete (ADR-0018). Present means deleted. */
  deletedAt?: number;
  /** Extension point: block type tags, `locked`. Always present, `{}` when empty. */
  meta: Record<string, unknown>;
}

export type BlockEventType = 'insert' | 'update' | 'delete' | 'move';

export interface BlockEventPayload {
  /** insert, update, delete. `delete` always carries full text (ADR-0012). */
  text?: string;
  /**
   * Only when NOT derivable from the preceding event for this block (ADR-0012).
   * Usually absent. Do not populate it "for completeness" — that doubles the log.
   */
  prevText?: string;
  /** insert, move. Intent, not outcome: `null` means "first in document". */
  afterBlockId?: BlockId | null;
  /**
   * On a `delete` that implements a MERGE, the block the text was folded into
   * (ADR-0028). A merge is not a deletion: its text survives in the neighbour,
   * so it must not leave a restorable ghost, which would duplicate that text.
   * The fold records it on `Block.meta.mergedInto`; ghost markers skip it.
   * Absent on a deliberate delete, which is what leaves a ghost.
   */
  mergedInto?: BlockId;
}

export interface BlockEvent {
  id: string;
  /** Monotonic per document (ADR-0020). */
  seq: number;
  /**
   * Epoch ms. Display and time-decay ONLY. Never used for ordering — wall
   * clocks move backwards (NTP, DST). Order by (seq, deviceId).
   */
  ts: number;
  sessionId: string;
  deviceId: string;
  docId: DocId;
  blockId: BlockId;
  type: BlockEventType;
  payload: BlockEventPayload;
}

export interface Snapshot {
  docId: DocId;
  /** State as of, and including, this seq. */
  seq: number;
  ts: number;
  blocks: Block[];
}

export type SignalKind = 'dwell' | 'hesitation' | 'backspace' | 'scrollback';

export interface Signal {
  id?: number;
  docId: DocId;
  blockId: BlockId;
  ts: number;
  sessionId: string;
  kind: SignalKind;
  /** dwell/hesitation: ms. backspace: count. scrollback: ms dwelled after return. */
  value: number;
}

/**
 * Compact per-block index held in memory for ALL blocks (~100 bytes each, so
 * ~200KB at 2,000 blocks). Drives the minimap and scrollbar without ever
 * loading block text. See docs/PERFORMANCE.md.
 */
export interface BlockIndexEntry {
  blockId: BlockId;
  order: OrderKey;
  updatedAt: number;
  revisionCount: number;
  length: number;
  deleted: boolean;
}

/**
 * The materialised state a fold produces.
 *
 * `order` is maintained incrementally alongside `blocks` so that resolving an
 * insert's position is a binary search rather than a re-sort. Replaying
 * 200,000 events would otherwise be O(n² log n).
 *
 * It includes soft-deleted blocks: they keep their position so a restore lands
 * back where the text was (ADR-0018).
 */
export interface DocState {
  docId: DocId;
  blocks: Map<BlockId, Block>;
  /** Block ids sorted by `Block.order`, including soft-deleted. */
  order: BlockId[];
  /** Highest seq folded in. */
  seq: number;
}

/**
 * Small key/value store for things that are neither document data nor
 * telemetry — chiefly the FileSystemDirectoryHandle for scheduled backups,
 * which is structured-cloneable and so can only live in IndexedDB.
 */
export interface Setting {
  key: string;
  value: unknown;
}

export interface BackupFile {
  format: 'ezhuthu-backup';
  version: 1;
  exportedAt: number;
  docs: Doc[];
  /** Ordered by (seq, deviceId). Blocks and snapshots are derivable and excluded. */
  events: BlockEvent[];
}
