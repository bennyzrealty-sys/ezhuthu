/**
 * Tap-to-caret handoff.
 *
 * When a read-only block is tapped we mount an editable field in its place and
 * must land the caret exactly where the finger went, without a visible jump.
 * Getting this wrong is the difference between an editor that feels native and
 * one that feels like a web page — the reader taps a word and the caret
 * appears somewhere else.
 *
 * Three steps, each with its own trap:
 *
 *   1. Map viewport coordinates to a DOM position. Standardised as
 *      `caretPositionFromPoint`, but WebKit only ships `caretRangeFromPoint`,
 *      so both are needed. Safari is a primary target here.
 *   2. Convert that DOM position to a character offset within the block's
 *      text, which means walking text nodes rather than trusting the offset,
 *      since the hit node may be nested.
 *   3. Snap to a grapheme-cluster boundary. The browser will happily report a
 *      position inside a Malayalam cluster; placing the caret there is what
 *      makes the cursor jump on the next keystroke.
 */

import { snapToClusterBoundary } from '../text/segmenter';

interface DomCaretPosition {
  node: Node;
  offset: number;
}

interface LegacyCaretDocument {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
}

/** Feature-detected across both APIs; returns null when neither is available. */
export function domCaretFromPoint(x: number, y: number, doc: Document): DomCaretPosition | null {
  const d = doc as Document & LegacyCaretDocument;

  if (typeof d.caretPositionFromPoint === 'function') {
    const position = d.caretPositionFromPoint(x, y);
    if (position) return { node: position.offsetNode, offset: position.offset };
  }

  // WebKit. Still the only option in Safari.
  if (typeof d.caretRangeFromPoint === 'function') {
    const range = d.caretRangeFromPoint(x, y);
    if (range) return { node: range.startContainer, offset: range.startOffset };
  }

  return null;
}

/**
 * Character offset of a DOM position within `root`'s text content.
 *
 * Walks text nodes and accumulates, rather than trusting the reported offset:
 * the hit node is often a nested text node, whose offset is local to itself.
 */
export function textOffsetWithin(root: Element, node: Node, offsetInNode: number): number {
  if (!root.contains(node)) return 0;

  // A hit on the element itself reports a child index, not a character offset.
  if (node.nodeType !== Node.TEXT_NODE) {
    let total = 0;
    const children = Array.from(node.childNodes).slice(0, offsetInNode);
    for (const child of children) total += child.textContent?.length ?? 0;
    if (node === root) return total;
    return textOffsetWithin(root, node.parentNode ?? root, indexOfChild(node)) + total;
  }

  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let total = 0;
  let current = walker.nextNode();
  while (current !== null) {
    if (current === node) return total + offsetInNode;
    total += current.textContent?.length ?? 0;
    current = walker.nextNode();
  }
  return total;
}

function indexOfChild(node: Node): number {
  const parent = node.parentNode;
  if (parent === null) return 0;
  return Array.prototype.indexOf.call(parent.childNodes, node);
}

/**
 * Full pipeline: a tap at (x, y) inside `element` becomes a grapheme-aligned
 * offset into `text`.
 *
 * Returns the end of the text when the point cannot be resolved — tapping past
 * the last line should put the caret at the end, which is what a reader
 * expects, rather than silently doing nothing.
 */
export function caretOffsetFromPoint(
  element: Element,
  x: number,
  y: number,
  text: string,
  locale?: string,
): number {
  const position = domCaretFromPoint(x, y, element.ownerDocument);
  if (position === null) return text.length;

  const raw = textOffsetWithin(element, position.node, position.offset);
  const clamped = Math.min(Math.max(raw, 0), text.length);
  return snapToClusterBoundary(text, clamped, locale);
}

/**
 * Place the caret in a freshly mounted field.
 *
 * The `focus({preventScroll})` matters: without it the browser scrolls the
 * field into its own idea of view, fighting the virtualiser and making the
 * document lurch at the moment of tapping.
 */
export function placeCaret(field: HTMLTextAreaElement, offset: number): void {
  field.focus({ preventScroll: true });
  const clamped = Math.min(Math.max(offset, 0), field.value.length);
  field.setSelectionRange(clamped, clamped);
}
