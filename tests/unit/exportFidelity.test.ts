/**
 * "Not a single letter." (ADR-0037)
 *
 * The download and the clipboard are the same bytes — both are handed the
 * string `exportDocument` returns — so this file tests the one thing they
 * share, and tests it as a *character count* as well as an equality, because
 * the failure this guards against is silent truncation rather than corruption.
 *
 * The Malayalam strings are the ones in docs/MALAYALAM.md, and they are here
 * rather than only in the text tests because the export path is where
 * normalising would be most tempting and most destructive: chillu in its atomic
 * form and chillu spelled with ZWJ look identical on screen, compare equal
 * after folding, and are different manuscripts (ADR-0014). Whichever one the
 * writer typed is the one that has to come back out.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EzhuthuDB } from '@/db/schema';
import { createDoc, insertBlock } from '@/core/events';
import { exportDocument } from '@/features/io/export';
import { importBlocks, splitIntoBlocks } from '@/features/io/import';

let db: EzhuthuDB;
let counter = 0;
const DOC = 'doc-1';

beforeEach(async () => {
  db = new EzhuthuDB(`ezhuthu-fidelity-${counter++}`);
  await db.open();
  await createDoc(db, { docId: DOC, now: 1_000 });
});

afterEach(() => db.close());

/** Every form docs/MALAYALAM.md warns about, plus the ones outside Malayalam. */
const AWKWARD = [
  // Chillu, atomic and as consonant + virama + ZWJ. Identical on screen.
  'അവൻ ഒരു എഴുത്തുകാരൻ ആണ്.',
  'അവന്‍ ഒരു എഴുത്തുകാരന്‍ ആണ്.',
  // Vowel signs, composed and decomposed.
  'പോകാം ചോദ്യം കൌതുകം',
  'പോകാം ചോദ്യം കൌതുകം'.normalize('NFD'),
  // ZWNJ suppressing a conjunct.
  'കൂട്‌ടം എന്ന വാക്ക്',
  // Four-consonant stack.
  'ഒറ്റയ്ക്ക്ത്ര എന്ന കൂട്ടക്ഷരം',
  // Mixed scripts, digits, punctuation the file name rules strip.
  'അവൻ ഒരു software engineer ആണ് — 2026, "ശരി"?',
  // Outside the BMP: surrogate pairs must survive as pairs.
  'ഒരു 😀 ചിരി, 𝐀 and 𝟙',
  // Whitespace inside a paragraph, which import preserves deliberately.
  'വരി ഒന്ന്  \tവരി രണ്ട്',
];

describe('the exported text loses nothing', () => {
  it('returns every documented Malayalam form byte for byte', async () => {
    for (const paragraph of AWKWARD) await insertBlock(db, DOC, paragraph);

    const { text, blocks } = await exportDocument(db, DOC);
    expect(blocks).toBe(AWKWARD.length);
    expect(text).toBe(AWKWARD.join('\n\n') + '\n');

    // Stated separately from the equality above: a truncation that happened to
    // land on a paragraph boundary would still be caught here.
    expect([...text].length).toBe([...AWKWARD.join('\n\n')].length + 1);
  });

  it('does not normalise — the two chillu spellings stay different', async () => {
    const atomic = 'അവൻ';
    const withZwj = 'അവന്‍';
    expect(atomic).not.toBe(withZwj);

    await insertBlock(db, DOC, atomic);
    await insertBlock(db, DOC, withZwj);

    const { text } = await exportDocument(db, DOC);
    expect(text).toBe(`${atomic}\n\n${withZwj}\n`);
    // The failure this rules out: one form silently rewritten as the other.
    expect(text.includes('‍')).toBe(true);
    expect(text.codePointAt(0)).toBe(atomic.codePointAt(0));
  });

  it('keeps surrogate pairs whole', async () => {
    const astral = 'ഒരു 😀 ചിരി';
    await insertBlock(db, DOC, astral);
    const { text } = await exportDocument(db, DOC);
    // Code UNITS as well as code points: a half-copied pair would show here.
    expect(text.slice(0, astral.length)).toBe(astral);
    expect([...text].length).toBe([...astral].length + 1);
  });

  /*
   * The generous timeouts on the two document-sized cases are about
   * fake-indexeddb, not about the app: it is an in-memory shim with no
   * cursor optimisations, and walking 1,500 blocks through it costs seconds
   * where the real store costs the 57-66ms in the perf table. The size is the
   * point of the test, so the budget moves rather than the size.
   */
  it('carries a document far larger than any window the app renders', async () => {
    // The virtualiser holds ~12 blocks. Nothing about the export may scale with
    // what is on screen, and nothing may quietly cap.
    const paragraphs = Array.from(
      { length: 1_500 },
      (_, i) => `ഖണ്ഡിക ${i}. ${AWKWARD[i % AWKWARD.length]!}`,
    );
    await importBlocks(db, DOC, paragraphs);

    const { text, blocks, characters, bytes } = await exportDocument(db, DOC);
    expect(blocks).toBe(1_500);
    expect(text).toBe(paragraphs.join('\n\n') + '\n');
    // Code POINTS, and the byte length of the file that will arrive — Malayalam
    // is three bytes a character, so these three numbers are all different and
    // reporting the wrong one understates the manuscript threefold.
    expect(characters).toBe([...text].length);
    expect(bytes).toBe(Buffer.byteLength(text, 'utf8'));
    expect(bytes).toBeGreaterThan(characters * 2);

    // The last paragraph specifically: truncation shows up at the end.
    expect(text.endsWith(`${paragraphs[1_499]!}\n`)).toBe(true);
  }, 60_000);

  it('round-trips a large document through split and join unchanged', async () => {
    const paragraphs = Array.from(
      { length: 500 },
      (_, i) => `${AWKWARD[i % AWKWARD.length]!} ${i}`,
    );
    await importBlocks(db, DOC, paragraphs);

    const { text } = await exportDocument(db, DOC);
    expect(splitIntoBlocks(text)).toEqual(paragraphs);
  }, 60_000);

  it('includes the paragraph being typed at full length', async () => {
    // The pending-edit override is the path a download taken mid-sentence
    // takes (ADR-0036). It must not be a truncated or normalised copy.
    const started = await insertBlock(db, DOC, '');
    const draft = AWKWARD.join(' ');

    const { text, characters, bytes } = await exportDocument(db, DOC, {
      blockId: started.blockId,
      text: draft,
    });
    expect(text).toBe(`${draft}\n`);
    expect(characters).toBe([...draft].length + 1);
    expect(bytes).toBe(Buffer.byteLength(text, 'utf8'));
  });
});
