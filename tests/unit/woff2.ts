/**
 * Just enough WOFF2 to answer one question: did subsetting keep the layout
 * tables that Malayalam shaping needs?
 *
 * fonttools answers it at build time (scripts/verify-font.py), but that runs
 * only when someone re-subsets. This runs in CI on the committed file, which is
 * the artefact that actually ships.
 *
 * Reading the table directory alone is not enough. `--layout-features=''`
 * leaves GSUB present with an empty FeatureList, so "GSUB exists" passes while
 * every conjunct is broken. The feature tags are inside the brotli stream, so
 * we decompress it and walk to them.
 *
 * Format: https://www.w3.org/TR/WOFF2/
 */

import { brotliDecompressSync } from 'node:zlib';

/** WOFF2 known-table index → tag. Order is normative; do not sort it. */
const KNOWN_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post',
  'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT',
  'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea',
  'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH',
  'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar',
  'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar',
  'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop',
  'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill',
] as const;

export interface Woff2Table {
  tag: string;
  /** Length in the reconstructed sfnt. */
  origLength: number;
  /** Offset into the decompressed stream. */
  offset: number;
  /** Length in the decompressed stream — differs from origLength for glyf/loca. */
  length: number;
}

export interface Woff2Font {
  tables: Map<string, Woff2Table>;
  /** The concatenated, still-transformed table data. */
  data: Buffer;
  numGlyphs: number;
}

/** UIntBase128: 7 bits per byte, high bit continues. Max five bytes. */
function readBase128(buf: Buffer, at: number): [value: number, next: number] {
  let value = 0;
  for (let i = 0; i < 5; i += 1) {
    const byte = buf.readUInt8(at + i);
    // Leading zeros are forbidden by the spec, and so is overflowing 32 bits.
    if (i === 0 && byte === 0x80) throw new Error('WOFF2: base128 with leading zero');
    if (value > 0x01ffffff) throw new Error('WOFF2: base128 overflow');
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return [value, at + i + 1];
  }
  throw new Error('WOFF2: base128 too long');
}

/**
 * glyf and loca invert the usual convention: for them transform version 0 is
 * the transformed form and 3 is the null transform. Every other table is the
 * other way round. Getting this backwards desynchronises the whole directory,
 * so it is spelled out rather than inlined.
 */
function isTransformed(tag: string, transformVersion: number): boolean {
  return tag === 'glyf' || tag === 'loca' ? transformVersion === 0 : transformVersion !== 0;
}

export function readWoff2(file: Buffer): Woff2Font {
  if (file.toString('latin1', 0, 4) !== 'wOF2') throw new Error('not a WOFF2 file');

  const numTables = file.readUInt16BE(12);
  const totalCompressedSize = file.readUInt32BE(20);

  const tables = new Map<string, Woff2Table>();
  let at = 48;
  let offset = 0;

  for (let i = 0; i < numTables; i += 1) {
    const flags = file.readUInt8(at);
    at += 1;

    const known = flags & 0x3f;
    let tag: string;
    if (known === 63) {
      tag = file.toString('latin1', at, at + 4);
      at += 4;
    } else {
      const t = KNOWN_TAGS[known];
      if (t === undefined) throw new Error(`WOFF2: unknown table index ${known}`);
      tag = t;
    }

    let origLength: number;
    [origLength, at] = readBase128(file, at);

    let length = origLength;
    if (isTransformed(tag, flags >> 6)) {
      [length, at] = readBase128(file, at);
    }

    tables.set(tag, { tag, origLength, offset, length });
    offset += length;
  }

  // Table data is concatenated in directory order with no padding — the sfnt's
  // four-byte alignment is reintroduced only when the font is reconstructed.
  const data = brotliDecompressSync(file.subarray(at, at + totalCompressedSize));

  const maxp = tables.get('maxp');
  if (maxp === undefined) throw new Error('WOFF2: no maxp');

  return { tables, data, numGlyphs: data.readUInt16BE(maxp.offset + 4) };
}

/**
 * Feature tags declared by GSUB or GPOS.
 *
 * This is the assertion with teeth: a stripped font still has the table, but
 * its FeatureList is empty.
 */
export function featureTags(font: Woff2Font, tag: 'GSUB' | 'GPOS'): string[] {
  const table = font.tables.get(tag);
  if (table === undefined) return [];

  const base = table.offset;
  // Header: version (4), then offsets to ScriptList, FeatureList, LookupList.
  const featureList = base + font.data.readUInt16BE(base + 6);
  const count = font.data.readUInt16BE(featureList);

  const tags: string[] = [];
  for (let i = 0; i < count; i += 1) {
    // FeatureRecord is tag (4) + offset (2).
    const at = featureList + 2 + i * 6;
    tags.push(font.data.toString('latin1', at, at + 4));
  }
  return [...new Set(tags)].sort();
}
