/**
 * Renders the app icon to PNG at the sizes installers actually need.
 *
 *   npm run icons:generate
 *
 * Why this exists rather than an SVG in the manifest: **iOS does not accept
 * SVG for `apple-touch-icon`.** Given an SVG it falls back to a screenshot of
 * the page, which looks broken on the home screen. That matters here beyond
 * cosmetics — installing to the home screen is what improves the odds of
 * surviving storage eviction on iOS, which is the risk ADR-0013 exists to
 * manage. An install flow that looks broken is one people abandon.
 *
 * No image dependency: PNG is a container around zlib, and the artwork is
 * rectangles. Adding `sharp` for four flat images would pull a native binary
 * into the build for no benefit. Edges are anti-aliased by supersampling.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../public/icons');

/** Artwork is authored in a 512x512 space and scaled per output size. */
const DESIGN = 512;
const SAMPLES = 4; // 4x4 supersampling per pixel

interface Shape {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
  color: [number, number, number];
  alpha: number;
}

const INK: [number, number, number] = [0xf5, 0xf2, 0xec];
const ACCENT: [number, number, number] = [0xe8, 0x73, 0x4a];
const BG: [number, number, number] = [0x11, 0x11, 0x11];

/**
 * The margin intensity bar beside stacked lines of text — the app's whole
 * visual idea (ADR-0005), and the line opacities are its decay curve.
 */
const CONTENT: Shape[] = [
  { x: 96, y: 128, w: 16, h: 256, r: 8, color: ACCENT, alpha: 1 },
  { x: 144, y: 152, w: 272, h: 18, r: 9, color: INK, alpha: 1 },
  { x: 144, y: 206, w: 224, h: 18, r: 9, color: INK, alpha: 0.8 },
  { x: 144, y: 260, w: 256, h: 18, r: 9, color: INK, alpha: 0.6 },
  { x: 144, y: 314, w: 192, h: 18, r: 9, color: INK, alpha: 0.4 },
];

function insideRoundedRect(px: number, py: number, s: Shape): boolean {
  const { x, y, w, h, r } = s;
  if (px < x || py < y || px > x + w || py > y + h) return false;
  const radius = Math.min(r, w / 2, h / 2);
  const cx = Math.min(Math.max(px, x + radius), x + w - radius);
  const cy = Math.min(Math.max(py, y + radius), y + h - radius);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= radius * radius;
}

interface RenderOptions {
  size: number;
  /** Full-bleed square background for maskable icons; rounded otherwise. */
  maskable: boolean;
}

function render({ size, maskable }: RenderOptions): Buffer {
  // Maskable icons get cropped to a circle of ~80% width by the platform, so
  // the artwork shrinks into the safe zone while the background bleeds out.
  const contentScale = maskable ? 0.7 : 1;
  const offset = (DESIGN * (1 - contentScale)) / 2;

  const background: Shape = {
    x: 0,
    y: 0,
    w: DESIGN,
    h: DESIGN,
    r: maskable ? 0 : 96,
    color: BG,
    alpha: 1,
  };

  const shapes: Shape[] = [
    background,
    ...CONTENT.map((s) => ({
      ...s,
      x: s.x * contentScale + offset,
      y: s.y * contentScale + offset,
      w: s.w * contentScale,
      h: s.h * contentScale,
      r: s.r * contentScale,
    })),
  ];

  const pixels = Buffer.alloc(size * size * 4);
  const step = DESIGN / size;
  const sub = step / SAMPLES;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const dx = px * step + (sx + 0.5) * sub;
          const dy = py * step + (sy + 0.5) * sub;

          // Composite this sample through the shape stack, back to front.
          let sr = 0;
          let sg = 0;
          let sb = 0;
          let sa = 0;
          for (const shape of shapes) {
            if (!insideRoundedRect(dx, dy, shape)) continue;
            const srcA = shape.alpha;
            const outA = srcA + sa * (1 - srcA);
            if (outA === 0) continue;
            sr = (shape.color[0] * srcA + sr * sa * (1 - srcA)) / outA;
            sg = (shape.color[1] * srcA + sg * sa * (1 - srcA)) / outA;
            sb = (shape.color[2] * srcA + sb * sa * (1 - srcA)) / outA;
            sa = outA;
          }
          r += sr * sa;
          g += sg * sa;
          b += sb * sa;
          a += sa;
        }
      }

      const n = SAMPLES * SAMPLES;
      const alpha = a / n;
      const i = (py * size + px) * 4;
      // Un-premultiply so partially covered edge pixels keep their colour.
      pixels[i] = alpha === 0 ? 0 : Math.round(r / n / alpha);
      pixels[i + 1] = alpha === 0 ? 0 : Math.round(g / n / alpha);
      pixels[i + 2] = alpha === 0 ? 0 : Math.round(b / n / alpha);
      pixels[i + 3] = Math.round(alpha * 255);
    }
  }

  return encodePng(pixels, size, size);
}

// ---------------------------------------------------------------------------
// Minimal PNG encoder: signature + IHDR + IDAT + IEND, 8-bit RGBA, no filter.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(pixels: Buffer, width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with its filter type; 0 means none.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------

const TARGETS: Array<{ file: string; size: number; maskable: boolean }> = [
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
  // iOS ignores the manifest for the home-screen icon and reads
  // <link rel="apple-touch-icon">, which must be PNG. 180 is the size
  // current iPhones ask for.
  { file: 'apple-touch-icon.png', size: 180, maskable: false },
];

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const target of TARGETS) {
    const png = render(target);
    writeFileSync(resolve(OUT_DIR, target.file), png);
    process.stdout.write(`${target.file}  ${target.size}px  ${Math.round(png.length / 1024)} KB\n`);
  }
}

main();
