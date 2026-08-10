/**
 * Reading signals back, and pruning them.
 *
 * The only consumers are Resume (Phase 5) and the scroll-back bookmarks of
 * Visibility (Phase 6). Both ask small questions — "which block in the last
 * session accrued the most dwell", "where did the writer keep going back to" —
 * so these are aggregations over a bounded window, never a scan of the store.
 *
 * Nothing here leaves the device (docs/SIGNALS.md). There is no export path for
 * signals, and the backup file (ADR-0013) does not contain them.
 */

import type { EzhuthuDB } from '../db/schema';
import type { DocId, Signal, SignalKind } from '../db/types';
import { SIGNAL_RETENTION_DAYS } from './constants';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface WindowOptions {
  /** Epoch ms. Defaults to everything the retention window still holds. */
  since?: number;
  /** Restrict to one app launch — "the last session" of the resume strip. */
  sessionId?: string;
}

async function readWindow(
  db: EzhuthuDB,
  docId: DocId,
  kind: SignalKind,
  options: WindowOptions,
): Promise<Signal[]> {
  const from = options.since ?? 0;
  const rows = await db.signals
    .where('[docId+ts]')
    .between([docId, from], [docId, Number.MAX_SAFE_INTEGER])
    .toArray();

  return options.sessionId === undefined
    ? rows.filter((r) => r.kind === kind)
    : rows.filter((r) => r.kind === kind && r.sessionId === options.sessionId);
}

/**
 * Total accrued value per block for one kind of signal.
 *
 * Records are already coalesced per flush window, so this sums a handful of
 * rows per block rather than one per sample.
 */
export async function totalsByBlock(
  db: EzhuthuDB,
  docId: DocId,
  kind: SignalKind,
  options: WindowOptions = {},
): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  for (const row of await readWindow(db, docId, kind, options)) {
    totals.set(row.blockId, (totals.get(row.blockId) ?? 0) + row.value);
  }
  return totals;
}

export interface BlockAggregate {
  /** How many separate signal records the block accrued. */
  count: number;
  /** Their summed value. */
  total: number;
}

/**
 * Both the count and the sum per block for one kind of signal.
 *
 * Scroll-back bookmarks (Phase 6) rank by how *often* the writer returned to a
 * block, not only how long — a reference checked ten times briefly is a
 * stronger bookmark than one dwelled on once. Signals coalesce per flush window,
 * so a `count` is close to "distinct visits" without being exactly it, which is
 * the right resolution for a ranking.
 */
export async function aggregateByBlock(
  db: EzhuthuDB,
  docId: DocId,
  kind: SignalKind,
  options: WindowOptions = {},
): Promise<Map<string, BlockAggregate>> {
  const out = new Map<string, BlockAggregate>();
  for (const row of await readWindow(db, docId, kind, options)) {
    const agg = out.get(row.blockId) ?? { count: 0, total: 0 };
    agg.count += 1;
    agg.total += row.value;
    out.set(row.blockId, agg);
  }
  return out;
}

export interface RankedBlock {
  blockId: string;
  value: number;
}

/** Blocks ranked by one signal, highest first. Resume destination 3 reads this. */
export async function rankBlocks(
  db: EzhuthuDB,
  docId: DocId,
  kind: SignalKind,
  options: WindowOptions & { limit?: number } = {},
): Promise<RankedBlock[]> {
  const totals = await totalsByBlock(db, docId, kind, options);
  const ranked = [...totals]
    .map(([blockId, value]) => ({ blockId, value }))
    .sort((a, b) => b.value - a.value);
  return options.limit === undefined ? ranked : ranked.slice(0, options.limit);
}

/**
 * Delete signals older than the retention window.
 *
 * A genuine deletion, unlike document data: signals are telemetry about the
 * writer's work, not the work. Called once at startup, where a store with
 * nothing to prune costs one index range that matches nothing.
 */
export async function pruneSignals(
  db: EzhuthuDB,
  options: { now?: number; keepDays?: number } = {},
): Promise<number> {
  const now = options.now ?? Date.now();
  const cutoff = now - (options.keepDays ?? SIGNAL_RETENTION_DAYS) * DAY_MS;
  return db.signals.where('ts').below(cutoff).delete();
}
