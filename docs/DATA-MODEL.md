# Data model

Every store, every index, every type — and three worked examples showing an insert, an update and
a delete flowing all the way through the system.

Background: [`ARCHITECTURE.md`](../ARCHITECTURE.md). Rationale: [`DECISIONS.md`](../DECISIONS.md).

## Stores at a glance

| Store | Role | Truth or cache? |
|---|---|---|
| `events` | append-only log of every mutation | **truth** |
| `docs` | document metadata, `seq` counter, watermark | truth (metadata) |
| `blocks` | materialised head state, fast read path | **cache** — rebuildable |
| `snapshots` | materialised past states, time-travel anchors | **cache** — disposable |
| `signals` | attention telemetry | truth (local, non-critical) |
| `settings` | small key/value — chiefly the backup directory handle | truth (non-critical) |

Only `events` and `docs` are irreplaceable. Dropping `blocks` and `snapshots` costs a rebuild,
never data. A backup (ADR-0013) therefore contains `events` + `docs` and nothing else.

## Dexie schema

```ts
db.version(1).stores({
  docs:      'id, updatedAt',
  blocks:    'blockId, [docId+order], [docId+updatedAt], docId',
  events:    'id, &[docId+seq+deviceId], [docId+seq], [docId+blockId+seq], ts',
  snapshots: '[docId+seq], docId, ts',
  signals:   '++id, [docId+blockId], [docId+ts], ts',
  settings:  'key',
});
```

`settings` exists for one reason: the `FileSystemDirectoryHandle` a user picks
for scheduled backups is structured-cloneable but not serialisable, so it can
live in IndexedDB and nowhere else — `localStorage` cannot hold it.

Why each index exists:

| Index | Serves |
|---|---|
| `blocks.[docId+order]` | the virtualiser's ordered range query — the hottest read in the app |
| `blocks.[docId+updatedAt]` | "most recently edited" for resume destination 1 |
| `events.&[docId+seq+deviceId]` | uniqueness; catches a duplicate-`seq` bug immediately (ADR-0020) |
| `events.[docId+seq]` | replay in order; find log head |
| `events.[docId+blockId+seq]` | walking one block's history — required by the corpus exporter (ADR-0012) |
| `events.ts` | "what changed since" time filters |
| `snapshots.[docId+seq]` | find the nearest anchor at or before a target `seq` |
| `signals.[docId+blockId]` | aggregate dwell and revision signals per block |

## Types

```ts
type DocId    = string;   // uuid
type BlockId  = string;   // uuid
type OrderKey = string;   // fractional index — LEXICOGRAPHIC, never numeric (ADR-0007)
```

### `Doc`

```ts
interface Doc {
  id: DocId;
  title: string;
  createdAt: number;
  updatedAt: number;

  seqCounter: number;      // next seq to allocate; bumped in-transaction (ADR-0020)
  lastAppliedSeq: number;  // watermark proving `blocks` is in step with the log (ADR-0008)

  blockCount: number;      // denormalised, excludes soft-deleted
  wordCount: number;       // denormalised, recomputed per changed block only

  persistGranted?: boolean;  // result of navigator.storage.persist() (ADR-0013)
  lastBackupAt?: number;     // drives the backup nag
}
```

`seqCounter` and `lastAppliedSeq` are the two fields that make the whole thing safe. They are only
ever written inside the append transaction.

### `Block`

```ts
interface Block {
  blockId: BlockId;
  docId: DocId;
  order: OrderKey;            // string; compare lexicographically
  text: string;
  createdAt: number;
  updatedAt: number;
  revisionCount: number;      // count of `update` events; rebuilt on replay
  deletedAt?: number;         // soft delete (ADR-0018)
  meta: Record<string, unknown>;  // extension point — block type tags, `locked`
}
```

`meta` is persisted from day one and is always present (`{}` when empty), so later features do not
need a schema migration over a manuscript's worth of records.

### `BlockEvent`

