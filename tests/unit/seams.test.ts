/**
 * Ghost-marker seams (ADR-0018, ADR-0028). Pure over the ordered block list.
 */

import { describe, expect, it } from 'vitest';
import { computeSeams, type OrderedBlock } from '@/features/visibility/seams';

let n = 0;
function live(): OrderedBlock {
  return { blockId: `live-${n++}`, deleted: false, merged: false, length: 10 };
}
function deleted(): OrderedBlock {
  return { blockId: `del-${n++}`, deleted: true, merged: false, length: 10 };
}
function merged(): OrderedBlock {
  return { blockId: `mrg-${n++}`, deleted: true, merged: true, length: 10 };
}

describe('computeSeams', () => {
  it('has no seams in a document with no deletions', () => {
    const seams = computeSeams([live(), live(), live()]);
    expect(seams.before.size).toBe(0);
    expect(seams.trailing).toEqual([]);
  });

  it('attaches a deletion to the live block that follows it', () => {
    const a = live();
    const gone = deleted();
    const b = live();
    const seams = computeSeams([a, gone, b]);
    expect(seams.before.get(b.blockId)?.map((g) => g.blockId)).toEqual([gone.blockId]);
    expect(seams.before.has(a.blockId)).toBe(false);
    expect(seams.trailing).toEqual([]);
  });

  it('collapses consecutive deletions into one seam (ADR-0018)', () => {
    const a = live();
    const g1 = deleted();
    const g2 = deleted();
    const g3 = deleted();
    const b = live();
    const seams = computeSeams([a, g1, g2, g3, b]);
    expect(seams.before.get(b.blockId)?.map((g) => g.blockId)).toEqual([
      g1.blockId,
      g2.blockId,
      g3.blockId,
    ]);
    expect(seams.before.size).toBe(1);
  });

  it('puts a deletion past the last live block in the trailing seam', () => {
    const a = live();
    const gone = deleted();
    const seams = computeSeams([a, gone]);
    expect(seams.before.size).toBe(0);
    expect(seams.trailing.map((g) => g.blockId)).toEqual([gone.blockId]);
  });

  it('leaves the whole document as a trailing seam when everything is deleted', () => {
    const g1 = deleted();
    const g2 = deleted();
    const seams = computeSeams([g1, g2]);
    expect(seams.trailing.map((g) => g.blockId)).toEqual([g1.blockId, g2.blockId]);
  });

  it('ignores merges: a merged block leaves no ghost (ADR-0028)', () => {
    const a = live();
    const m = merged();
    const b = live();
    const seams = computeSeams([a, m, b]);
    expect(seams.before.size).toBe(0);
    expect(seams.trailing).toEqual([]);
  });

  it('a merge between two deletions does not split their seam', () => {
    // The merge is invisible, so the two real deletions on either side of it
    // still collapse into a single seam before the next live block.
    const a = live();
    const g1 = deleted();
    const m = merged();
    const g2 = deleted();
    const b = live();
    const seams = computeSeams([a, g1, m, g2, b]);
    expect(seams.before.get(b.blockId)?.map((g) => g.blockId)).toEqual([g1.blockId, g2.blockId]);
  });
});
