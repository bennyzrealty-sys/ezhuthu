# Malayalam and multi-script handling

These are correctness requirements, not polish. Each rule below exists because breaking it
produces a specific, reproducible bug. The bug is named in each case.

The test strings at the end are in the unit suite. When you find a new failure mode, add a string
here **and** a case there — this file and `tests/unit/text.test.ts` are meant to stay in sync.

---

## Rule 1 — A character is not a codepoint

`"നി".length === 2`. The user sees one character. `"ക്ക".length === 3`. The user sees one.

Every user-facing operation — cursor movement, selection, character counts, truncation, the caret
handoff on tap — works in **grapheme clusters** via `Intl.Segmenter(locale, {granularity:
'grapheme'})`, through the helpers in `src/text/segmenter.ts`.

**The bug this prevents.** Arrow-key or backspace handling on raw offsets splits a base consonant
from its vowel sign. The user presses Backspace once and half a glyph disappears, or the cursor
lands *inside* a cluster and the next keystroke inserts into the middle of a character. Truncating
a preview at `text.slice(0, 40)` cuts mid-cluster and renders a dotted-circle replacement.

**Do not construct `Intl.Segmenter` at the call site.** Construction is expensive and this runs on
the caret path. `src/text/segmenter.ts` caches instances per locale.

### A caveat you must not assume around

Whether a conjunct like `ക്ക` counts as *one* grapheme cluster or *three* depends on the Unicode
version behind the engine. UAX #29 rule GB9c (Indic conjunct clusters, added in Unicode 15.1)
keeps consonant-virama-consonant sequences together; engines on older ICU versions split them.

So: **do not hardcode expected cluster counts from reading this document.** The tests measure the
engine's actual behaviour and assert the properties we depend on — that cluster boundaries never
fall between a base and its combining mark, and that segmentation round-trips losslessly. Those
hold on every engine. Exact conjunct counts do not.

## Rule 2 — Normalise for comparison, never for storage

Two visually identical Malayalam strings can be different byte sequences. Comparison must
NFC-normalise both sides. Storage must not.

```ts
import { equals, includes, normalizeForCompare } from '@/text/normalize';
equals(a, b)            // ✔
a === b                 // ✘ bug
```

**What NFC actually fixes.** Malayalam has vowel signs with canonical decompositions, which
keyboards produce inconsistently:

| Composed | Decomposed sequence | |
|---|---|---|
| `ൊ` U+0D4A | `െ` U+0D46 + `ാ` U+0D3E | vowel sign O |
| `ോ` U+0D4B | `േ` U+0D47 + `ാ` U+0D3E | vowel sign OO |
| `ൌ` U+0D4C | `െ` U+0D46 + `ൗ` U+0D57 | vowel sign AU |

Without NFC, searching for `പോയി` fails to find a `പോയി` typed on a different keyboard. Identical
on screen, different in memory.

**What NFC does *not* fix — read this before assuming you are done.** Atomic chillu characters
(U+0D7A–U+0D7F) are **not canonically equivalent** to their ZWJ sequences. Unicode added them in
5.1 as distinct characters precisely so the two forms could be distinguished, so no normalisation
form will unify them:

| Atomic | Sequence | |
|---|---|---|
| `ൻ` U+0D7B | `ന` + `്` U+0D4D + ZWJ U+200D | chillu N |
| `ർ` U+0D7C | `ര` + `്` + ZWJ | chillu RR |
| `ൽ` U+0D7D | `ല` + `്` + ZWJ | chillu L |
| `ൾ` U+0D7E | `ള` + `്` + ZWJ | chillu LL |
| `ൺ` U+0D7A | `ണ` + `്` + ZWJ | chillu NN |

`"അവൻ".normalize('NFC') !== "അവന്‍".normalize('NFC')` — both sides unchanged, still unequal, and
they look identical on screen.

Therefore `normalizeForCompare()` applies NFC **and then an explicit chillu fold**, mapping ZWJ
sequences to their atomic form. This is our own layer, not something the platform provides.

**The bug this prevents.** Search silently returns nothing for a word the user can see on screen.
Nothing errors; the feature just appears broken and untrustworthy.

**Why storage keeps the original bytes.** ADR-0014: import → export must be byte-faithful, so a
manuscript brought into the app comes out unchanged. Normalising on write would silently rewrite
the user's text.

## Rule 3 — ZWJ and ZWNJ are meaningful, not whitespace

- **ZWNJ** U+200C forces the *chandrakkala* (visible virama) form instead of a conjunct
- **ZWJ** U+200D forms chillu in the legacy encoding

Neither is whitespace. Neither may be stripped, trimmed, or treated as a word separator. Both must
survive import, export, and every text transformation.

**The bug this prevents.** A "clean up whitespace" pass that strips invisible characters silently
changes `ന്‍റ` to a different conjunct — altering the word. Users report "the app changed my
spelling" and it is very hard to trace.

## Rule 4 — Word counting splits on whitespace after normalisation

Malayalam uses spaces between words, so `\s+` works. Count after `normalizeForCompare()` so the
figure is stable regardless of input encoding, and **never** treat ZWJ/ZWNJ as separators (Rule 3).

Counts are exposed per block and per document. Per-document is maintained incrementally — only the
changed block's delta is applied, never a full recount (that would be a whole-document read).

## Rule 5 — Never commit during IME composition

Malayalam is typed through input methods: Android and iOS system keyboards, and transliteration
keyboards where Latin keystrokes resolve into Malayalam. All use composition events.