```ts
interface BlockEvent {
  id: string;          // uuid — event identity
  seq: number;         // monotonic per document (ADR-0020)
  ts: number;          // epoch ms — wall clock, for display and decay only, NEVER for ordering
  sessionId: string;   // one app session; used by corpus coalescing (ADR-0012)
  deviceId: string;    // stable per install; part of the sort key
  docId: DocId;
  blockId: BlockId;
  type: 'insert' | 'update' | 'delete' | 'move';
  payload: {
    text?: string;           // insert, update, delete (delete keeps full text)
    prevText?: string;       // OPTIONAL — only when not derivable (ADR-0012)
    afterBlockId?: string | null;  // insert, move — intent; null means "first"
  };
}
```

Two things about this shape are deliberate and easy to get wrong:

**`ts` never orders anything.** Wall clocks move backwards — NTP correction, daylight saving,
manual change. Ordering is `(seq, deviceId)` via the single comparator in `core/order.ts`. `ts` is
for display and for time decay only.

**`afterBlockId` records intent, not outcome.** The event says *where the writer put the block*;
the order key is derived at fold time from the neighbours then present. Deterministic, so replay
reproduces identical keys, and it keeps position meaningful rather than baking in a value that
depends on when the event was appended.

### `Snapshot`

```ts
interface Snapshot {
  docId: DocId;
  seq: number;        // state as of, and including, this seq
  ts: number;
  blocks: Block[];    // full materialised state
}
```

### `Signal`

```ts
interface Signal {
  id?: number;
  docId: DocId;
  blockId: BlockId;
  ts: number;
  sessionId: string;
  kind: 'dwell' | 'hesitation' | 'backspace' | 'scrollback';
  value: number;      // dwell/hesitation: ms. backspace: count. scrollback: dwell ms after return.
}
```

See [`SIGNALS.md`](SIGNALS.md) for what each measures and the attention model that gates dwell.

---

## Worked example 1 — inserting a block

The writer is at the end of paragraph `B` and presses Enter, then types
`കടൽ ശാന്തമായിരുന്നു.` ("The sea was calm.")

**Starting state.** Two blocks:

| blockId | order | text |
|---|---|---|
| `blk-A` | `a0` | `ഒന്നാം ഖണ്ഡിക.` |
| `blk-B` | `a1` | `രണ്ടാം ഖണ്ഡിക.` |

`doc.seqCounter = 42`, `doc.lastAppliedSeq = 41`.

**1. The editor calls** `appendEvent({type:'insert', blockId:'blk-C', afterBlockId:'blk-B', text:'കടൽ ശാന്തമായിരുന്നു.'})`

**2. One transaction opens over `docs`, `events`, `blocks`.**

**3. `seq` is allocated** — `doc.seqCounter` 42 → 43; this event takes `seq = 42`.

**4. The event is appended:**

```json
{
  "id": "ev-7f3a…", "seq": 42, "ts": 1754745600000,
  "sessionId": "ses-91b…", "deviceId": "dev-004…",
  "docId": "doc-1", "blockId": "blk-C", "type": "insert",
  "payload": { "text": "കടൽ ശാന്തമായിരുന്നു.", "afterBlockId": "blk-B" }
}
```

Note there is no `order` in the payload and no `prevText` — an insert has no previous text.

**5. `fold()` applies it.** It resolves `afterBlockId: 'blk-B'` to a position: predecessor `blk-B`
has order `a1`, and there is no successor, so the new key is `generateKeyBetween('a1', null)` =
`a2`. It writes:

```json
{ "blockId":"blk-C", "docId":"doc-1", "order":"a2",
  "text":"കടൽ ശാന്തമായിരുന്നു.",
  "createdAt":1754745600000, "updatedAt":1754745600000,
  "revisionCount":0, "meta":{} }
```

**6. The watermark advances** — `doc.lastAppliedSeq = 42`, `blockCount` 2 → 3, `wordCount` += 2.

**7. The transaction commits.** All of it, or none of it.

Had the writer instead inserted *between* A and B, step 5 would compute
`generateKeyBetween('a0','a1')` = `a0V`, and **no other block record would be touched** — that is
the whole point of ADR-0007. With integer ordering this insert would have rewritten every block
after it.

## Worked example 2 — updating a block

