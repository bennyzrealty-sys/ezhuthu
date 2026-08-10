/**
 * The document minimap (ADR-0021): the whole document as a narrow column,
 * shaded by edit intensity, one bucket per device-pixel row, each bucket the
 * MAXIMUM intensity of its blocks so a single hot paragraph among cold ones
 * stays visible.
 *
 * Drawn to a `<canvas>`, not a stack of divs. One bucket per pixel row is
 * hundreds of buckets; as DOM that is hundreds of nodes reconciled on every
 * edit, and the canvas is both lighter and the honest expression of "cost is
 * the column's height, not the document's length" (ADR-0021). It reads only the
 * compact index — id, order, updatedAt, revisionCount — never block text.
 *
 * It does not redraw while scrolling. Nothing it shows depends on scroll
 * position, so it is memoised on the index and redraws only when the index
 * changes, the column resizes, or the colour scheme flips.
 */

import { memo, useCallback, useEffect, useRef } from 'react';
import type { BlockIndexEntry } from '../db/types';
import { bucketise, jumpTargetFor, type Bucket } from '../features/visibility/minimap';

export interface MinimapProps {
  /** The compact index, in document order. Same array the virtualiser drives. */
  blocks: BlockIndexEntry[];
  /** Jump the document to this block index (from a tap on the column). */
  onJump: (index: number) => void;
  /** Clock for decay (rule 8). Real callers omit it; read at draw time. */
  now?: () => number;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Parse `#rgb` / `#rrggbb`. The theme palette is hex, so nothing else arises. */
function parseHex(value: string): Rgb | null {
  const hex = value.trim().replace(/^#/, '');
  if (hex.length === 3) {
    const r = parseInt(hex[0]! + hex[0]!, 16);
    const g = parseInt(hex[1]! + hex[1]!, 16);
    const b = parseInt(hex[2]! + hex[2]!, 16);
    return Number.isNaN(r + g + b) ? null : { r, g, b };
  }
  if (hex.length === 6) {
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return Number.isNaN(r + g + b) ? null : { r, g, b };
  }
  return null;
}

function readColour(el: Element, prop: string, fallback: Rgb): Rgb {
  return parseHex(getComputedStyle(el).getPropertyValue(prop)) ?? fallback;
}

function MinimapImpl({ blocks, onJump, now }: MinimapProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // The buckets from the last draw, kept for hit-testing a tap without
  // recomputing them.
  const drawn = useRef<{ buckets: Bucket[]; bucketCount: number }>({ buckets: [], bucketCount: 0 });

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.height < 1 || rect.width < 1) return;

    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;

    const ctx = canvas.getContext('2d');
    if (ctx === null) return;

    // One bucket per device-pixel row. Reading the palette from the live
    // element means the mix tracks a theme flip for free.
    const accent = readColour(canvas, '--accent', { r: 184, g: 80, b: 42 });
    const muted = readColour(canvas, '--ink-muted', { r: 93, g: 90, b: 80 });

    const buckets = bucketise(blocks, height, (now ?? Date.now)());
    drawn.current = { buckets, bucketCount: height };

    ctx.clearRect(0, 0, width, height);
    for (let y = 0; y < height; y++) {
      const mark = buckets[y]?.intensity;
      if (!mark) continue;
      // Match the margin bar's language: one hue mixed toward neutral by
      // saturation, faded by opacity.
      const s = mark.saturation;
      const r = Math.round(muted.r + (accent.r - muted.r) * s);
      const g = Math.round(muted.g + (accent.g - muted.g) * s);
      const b = Math.round(muted.b + (accent.b - muted.b) * s);
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${mark.opacity})`;
      ctx.fillRect(0, y, width, 1);
    }
  }, [blocks, now]);

  // Redraw whenever the index or the clock reference changes.
  useEffect(draw, [draw]);

  // Resize and theme flips: both change what to draw without changing the
  // index, so they are handled outside the render path.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;

    const observer = new ResizeObserver(() => draw());
    observer.observe(canvas);

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onTheme = (): void => draw();
    media.addEventListener('change', onTheme);

    return () => {
      observer.disconnect();
      media.removeEventListener('change', onTheme);
    };
  }, [draw]);

  const onTap = useCallback(
    (clientY: number): void => {
      const canvas = canvasRef.current;
      const { buckets, bucketCount } = drawn.current;
      if (canvas === null || bucketCount === 0) return;
      const rect = canvas.getBoundingClientRect();
      const at = Math.round(((clientY - rect.top) / rect.height) * bucketCount);
      const target = jumpTargetFor(buckets, at, blocks.length);
      if (target >= 0) onJump(target);
    },
    [blocks.length, onJump],
  );

  if (blocks.length === 0) return null;

  return (
    <canvas
      ref={canvasRef}
      className="doc-minimap"
      data-testid="minimap"
      // A navigation control, not decoration: give it a name and let a tap land.
      role="slider"
      aria-label="Document minimap — jump to edited regions"
      aria-hidden={false}
      onClick={(e) => onTap(e.clientY)}
    />
  );
}

export const Minimap = memo(MinimapImpl);