While composing, the field holds provisional text the IME still owns. Writing to it, or
re-rendering it, resets the buffer. Full rationale in ADR-0010.

```ts
if (e.nativeEvent.isComposing) return;   // guard every commit and every signal
```

`event.key` is unreliable during composition — Chrome reports `keyCode` 229 for everything.
`isComposing` is authoritative.

**The bug this prevents.** The 400 ms idle commit fires mid-composition and produces the classic
broken-Malayalam-editor report: half-formed conjuncts committed as separate characters, cursor
jumping to the start of the field, duplicated vowel signs. **This causes more visible breakage
than incorrect grapheme handling.**

**Partly testable, and now tested.** Playwright's `type()` dispatches `input` events with no
composition session — but CDP's `Input.imeSetComposition` drives a *real* one in Chromium, and
`tests/e2e/ime.spec.ts` uses it to assert that no commit lands inside a composition window and
that composed text reaches storage intact. Removing the guard makes those tests commit an empty
block, so they have teeth.

What that still does not cover is platform behaviour: a real Gboard or iOS Malayalam keyboard,
transliteration keyboards resolving Latin keystrokes, swipe typing, and autocorrect. The manual
checklist below remains the only coverage for those.

## Rule 6 — Mixed script within a block is normal

Malayalam and English interleave inside a single paragraph constantly — technical terms, names,
citations. Never assume one script per block.

- `dir="auto"` on editable and rendered blocks. Both scripts are LTR, so this is cheap insurance
  for later scripts rather than a live need.
- `lang="ml"` on the document root, with the font stack covering both ranges.
- Do not detect "the script of a block" and switch behaviour on it. There is no such thing.

## Rule 7 — Fonts must keep their layout tables

Conjunct formation lives in the font's GSUB/GPOS tables. A subsetter run with default settings
strips layout features and breaks every conjunct in the document.

`scripts/subset-fonts.sh` uses `--layout-features='*'` and keeps the full Malayalam block plus
ZWJ/ZWNJ. ADR-0019 covers why we ship Manjari only by default.

**The bug this prevents.** Every conjunct renders as separate consonants with visible viramas —
the text becomes wrong-looking to a reader, though technically legible. A rendering test asserts a
known conjunct string produces the expected shaped width.

---

## Test strings

Used by `tests/unit/text.test.ts`. Each exists for a reason.

### Chillu — atomic vs sequence

```
അവൻ            U+0D05 U+0D35 U+0D7B                  atomic chillu N
അവന്‍           U+0D05 U+0D35 U+0D28 U+0D4D U+200D    sequence chillu N
```
Identical on screen. **Must compare equal** under `normalizeForCompare()`, and **must not** compare
equal under bare `.normalize('NFC')` — the test asserts both, so a future refactor that drops the
chillu fold fails loudly.

```
വർഷം           chillu RR
പാൽ            chillu L
കൂൾ            chillu LL
മൺ             chillu NN
```

### Vowel signs — composed vs decomposed

```
പോയി          U+0D2A U+0D4B U+0D2F U+0D3F        composed OO
പോയി          U+0D2A U+0D47 U+0D3E U+0D2F U+0D3F  decomposed OO
```
Must compare equal after NFC. This is the case NFC alone genuinely solves.

### Conjuncts

```
ക്ക            kka      — two-consonant conjunct
ന്ത            nta
സ്ത്ര           stra     — three-consonant stack
ഗ്ദ്ധ           gddha    — four-consonant stack, a hard shaping case
ന്ത്യ           ntya
```
Assertions: segmentation round-trips losslessly, and no cluster boundary falls between a
consonant and a following virama. Exact cluster counts are **not** asserted — engine-dependent,
see Rule 1.

### ZWNJ — conjunct suppression

```
കൽപന          with ZWNJ U+200C after the virama — chandrakkala form
കല്പന          without ZWNJ — conjunct form
```
Different words visually. Must **not** compare equal, must survive round trip, and ZWNJ must not
be counted as a word separator.

### Mixed script

```
അവൻ ഒരു software engineer ആണ്.
2024-ൽ 15 ശതമാനം വർധന.
COVID-19 മഹാമാരി ന്റെ കാലത്ത്.
```
Word counts must be correct across the script boundary; digits and Latin must not break
segmentation.

### Long-form sample

`scripts/generate-corpus.ts` produces the 80,000-word synthetic document used by the performance
suite. It is built from Malayalam sentence templates covering the full range above — chillu,
multi-consonant conjuncts, ZWNJ, and interleaved Latin — so that performance is measured against
text with realistic shaping cost, not against repeated ASCII.

---

## Manual test checklist

Composition cannot be tested synthetically (Rule 5). Run this on a real device before shipping any
change to `render/BlockEditor.tsx` or `text/`:

- [ ] Android Gboard Malayalam — type a paragraph, pause 2 s mid-sentence, continue. No lost or
      duplicated characters.
- [ ] Android transliteration keyboard — type `avan`, let it resolve to `അവൻ`. No cursor jump.
- [ ] iOS Malayalam keyboard — same paragraph test.
- [ ] Swipe typing (Gboard, English) into a Malayalam block. Word arrives whole.
- [ ] Autocorrect replacing a just-typed English word inside a Malayalam paragraph.
- [ ] Type continuously for 30 s without pausing — the idle commit must never fire mid-composition.
- [ ] Rotate the device while a block is focused and composing. No content loss.
- [ ] Tap into the middle of a conjunct-heavy paragraph. Caret lands on a cluster boundary, never
      inside one.