The writer revises `blk-C` to `കടൽ ശാന്തമായിരുന്നു, അസ്വാഭാവികമാം വിധം.`
("The sea was calm, unnaturally so.")

**1.** Typing changes nothing durable. The focused editor holds a local draft string; the change
handler stores it and returns. No storage, no counting, no signals on the keystroke path.

**2.** Composition ends (ADR-0010) and 400 ms of quiet pass. Now `commitBlock` runs.

**3.** One transaction. `seq = 43` allocated.

```json
{
  "id":"ev-88c1…", "seq":43, "ts":1754745720000,
  "sessionId":"ses-91b…", "deviceId":"dev-004…",
  "docId":"doc-1", "blockId":"blk-C", "type":"update",
  "payload": { "text":"കടൽ ശാന്തമായിരുന്നു, അസ്വാഭാവികമാം വിധം." }
}
```

**`prevText` is absent, and that is correct.** The previous text is `ev-7f3a`'s `text` — already in
the log, indexed by `[docId+blockId+seq]`. Storing it again would double the log for no
information (ADR-0012).

**4. `fold()` updates the block:** new `text`, `updatedAt = 1754745720000`, `revisionCount` 0 → 1.
`order` and `createdAt` are untouched.

**5.** Watermark to 43; `wordCount` adjusted by this block's delta only.

**What this single event now powers, with no further storage:**

- the margin bar beside `blk-C`, at 100% opacity for the next hour, then decaying (ADR-0006)
- a tick in the minimap bucket containing `blk-C` (ADR-0021)
- resume destination 1, "last edited"
- resume destination 4, via `revisionCount`
- one (before, after) pair in the corpus export, derived by walking back to `seq 42` (ADR-0016)

## Worked example 3 — deleting a block

The writer deletes `blk-B`.

**1.** `seq = 44`. The delete event carries **the full text**:

```json
{
  "id":"ev-9d02…", "seq":44, "ts":1754745900000,
  "sessionId":"ses-91b…", "deviceId":"dev-004…",
  "docId":"doc-1", "blockId":"blk-B", "type":"delete",
  "payload": { "text":"രണ്ടാം ഖണ്ഡിക." }
}
```

Full text here is deliberate and is the one exception to ADR-0012's omission rule. A deletion is
the event we can least afford to lose, and ghost-marker restore reads it directly rather than
reconstructing it.

**2. `fold()` soft-deletes:** sets `deletedAt = 1754745900000`. The record stays, the text stays,
the order key stays (ADR-0018).

**3.** `blockCount` 3 → 2; `wordCount` -= 2.

**Rendering.** `blk-B` is excluded — via the single accessor that filters `deletedAt`, which is
the only way blocks are ever read. A 2 px seam renders at the join between `blk-A` and `blk-C`.
Tapping reveals `രണ്ടാം ഖണ്ഡിക.`; tapping again restores it by appending an ordinary `insert`
event, which participates in history like any other change.

## Reading the document

Cold open, the common path:

```
1. docs.get(docId)                                   → 1 indexed get
2. lastAppliedSeq === max(events[docId].seq)?        → 1 indexed lookup
3. yes → blocks.where('[docId+order]').between(…)    → 1 indexed range query
```

**No replay.** ADR-0009: snapshots are not on this path. If step 2 fails — a crash mid-transaction
— replay the tail from `lastAppliedSeq` before trusting the projection.

Reconstructing a *past* state, which is what the time-lapse scrub needs, is different:

```
1. nearest snapshot at or before target seq
2. replay events in (snapshot.seq, targetSeq] through the same fold()
3. run it in a Worker
```

Both paths call the identical `fold()`. That is why the projection cannot drift from the log.

## What a backup contains

```json
{
  "format": "ezhuthu-backup",
  "version": 1,
  "exportedAt": 1754746000000,
  "docs": [ /* Doc records */ ],
  "events": [ /* every BlockEvent, ordered by (seq, deviceId) */ ]
}
```

No `blocks`, no `snapshots` — both are derivable, and including them would inflate the file with
data the log already contains. Restore replays the log and rebuilds both.

Plain JSON, readable and restorable without this application. For a file holding someone's book,
that is the right format.
