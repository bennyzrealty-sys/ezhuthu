/**
 * Generates the synthetic ~80,000-word Malayalam document used by the
 * performance suite.
 *
 *   npm run corpus:generate
 *
 * Why synthetic text rather than repeated ASCII: shaping cost is the point.
 * Malayalam conjuncts, chillu and ZWNJ sequences are what make line wrapping
 * unpredictable and measurement expensive, so a corpus of "lorem ipsum" would
 * report performance the real app will never see. The vocabulary below covers
 * the full range documented in docs/MALAYALAM.md — atomic chillu, ZWJ chillu
 * sequences, two- three- and four-consonant conjuncts, ZWNJ, and interleaved
 * Latin and digits.
 *
 * Output is gitignored. Regenerate rather than committing 600KB of fixture.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '../tests/fixtures/generated');
const TARGET_WORDS = 80_000;

/** Deterministic, so a perf regression is not confused with a different corpus. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

const ZWNJ = '‌';
const ZWJ = '‍';

/** Ordinary vocabulary. */
const WORDS = [
  'കടൽ', 'ശാന്തമായിരുന്നു', 'മഴ', 'പെയ്യുന്നു', 'വീട്', 'മനുഷ്യൻ', 'സ്ത്രീ', 'കുട്ടി',
  'പുസ്തകം', 'എഴുത്ത്', 'വാക്ക്', 'ഭാഷ', 'നദി', 'മല', 'ആകാശം', 'നക്ഷത്രം',
  'സൂര്യൻ', 'ചന്ദ്രൻ', 'രാത്രി', 'പകൽ', 'സമയം', 'ജീവിതം', 'സ്നേഹം', 'ദുഃഖം',
  'സന്തോഷം', 'ഓർമ്മ', 'സ്വപ്നം', 'യാത്ര', 'വഴി', 'നഗരം', 'ഗ്രാമം', 'കാറ്റ്',
  'മരം', 'ഇല', 'പൂവ്', 'വേര്', 'മണ്ണ്', 'വെള്ളം', 'തീ', 'ശബ്ദം',
  'നിശ്ശബ്ദത', 'കഥ', 'കവിത', 'ചിത്രം', 'സംഗീതം', 'നൃത്തം', 'ചരിത്രം', 'കാലം',
];

/** Words carrying atomic chillu. */
const CHILLU_WORDS = [
  'അവൻ', 'വർഷം', 'പാൽ', 'കൂൾ', 'മൺ', 'എഴുത്തുകാരൻ', 'നാൾ', 'അവൾ',
  'വർത്തമാനം', 'കൽ', 'തീവണ്ടിയിൽ', 'വീട്ടിൽ', 'നിന്ന്', 'കൈയിൽ',
];

/** The legacy ZWJ encoding of the same forms — both occur in real input. */
const ZWJ_CHILLU_WORDS = [
  `അവന്${ZWJ}`, // അവൻ in the legacy encoding
  `വര്${ZWJ}ഷം`, // വർഷം
  `പാല്${ZWJ}`, // പാൽ
  `നാള്${ZWJ}`, // നാൾ
];

/** Multi-consonant conjuncts, including the hard four-stack cases. */
const CONJUNCT_WORDS = [
  'ക്ഷേത്രം', 'സ്ത്രീകൾ', 'ന്യായം', 'ഗ്ദ്ധം', 'ശാസ്ത്രം', 'വിദ്യാർത്ഥി',
  'സന്ധ്യ', 'ഉത്തരവാദിത്തം', 'സ്വാതന്ത്ര്യം', 'അദ്ധ്യാപകൻ', 'ബ്രഹ്മം', 'ദ്വന്ദ്വം',
];

/** ZWNJ-bearing forms — the chandrakkala rather than the conjunct. */
const ZWNJ_WORDS = [`കൽ${ZWNJ}പന`, `അത്${ZWNJ}ഭുതം`, `വാക്${ZWNJ}ത്താരി`];

/** Latin and digits interleave constantly in real Malayalam prose. */
const LATIN_WORDS = [
  'software', 'engineer', 'internet', 'computer', 'email', 'online',
  'COVID-19', 'GDP', 'UNESCO', 'PDF', 'app', 'browser',
];

const NUMBERS = ['2024', '15', '1947', '3.5', '100', '2026-ൽ', '90%'];

const PUNCTUATION = ['.', '.', '.', '.', ',', '?', '!', ';'];

interface Weighted<T> {
  items: readonly T[];
  weight: number;
}

const BANKS: Array<Weighted<string>> = [
  { items: WORDS, weight: 60 },
  { items: CHILLU_WORDS, weight: 14 },
  { items: CONJUNCT_WORDS, weight: 12 },
  { items: ZWJ_CHILLU_WORDS, weight: 4 },
  { items: ZWNJ_WORDS, weight: 3 },
  { items: LATIN_WORDS, weight: 5 },
  { items: NUMBERS, weight: 2 },
];

const TOTAL_WEIGHT = BANKS.reduce((n, b) => n + b.weight, 0);

function pickWord(rng: () => number): string {
  let roll = rng() * TOTAL_WEIGHT;
  for (const bank of BANKS) {
    roll -= bank.weight;
    if (roll <= 0) return bank.items[Math.floor(rng() * bank.items.length)]!;
  }
  return WORDS[0]!;
}

function makeSentence(rng: () => number): string {
  const length = 5 + Math.floor(rng() * 14);
  const words: string[] = [];
  for (let i = 0; i < length; i++) words.push(pickWord(rng));
  return words.join(' ') + PUNCTUATION[Math.floor(rng() * PUNCTUATION.length)]!;
}

function makeParagraph(rng: () => number): string {
  const sentences = 2 + Math.floor(rng() * 6);
  const out: string[] = [];
  for (let i = 0; i < sentences; i++) out.push(makeSentence(rng));
  return out.join(' ');
}

function countWords(text: string): number {
  const t = text.trim();
  return t === '' ? 0 : t.split(/\s+/).length;
}

function main(): void {
  const rng = makeRng(20260809);
  const paragraphs: string[] = [];
  let words = 0;

  while (words < TARGET_WORDS) {
    const paragraph = makeParagraph(rng);
    paragraphs.push(paragraph);
    words += countWords(paragraph);
  }

  const text = paragraphs.join('\n\n') + '\n';

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, 'corpus-80k.txt'), text, 'utf8');
  writeFileSync(
    resolve(OUT_DIR, 'corpus-80k.meta.json'),
    JSON.stringify(
      {
        seed: 20260809,
        words,
        paragraphs: paragraphs.length,
        characters: text.length,
        bytes: Buffer.byteLength(text, 'utf8'),
        generatedBy: 'scripts/generate-corpus.ts',
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  const stats = {
    words,
    paragraphs: paragraphs.length,
    kb: Math.round(Buffer.byteLength(text, 'utf8') / 1024),
  };
  process.stdout.write(
    `corpus: ${stats.words} words, ${stats.paragraphs} paragraphs, ${stats.kb} KB → ${OUT_DIR}\n`,
  );
}

main();
