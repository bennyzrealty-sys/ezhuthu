/**
 * The margin intensity bar (ADR-0005). A 4 px bar in the left gutter of a
 * block whose **opacity** carries how recently it was edited and whose
 * **saturation** carries how many times. The text itself is never touched —
 * colouring Malayalam glyphs fights their conjunct density, and the whole point
 * is a signal readable in peripheral vision without disturbing the reading.
 *
 * Rendered as a sibling of the row inside the absolutely-positioned `.doc-item`,
 * so it sits in the gutter and cannot shift a single glyph — and so it is the
 * same bar whether the block is a read-only row or the focused editor.
 *
 * The two dimensions travel as CSS custom properties; `theme.css` turns them
 * into one hue mixed toward neutral by saturation and faded by opacity. Keeping
 * the colour maths in CSS is what makes it a `color-mix` the browser
 * interpolates rather than a string this component rebuilds every render.
 */

import { memo, type CSSProperties } from 'react';
import type { Intensity } from '../features/visibility/intensity';

export interface MarginBarProps {
  blockId: string;
  intensity: Intensity;
  /** Mid visual-pulse from scrolling past this edit (ADR-0022). */
  pulsing?: boolean;
}

function MarginBarImpl({ blockId, intensity, pulsing = false }: MarginBarProps) {
  return (
    <span
      className={`block-mark${pulsing ? ' is-pulsing' : ''}`}
      // Decorative: the same information reaches assistive tech through the
      // block's edit history, not a coloured stripe.
      aria-hidden="true"
      data-block-mark={blockId}
      style={
        {
          '--mark-opacity': intensity.opacity,
          '--mark-saturation': intensity.saturation,
        } as CSSProperties
      }
    />
  );
}

export const MarginBar = memo(MarginBarImpl);
