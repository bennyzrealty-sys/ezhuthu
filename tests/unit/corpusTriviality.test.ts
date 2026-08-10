import { describe, expect, it } from 'vitest';
import { filterTrivial, isTrivial, trivialReason } from '@/features/io/corpus/triviality';
import { ZWJ, ZWNJ } from '@/text/normalize';

const pair = (before: string, after: string) => ({ before, after });

describe('what the corpus filter drops', () => {
  it('drops a re-encoding that changed no word on screen', () => {
    // അവൻ atomic against അവൻ as the ZWJ sequence — identical to the reader,
    // different bytes in storage. A keyboard change rewrites every chillu in a
    // manuscript, and unfiltered that arrives as a revision to every paragraph
    // containing one.
    expect(trivialReason(pair('അവൻ വന്നു.', `അവന്${ZWJ} വന്നു.`))).toBe('unchanged');
  });

  it('drops a decomposed vowel sign recomposed', () => {
    expect(trivialReason(pair('പോയി', 'പോയി'))).toBe('unchanged');
  });

  it('drops a burst that was typed and then undone', () => {
    // Coalescing collapses the run; this is what makes the result disappear
    // rather than arrive as before === after.
    expect(trivialReason(pair('കടൽ ശാന്തം.', 'കടൽ ശാന്തം.'))).toBe('unchanged');
  });

  it('drops writing a paragraph from nothing and emptying one', () => {
    expect(trivialReason(pair('', 'കടൽ ശാന്തമായിരുന്നു.'))).toBe('empty');
    expect(trivialReason(pair('കടൽ ശാന്തമായിരുന്നു.', '   '))).toBe('empty');
    expect(trivialReason(pair('കടൽ', ZWNJ))).toBe('empty');
  });

  it('drops a one-character correction', () => {
    expect(trivialReason(pair('മരം വളർന്നു.', 'മലം വളർന്നു.'))).toBe('single-cluster');
    expect(trivialReason(pair('അവന് ഒരു വീട്.', 'അവനു ഒരു വീട്.'))).toBe('single-cluster');
  });

  it('drops a change that only moved spacing and punctuation', () => {
    expect(trivialReason(pair('കടൽ ശാന്തം . മഴ ഇല്ല .', 'കടൽ ശാന്തം. മഴ ഇല്ല.'))).toBe(
      'punctuation',
    );
    expect(trivialReason(pair('ഒന്ന്  രണ്ട്   മൂന്ന്', 'ഒന്ന് രണ്ട് മൂന്ന്'))).toBe('punctuation');
  });

  it('drops a small correction inside a long paragraph that moved no words', () => {
    // Two clusters, so the single-cluster rule does not reach it; the words are
    // the same in number, so nothing was added or taken away.
    const long = 'സ്ത്രീകൾ ന്യായം ചോദിച്ചു. '.repeat(20);
    expect(trivialReason(pair(`${long}അവർ ചോദിച്ചു.`, `${long}അവൾ ചോദിച്ചൂ.`))).toBe(
      'sub-threshold',
    );
  });
});

describe('what the corpus filter keeps', () => {
  it('keeps a rewritten sentence', () => {
    expect(
      trivialReason(
        pair('അവൻ ഒരു എഴുത്തുകാരൻ ആണ്.', 'അവൻ വാക്കുകൾ കൊണ്ട് ജീവിക്കുന്ന ഒരാളാണ്.'),
      ),
    ).toBeNull();
  });

  it('keeps a clause added to a sentence', () => {
    expect(
      trivialReason(pair('കടൽ ശാന്തമായിരുന്നു.', 'കടൽ ശാന്തമായിരുന്നു, കാറ്റ് നിലച്ചിരുന്നു.')),
    ).toBeNull();
  });

  it('keeps a word swapped in a sentence-length paragraph', () => {
    // The proportional threshold is what decides this, and it decides it
    // differently in a page — see the note on TRIVIAL_MAX_RATIO.
    expect(trivialReason(pair('മരം വളർന്നു.', 'വൃക്ഷം വളർന്നു.'))).toBeNull();
  });

  it('keeps a ZWNJ change, and never calls it punctuation', () => {
    // കല്‌പന and കല്പന are different words on screen (Rule 3). ZWNJ therefore
    // survives the punctuation skeleton on purpose: strip it, and a paragraph
    // respelled throughout disappears from the corpus as "only punctuation
    // moved". Two clusters apart, so the single-cluster rule does not reach it
    // either.
    const respelled = pair(`അവളുടെ കല്${ZWNJ}പന ശരിയായിരുന്നു.`, 'അവളുടെ കല്പന ശരിയായിരുന്നു.');
    expect(trivialReason(respelled)).toBeNull();
  });

  it('keeps a word struck out of a long paragraph', () => {
    // Sub-threshold in size, and would be dropped on that alone — but a word
    // went, so the boundaries moved and this is a decision, not a correction.
    const long = 'വർഷം തോറും മഴ പെയ്യുന്നു. '.repeat(20);
    expect(trivialReason(pair(`${long}കാറ്റും ശക്തമായിരുന്നു.`, `${long}ശക്തമായിരുന്നു.`))).toBeNull();
  });
});

describe('filtering a batch', () => {
  it('counts what it dropped and why', () => {
    const pairs = [
      { before: 'അവൻ', after: `അവന്${ZWJ}`, ts: 1, revisionIndex: 1 },
      { before: 'മരം', after: 'മലം', ts: 2, revisionIndex: 2 },
      { before: 'കടൽ ശാന്തമായിരുന്നു.', after: 'കടൽ ഇളകിമറിഞ്ഞു, ആകാശം ഇരുണ്ടു.', ts: 3, revisionIndex: 3 },
    ];

    const { kept, tally } = filterTrivial(pairs);

    expect(kept).toHaveLength(1);
    expect(kept[0]!.revisionIndex).toBe(3);
    expect(tally.unchanged).toBe(1);
    expect(tally['single-cluster']).toBe(1);
    expect(tally.punctuation).toBe(0);
  });

  it('agrees with isTrivial', () => {
    expect(isTrivial(pair('അവൻ', 'അവൻ'))).toBe(true);
    expect(isTrivial(pair('അവൻ ഒരു എഴുത്തുകാരൻ ആണ്.', 'അവൾ ഒരു കവിയായിരുന്നു എന്ന് തോന്നുന്നു.'))).toBe(
      false,
    );
  });
});
