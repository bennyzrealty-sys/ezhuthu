/**
 * Measured block heights, cached per block and viewport width.
 *
 * Fixed row heights are not survivable here: Malayalam line wrapping cannot be
 * predicted from character counts, because conjunct cluster widths depend on
 * shaping. Guessing produces scroll drift that compounds over 2,000 blocks
 * until the scrollbar is lying by whole screens.
 *
 * So heights are measured, and the measurement is cached — re-measuring during
 * a scroll would put layout on the hot path, which is what the 60fps budget
 * cannot afford.
 */

/**
 * Width is bucketed to whole pixels. Sub-pixel width changes (scrollbar
 * appearing, browser zoom) would otherwise miss the cache on every block and
 * trigger a full re-measure for a difference no reader can see.
 */
function key(blockId: string, width: number): string {
  return `${blockId}:${Math.round(width)}`;
}

export class HeightCache {
  private heights = new Map<string, number>();
  private width = 0;

  /**
   * Estimate for a block that has never been measured, so the virtualiser has
   * a starting total height. Deliberately rough — it is replaced by a real
   * measurement as soon as the block is rendered once.
   */
  estimate(length: number, width: number, lineHeight = 28): number {
    const charsPerLine = Math.max(12, Math.floor(width / 11));
    const lines = Math.max(1, Math.ceil(length / charsPerLine));
    return lines * lineHeight + 16;
  }

  get(blockId: string, width: number): number | undefined {
    return this.heights.get(key(blockId, width));
  }

  set(blockId: string, width: number, height: number): void {
    this.heights.set(key(blockId, width), height);
  }

  /**
   * A block's text changed, so its cached height is stale at every width.
   * Cheaper than tracking per-width entries: a block is edited far less often
   * than it is scrolled past.
   */
  invalidate(blockId: string): void {
    for (const k of this.heights.keys()) {
      if (k.startsWith(`${blockId}:`)) this.heights.delete(k);
    }
  }

  /**
   * Viewport width changed — rotation, resize, split view. Entries for other
   * widths are dropped rather than kept, because a phone realistically has two
   * or three widths and unbounded retention is a slow leak across a long
   * session.
   */
  setWidth(width: number): boolean {
    const rounded = Math.round(width);
    if (rounded === this.width) return false;
    this.width = rounded;
    for (const k of this.heights.keys()) {
      if (!k.endsWith(`:${rounded}`)) this.heights.delete(k);
    }
    return true;
  }

  get size(): number {
    return this.heights.size;
  }

  clear(): void {
    this.heights.clear();
  }
}
