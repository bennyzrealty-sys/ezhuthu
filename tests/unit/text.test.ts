/**
 * Malayalam correctness. The strings here are the ones documented in
 * docs/MALAYALAM.md — keep the two in sync.
 */

import { describe, expect, it } from 'vitest';
import {
  equals,
  foldChillu,
  includes,
  normalizeForCompare,
  ZWJ,
  ZWNJ,
} from '@/text/normalize';
import { countGraphemes, countWords, isEffectivelyEmpty } from '@/text/count';

// Built from codepoints so the distinction survives any editor that might
// normalise this file on save.
const ATOMIC_CHILLU_N = 'അവൻ'; // അവൻ
const SEQUENCE_CHILLU_N = 'അവന്‍'; // അവന്‍

const COMPOSED_OO = 'പോയി'; // പോയി
const DECOMPOSED_OO = 'പോയി'; // പെ + ാ ...

describe('chillu folding', () => {
  it('treats atomic chillu and its ZWJ sequence as equal', () => {
    expect(equals(ATOMIC_CHILLU_N, SEQUENCE_CHILLU_N)).toBe(true);
  });

  it('confirms NFC alone does NOT unify them', () => {
    // This is the whole reason foldChillu exists. Unicode added the atomic
    // chillu characters specifically so the forms stay distinct, so no
    // normalisation form will merge them. If someone "simplifies"
    // normalizeForCompare down to .normalize('NFC'), this fails loudly.
    expect(ATOMIC_CHILLU_N.normalize('NFC')).not.toBe(SEQUENCE_CHILLU_N.normalize('NFC'));
  });

  it('folds every chillu in the set', () => {
    const cases: Array<[sequence: string, atomic: string]> = [
      ['ണ്‍', 'ൺ'], // ണ → ൺ
      ['ന്‍', 'ൻ'], // ന → ൻ
      ['ര്‍', 'ർ'], // ര → ർ
      ['ല്‍', 'ൽ'], // ല → ൽ
      ['ള്‍', 'ൾ'], // ള → ൾ
      ['ക്‍', 'ൿ'], // ക → ൿ
    ];
    for (const [sequence, atomic] of cases) {
      expect(foldChillu(sequence)).toBe(atomic);
      expect(equals(sequence, atomic)).toBe(true);
    }
  });

  it('leaves text without ZWJ untouched', () => {
    const plain = 'കടൽ ശാന്തമായിരുന്നു.';
    expect(foldChillu(plain)).toBe(plain);
  });

  it('does not fold a virama that is not followed by ZWJ', () => {
    // ന + virama + ത is the conjunct ന്ത, not a chillu. Folding it would
    // change the word.
    const conjunct = 'ന്ത';
    expect(foldChillu(conjunct)).toBe(conjunct);
  });

  it('finds a chillu word typed in the other form', () => {
    const haystack = `${SEQUENCE_CHILLU_N} ഒരു എഴുത്തുകാരൻ ആണ്.`;
    expect(includes(haystack, ATOMIC_CHILLU_N)).toBe(true);
  });
});

describe('NFC normalisation', () => {
  it('unifies composed and decomposed vowel signs', () => {
    // This is the case NFC genuinely solves. Two keyboards, same word.
    expect(COMPOSED_OO).not.toBe(DECOMPOSED_OO);
    expect(equals(COMPOSED_OO, DECOMPOSED_OO)).toBe(true);
  });

  it('is idempotent', () => {
    const once = normalizeForCompare(DECOMPOSED_OO);
    expect(normalizeForCompare(once)).toBe(once);
  });
});

describe('ZWNJ', () => {
  const WITH_ZWNJ = `കൽ${ZWNJ}പന`;
  const WITHOUT = 'കൽപന';

  it('distinguishes words that differ only by ZWNJ', () => {
    // Different words visually — the chandrakkala form versus the conjunct.
    expect(equals(WITH_ZWNJ, WITHOUT)).toBe(false);
  });

  it('does not treat ZWNJ as a word separator', () => {
    expect(countWords(WITH_ZWNJ)).toBe(1);
  });

  it('does not treat ZWJ as a word separator', () => {
    expect(countWords(SEQUENCE_CHILLU_N)).toBe(1);
  });

  it('survives normalisation', () => {
    expect(normalizeForCompare(WITH_ZWNJ)).toContain(ZWNJ);
  });
});

describe('word counting', () => {
  it('counts Malayalam words', () => {
    expect(countWords('കടൽ ശാന്തമായിരുന്നു.')).toBe(2);
    expect(countWords('വർഷം തോറും മഴ പെയ്യുന്നു.')).toBe(4);
  });

  it('counts across a script boundary', () => {
    expect(countWords('അവൻ ഒരു software engineer ആണ്.')).toBe(5);
    expect(countWords('2024-ൽ 15 ശതമാനം വർധന.')).toBe(4);
  });

  it('is stable regardless of input encoding', () => {
    expect(countWords(ATOMIC_CHILLU_N)).toBe(countWords(SEQUENCE_CHILLU_N));
    expect(countWords(COMPOSED_OO)).toBe(countWords(DECOMPOSED_OO));
  });

  it('handles empty and whitespace-only input', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   \n  ')).toBe(0);
  });

  it('collapses runs of whitespace', () => {
    expect(countWords('ഒന്ന്    രണ്ട്\n\nമൂന്ന്')).toBe(3);
  });
});

describe('grapheme counting', () => {
  it('counts what a reader sees, not codepoints', () => {
    // "നി" is one character to a reader and two UTF-16 units. Indexing raw
    // offsets here is what splits a base consonant from its vowel sign.
    const ni = 'നി';
    expect(ni.length).toBe(2);
    expect(countGraphemes(ni)).toBe(1);
  });

  it('never splits a base from its combining mark', () => {
    // Exact conjunct cluster counts are engine-dependent (UAX #29 GB9c
    // arrived in Unicode 15.1), so we assert the property we actually rely
    // on rather than a number that varies by ICU version.
    const samples = ['ക്ക', 'ന്ത', 'സ്ത്ര', 'ഗ്ദ്ധ', 'ന്ത്യ', 'കടൽ ശാന്തമായിരുന്നു.'];
    const segmenter = new Intl.Segmenter('ml', { granularity: 'grapheme' });

    for (const sample of samples) {
      const clusters = [...segmenter.segment(sample)].map((s) => s.segment);
      // Round trip is lossless.
      expect(clusters.join('')).toBe(sample);
      // No cluster begins with a combining mark or a virama — that would mean
      // a boundary fell inside a character.
      for (const cluster of clusters) {
        expect(cluster).not.toMatch(/^[ാ-്ൗൢൣ]/);
      }
    }
  });

  it('counts mixed script', () => {
    expect(countGraphemes('ok')).toBe(2);
    expect(countGraphemes('')).toBe(0);
  });
});

describe('isEffectivelyEmpty', () => {
  it('ignores zero-width joiners', () => {
    expect(isEffectivelyEmpty('')).toBe(true);
    expect(isEffectivelyEmpty('   ')).toBe(true);
    expect(isEffectivelyEmpty(ZWJ + ZWNJ)).toBe(true);
    expect(isEffectivelyEmpty('അ')).toBe(false);
  });
});
