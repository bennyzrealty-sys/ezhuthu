import { describe, expect, it } from 'vitest';
import {
  clusterBoundaries,
  floorToClusterBoundary,
  graphemeCount,
  graphemes,
  nextClusterBoundary,
  preview,
  previousClusterBoundary,
  snapToClusterBoundary,
  truncateToClusters,
} from '@/text/segmenter';
import { ML_SAMPLES } from './helpers';

const CONJUNCTS = ['ക്ക', 'ന്ത', 'സ്ത്ര', 'ഗ്ദ്ധ', 'ന്ത്യ'];

describe('segmentation', () => {
  it('round-trips losslessly', () => {
    for (const sample of [...ML_SAMPLES, ...CONJUNCTS]) {
      expect(graphemes(sample).join('')).toBe(sample);
    }
  });

  it('counts what a reader sees, not UTF-16 units', () => {
    expect('നി'.length).toBe(2);
    expect(graphemeCount('നി')).toBe(1);
  });

  it('never puts a boundary between a base and its combining mark', () => {
    // Exact conjunct counts are engine-dependent (UAX #29 GB9c landed in
    // Unicode 15.1), so assert the property we actually rely on.
    for (const sample of [...ML_SAMPLES, ...CONJUNCTS]) {
      for (const cluster of graphemes(sample)) {
        expect(cluster).not.toMatch(/^[ാ-്ൗൢൣ]/);
      }
    }
  });

  it('reports boundaries that always start at 0 and end at length', () => {
    for (const sample of ML_SAMPLES) {
      const b = clusterBoundaries(sample);
      expect(b[0]).toBe(0);
      expect(b.at(-1)).toBe(sample.length);
      expect([...b].sort((x, y) => x - y)).toEqual(b);
    }
  });
});

describe('snapping', () => {
  it('leaves an offset that is already a boundary alone', () => {
    const text = ML_SAMPLES[0];
    for (const b of clusterBoundaries(text)) {
      expect(snapToClusterBoundary(text, b)).toBe(b);
    }
  });

  it('pulls an offset inside a cluster onto a boundary', () => {
    // This is the tap-to-caret bug: the browser reports a hit position inside
    // a Malayalam cluster, and placing the caret there makes the cursor jump
    // on the next keystroke.
    const text = 'നിന്ന്';
    const boundaries = new Set(clusterBoundaries(text));
    for (let i = 0; i <= text.length; i++) {
      expect(boundaries.has(snapToClusterBoundary(text, i))).toBe(true);
    }
  });

  it('clamps out-of-range offsets', () => {
    const text = ML_SAMPLES[1];
    expect(snapToClusterBoundary(text, -5)).toBe(0);
    expect(snapToClusterBoundary(text, text.length + 99)).toBe(text.length);
  });

  it('floors rather than rounding when asked', () => {
    const text = 'നിന്ന്';
    for (let i = 0; i <= text.length; i++) {
      const floored = floorToClusterBoundary(text, i);
      expect(floored).toBeLessThanOrEqual(i);
      expect(clusterBoundaries(text)).toContain(floored);
    }
  });
});

describe('cursor movement', () => {
  it('walks backwards one whole cluster at a time', () => {
    const text = 'കടൽ ശാന്തം';
    const visited: number[] = [];
    let at = text.length;
    while (at > 0) {
      const next = previousClusterBoundary(text, at);
      expect(next).toBeLessThan(at);
      at = next;
      visited.push(at);
    }
    expect(at).toBe(0);
    // Every stop is a real boundary — never mid-character.
    const boundaries = new Set(clusterBoundaries(text));
    for (const v of visited) expect(boundaries.has(v)).toBe(true);
  });

  it('walks forwards one whole cluster at a time', () => {
    const text = 'കടൽ ശാന്തം';
    let at = 0;
    let steps = 0;
    while (at < text.length) {
      const next = nextClusterBoundary(text, at);
      expect(next).toBeGreaterThan(at);
      at = next;
      steps++;
    }
    expect(at).toBe(text.length);
    expect(steps).toBe(graphemeCount(text));
  });

  it('does not move past the ends', () => {
    const text = 'അ';
    expect(previousClusterBoundary(text, 0)).toBe(0);
    expect(nextClusterBoundary(text, text.length)).toBe(text.length);
  });
});

describe('truncation', () => {
  it('never cuts a cluster in half', () => {
    // `text.slice(0, 40)` on Malayalam leaves a vowel sign without its base,
    // which renders as a dotted-circle replacement.
    const text = ML_SAMPLES[3];
    const boundaries = new Set(clusterBoundaries(text));

    for (let n = 0; n <= graphemeCount(text); n++) {
      const cut = truncateToClusters(text, n);
      expect(graphemeCount(cut)).toBe(Math.min(n, graphemeCount(text)));
      expect(text.startsWith(cut)).toBe(true);
      // The cut lands on a cluster boundary. Note a cut may legitimately END
      // with a vowel sign — "സ്ത്രീ" does — so what must never happen is the
      // REMAINDER beginning with an orphaned mark.
      expect(boundaries.has(cut.length)).toBe(true);
      expect(text.slice(cut.length)).not.toMatch(/^[ാ-്ൗൢൣ]/);
    }
  });

  it('returns the whole string when the limit exceeds its length', () => {
    expect(truncateToClusters('കടൽ', 100)).toBe('കടൽ');
  });

  it('builds previews with an ellipsis only when it truncated', () => {
    const short = 'കടൽ';
    expect(preview(short, 40)).toBe(short);

    const long = ML_SAMPLES[1];
    const p = preview(long, 5);
    expect(p.endsWith('…')).toBe(true);
    expect(graphemeCount(p.slice(0, -1))).toBe(5);
  });

  it('collapses whitespace in previews', () => {
    expect(preview('ഒന്ന്    രണ്ട്\n\nമൂന്ന്', 100)).toBe('ഒന്ന് രണ്ട് മൂന്ന്');
  });
});
