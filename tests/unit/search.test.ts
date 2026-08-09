/**
 * Search matching (ADR-0015). The Malayalam strings are the ones in
 * docs/MALAYALAM.md — keep the two in sync.
 *
 * The offset assertions matter as much as the match assertions. Folding
 * changes length, so a search that reports folded offsets highlights the wrong
 * characters — and only in Malayalam, and only further into the paragraph.
 */

import { describe, expect, it } from 'vitest';
import {
  compileQuery,
  countMatches,
  excerptAround,
  findMatches,
  hasMatch,
  type CompiledQuery,
} from '@/text/search';
import { ZWJ, ZWNJ } from '@/text/normalize';

const ATOMIC_CHILLU_N = 'അവൻ';
const SEQUENCE_CHILLU_N = 'അവന്‍';
const COMPOSED_OO = 'പോയി';
const DECOMPOSED_OO = 'പോയി';

function query(needle: string, options: Partial<Parameters<typeof compileQuery>[0]> = {}) {
  const compiled = compileQuery({ needle, ...options });
  if (compiled === null) throw new Error(`empty query: ${JSON.stringify(needle)}`);
  return compiled;
}

/** What the reported offsets actually select out of the source. */
function selected(source: string, q: CompiledQuery): string[] {
  return findMatches(source, q).map((m) => source.slice(m.start, m.end));
}

describe('finding what the reader can see', () => {
  it('finds an atomic-chillu word written as a ZWJ sequence', () => {
    // The reason this feature works at all. Both forms are on screen as
    // "അവൻ"; only one of them is in the bytes.
    const haystack = `${SEQUENCE_CHILLU_N} ഒരു എഴുത്തുകാരൻ ആണ്.`;
    expect(hasMatch(haystack, query(ATOMIC_CHILLU_N))).toBe(true);
  });

  it('finds a ZWJ-sequence word written atomically', () => {
    const haystack = `${ATOMIC_CHILLU_N} ഒരു എഴുത്തുകാരൻ ആണ്.`;
    expect(hasMatch(haystack, query(SEQUENCE_CHILLU_N))).toBe(true);
  });

  it('finds a word typed on the other keyboard', () => {
    expect(hasMatch(`അവൻ ${DECOMPOSED_OO}.`, query(COMPOSED_OO))).toBe(true);
    expect(hasMatch(`അവൻ ${COMPOSED_OO}.`, query(DECOMPOSED_OO))).toBe(true);
  });

  it('still distinguishes words that differ only by ZWNJ', () => {
    // Folding must not go so far that it merges two different words.
    expect(hasMatch('കല്പന', query(`കൽ${ZWNJ}പന`))).toBe(false);
  });

  it('does not match a raw substring search would miss going the other way', () => {
    expect(`${SEQUENCE_CHILLU_N} ആണ്`.includes(ATOMIC_CHILLU_N)).toBe(false);
  });
});

describe('offsets point into the original text', () => {
  it('selects the ZWJ sequence when the needle was atomic', () => {
    const source = `ഇന്ന് ${SEQUENCE_CHILLU_N} വന്നു.`;
    const matches = findMatches(source, query(ATOMIC_CHILLU_N));

    expect(matches).toHaveLength(1);
    // Five codepoints in the source for four in the folded form. Reporting the
    // folded offsets here would put the highlight one character short.
    expect(source.slice(matches[0]!.start, matches[0]!.end)).toBe(SEQUENCE_CHILLU_N);
  });

  it('selects the decomposed form when the needle was composed', () => {
    const source = `അവൻ ${DECOMPOSED_OO} ആണ്`;
    expect(selected(source, query(COMPOSED_OO))).toEqual([DECOMPOSED_OO]);
  });

  it('does not drift over a long Malayalam prefix', () => {
    // The failure mode this guards: the error accumulates with every folded
    // cluster before the match, so a match late in a paragraph is off by more
    // than one early in it.
    const prefix = `${SEQUENCE_CHILLU_N} `.repeat(30);
    const source = `${prefix}കടൽ`;
    const matches = findMatches(source, query('കടൽ'));

    expect(matches).toHaveLength(1);
    expect(matches[0]!.start).toBe(prefix.length);
    expect(source.slice(matches[0]!.start, matches[0]!.end)).toBe('കടൽ');
  });

  it('never bisects a grapheme cluster', () => {
    // A needle matching only part of a cluster resolves out to the whole
    // cluster, so a highlight can never sever a vowel sign from its base.
    const source = 'നിന്ന്';
    for (const match of findMatches(source, query('ന'))) {
      const slice = source.slice(match.start, match.end);
      expect(slice).not.toMatch(/^[ാ-്ൗൢൣ]/);
    }
  });
});

describe('multiple matches', () => {
  const source = 'മഴ പെയ്തു. മഴ നിന്നു. മഴ വീണ്ടും.';

  it('finds all of them', () => {
    expect(countMatches(source, query('മഴ'))).toBe(3);
    expect(selected(source, query('മഴ'))).toEqual(['മഴ', 'മഴ', 'മഴ']);
  });

  it('does not overlap', () => {
    const matches = findMatches('aaaa', query('aa'));
    expect(matches).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });

  it('respects a limit', () => {
    expect(findMatches(source, query('മഴ'), 2)).toHaveLength(2);
    expect(findMatches(source, query('മഴ'), 0)).toHaveLength(0);
  });
});

