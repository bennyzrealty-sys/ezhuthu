import { describe, expect, it } from 'vitest';
import { clusterChange, clusterDistance } from '@/text/distance';
import { ZWJ, ZWNJ } from '@/text/normalize';

/** The two encodings of അവൻ from docs/MALAYALAM.md. */
const CHILLU_ATOMIC = 'അവൻ';
const CHILLU_SEQUENCE = `അവന്${ZWJ}`;

describe('cluster distance', () => {
  it('is zero for identical text', () => {
    expect(clusterDistance('കടൽ ശാന്തമായിരുന്നു.', 'കടൽ ശാന്തമായിരുന്നു.')).toBe(0);
  });

  it('is symmetric', () => {
    const a = 'അവൻ ഒരു software engineer ആണ്.';
    const b = 'അവൻ ഒരു നല്ല software engineer ആണ്.';
    expect(clusterDistance(a, b)).toBe(clusterDistance(b, a));
  });

  it('counts a Malayalam character as one edit, not two code units', () => {
    // നി is two UTF-16 code units and one character to the reader (Rule 1). A
    // code-unit distance reports 2 here, which is what makes a shared threshold
    // mean different things in Malayalam and English.
    expect(clusterDistance('നി', 'ന')).toBe(1);
    expect(clusterDistance('കാ', 'ക')).toBe(1);
  });

  it('sees no change between the two encodings of the same word', () => {
    // Rule 5. Re-encoding is not revision: a keyboard change that rewrites
    // every chillu in a manuscript must not read as an edit to every paragraph.
    expect(CHILLU_ATOMIC).not.toBe(CHILLU_SEQUENCE);
    expect(clusterDistance(CHILLU_ATOMIC, CHILLU_SEQUENCE)).toBe(0);
    expect(clusterChange(CHILLU_ATOMIC, CHILLU_SEQUENCE).ratio).toBe(0);
  });

  it('sees no change between composed and decomposed vowel signs', () => {
    expect(clusterDistance('പോയി', 'പോയി')).toBe(0);
  });

  it('does see a change when ZWNJ suppresses a conjunct', () => {
    // കൽപന and കല്പന are different words on screen (Rule 3), so this is a real
    // edit however small it looks in bytes.
    const withZwnj = `കല്${ZWNJ}പന`;
    const conjunct = 'കല്പന';
    expect(clusterDistance(withZwnj, conjunct)).toBeGreaterThan(0);
  });

  it('handles four-consonant stacks without splitting them', () => {
    // ഗ്ദ്ധ is one cluster the reader sees as one character; replacing it is one
    // edit, not four.
    expect(clusterDistance('ഗ്ദ്ധ എന്ന കൂട്ടക്ഷരം.', 'ക എന്ന കൂട്ടക്ഷരം.')).toBe(1);
  });

  it('measures insertion and deletion at the ends', () => {
    expect(clusterDistance('മഴ പെയ്യുന്നു', 'മഴ പെയ്യുന്നു.')).toBe(1);
    expect(clusterDistance('', 'കടൽ')).toBe(3);
    expect(clusterDistance('കടൽ', '')).toBe(3);
    expect(clusterDistance('', '')).toBe(0);
  });

  it('reports the fraction of the longer side that changed', () => {
    const change = clusterChange('കടൽ', 'കടലുകൾ');
    // ക ട ലു ക ൾ — five clusters, not six codepoints.
    expect(change.clusters).toBe(5);
    expect(change.ratio).toBeCloseTo(change.distance / 5);
  });

  it('stops early once the cutoff is exceeded', () => {
    const a = 'കടൽ ശാന്തമായിരുന്നു. '.repeat(50);
    const b = 'വർഷം തോറും മഴ പെയ്യുന്നു. '.repeat(50);

    // The exact distance is large and uninteresting; all the filter needs is
    // that it is past the threshold.
    const change = clusterChange(a, b, { max: 4 });
    expect(change.exceeded).toBe(true);
    expect(change.distance).toBe(5);
  });

  it('agrees with the exact distance when the cutoff is not reached', () => {
    const a = 'അവൻ ഒരു software engineer ആണ്.';
    const b = 'അവൻ ഒരു software engineers ആണ്.';
    const exact = clusterDistance(a, b);
    expect(exact).toBe(1);
    expect(clusterDistance(a, b, { max: 4 })).toBe(exact);
    expect(clusterChange(a, b, { max: 4 }).exceeded).toBe(false);
  });

  it('rejects a pure length difference without walking the table', () => {
    const a = 'ക';
    const b = 'ക'.repeat(500);
    expect(clusterDistance(a, b, { max: 3 })).toBe(4);
  });

  it('is unaffected by how much identical text surrounds the change', () => {
    // Common affixes are trimmed, so a one-word fix in a long paragraph costs
    // the same as a one-word fix in a short one — and reports the same
    // distance.
    const prefix = 'സ്ത്രീകൾ ന്യായം ചോദിച്ചു. '.repeat(20);
    const suffix = ' ഗ്ദ്ധ എന്ന കൂട്ടക്ഷരം.'.repeat(20);
    expect(clusterDistance(`${prefix}മരം${suffix}`, `${prefix}മലം${suffix}`)).toBe(1);
  });
});