describe('case', () => {
  it('ignores case by default, for the Latin inside Malayalam prose', () => {
    const source = 'അവൻ ഒരു Software Engineer ആണ്.';
    expect(hasMatch(source, query('software'))).toBe(true);
    expect(selected(source, query('software'))).toEqual(['Software']);
  });

  it('respects case when asked', () => {
    const source = 'അവൻ ഒരു Software Engineer ആണ്.';
    expect(hasMatch(source, query('software', { caseSensitive: true }))).toBe(false);
    expect(hasMatch(source, query('Software', { caseSensitive: true }))).toBe(true);
  });

  it('leaves Malayalam unaffected either way', () => {
    expect(hasMatch('കടൽ', query('കടൽ', { caseSensitive: true }))).toBe(true);
    expect(hasMatch('കടൽ', query('കടൽ'))).toBe(true);
  });
});

describe('whole word', () => {
  it('matches a standalone word', () => {
    expect(hasMatch('മഴ പെയ്തു', query('മഴ', { wholeWord: true }))).toBe(true);
  });

  it('rejects the same letters inside a longer word', () => {
    expect(hasMatch('മഴയത്ത്', query('മഴ', { wholeWord: true }))).toBe(false);
    expect(hasMatch('മഴയത്ത്', query('മഴ'))).toBe(true);
  });

  it('treats the joiners as inside a word, not as boundaries', () => {
    /*
     * Rule 3: ZWJ and ZWNJ are not whitespace and not separators. If they
     * counted as word boundaries, a whole-word search would report hits in the
     * middle of longer words — `കൽ` inside `കൽ‌പന`, `അവൻ` inside `അവൻ‍റെ` —
     * which is the failure a whole-word search exists to avoid.
     *
     * Both haystacks keep their joiner through the fold: ZWNJ is never folded,
     * and a ZWJ after an *atomic* chillu is not part of a foldable sequence.
     */
    expect(hasMatch(`കൽ${ZWNJ}പന`, query('കൽ', { wholeWord: true }))).toBe(false);
    expect(hasMatch(`അവൻ${ZWJ}റെ`, query('അവൻ', { wholeWord: true }))).toBe(false);

    // Without the whole-word constraint both are ordinary substring hits.
    expect(hasMatch(`കൽ${ZWNJ}പന`, query('കൽ'))).toBe(true);
  });

  it('finds a match that overlaps a rejected one', () => {
    /*
     * A needle containing a separator can have a real match starting inside a
     * candidate that was just rejected. Resuming at the end of the rejected
     * candidate — the obvious thing to write — skips it: here the only match
     * is at offset 3, inside the rejected candidate spanning 1..4.
     */
    expect(countMatches('xa a a', query('a a', { wholeWord: true }))).toBe(1);
  });

  it('counts punctuation as a boundary', () => {
    expect(hasMatch('കടൽ, ശാന്തം', query('കടൽ', { wholeWord: true }))).toBe(true);
    expect(hasMatch('(കടൽ)', query('കടൽ', { wholeWord: true }))).toBe(true);
  });
});

describe('empty queries', () => {
  it('are a state, not an error', () => {
    expect(compileQuery({ needle: '' })).toBeNull();
    expect(compileQuery({ needle: ZWJ })).not.toBeNull();
  });

  it('do not trim a deliberate space', () => {
    expect(compileQuery({ needle: ' ' })).not.toBeNull();
    expect(countMatches('a b c', query(' '))).toBe(2);
  });
});

describe('excerpts', () => {
  const long = 'ഒന്നാം ഖണ്ഡിക ഇവിടെ തുടങ്ങുന്നു. '.repeat(6) + 'കടൽ ശാന്തമായിരുന്നു.';

  it('centres the match and reports where it landed', () => {
    const match = findMatches(long, query('കടൽ'))[0]!;
    const excerpt = excerptAround(long, match, 10);

    expect(excerpt.text.slice(excerpt.matchStart, excerpt.matchEnd)).toBe('കടൽ');
    expect(excerpt.elidedBefore).toBe(true);
    expect(long).toContain(excerpt.text);
  });

  it('does not elide what fits', () => {
    const source = 'കടൽ ശാന്തം';
    const excerpt = excerptAround(source, findMatches(source, query('കടൽ'))[0]!, 40);

    expect(excerpt.text).toBe(source);
    expect(excerpt.elidedBefore).toBe(false);
    expect(excerpt.elidedAfter).toBe(false);
  });

  it('cuts only on cluster boundaries', () => {
    // Slicing by character count here is what produces a dotted circle where a
    // vowel sign lost its base.
    const source = 'നിനിനിനിനിനി കടൽ നിനിനിനിനിനി';
    const excerpt = excerptAround(source, findMatches(source, query('കടൽ'))[0]!, 3);
    const clusters = [...new Intl.Segmenter('ml', { granularity: 'grapheme' }).segment(source)];

    expect(clusters.some((c) => c.index === source.indexOf(excerpt.text))).toBe(true);
    expect(excerpt.text).not.toMatch(/^[ാ-്ൗൢൣ]/);
  });

  it('handles a match at the very start and the very end', () => {
    const source = 'കടൽ ശാന്തമായിരുന്നു';
    const first = excerptAround(source, findMatches(source, query('കടൽ'))[0]!, 2);
    expect(first.matchStart).toBe(0);
    expect(first.elidedBefore).toBe(false);

    const last = excerptAround(source, findMatches(source, query('ന്നു'))[0]!, 2);
    expect(last.elidedAfter).toBe(false);
    expect(last.text.slice(last.matchStart, last.matchEnd)).toBe('ന്നു');
  });
});
