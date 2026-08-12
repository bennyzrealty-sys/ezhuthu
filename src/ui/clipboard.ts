/**
 * Putting the whole manuscript on the clipboard.
 *
 * The second way out of the app, and the one that cannot be blocked: a file
 * download depends on the browser having somewhere to put a file and a UI for
 * telling you it did, and inside an installed PWA with no address bar and no
 * tab strip that chain has several links that can fail quietly. A clipboard
 * write either happens or throws.
 *
 * Nothing here sends anything anywhere (rule 9). The clipboard is the device's.
 *
 * THE ONE HARD PART, and the reason this is a module rather than three lines at
 * the call site: **the text does not exist when the tap happens.** It has to be
 * read out of IndexedDB first, which is asynchronous, and a clipboard write is
 * only permitted while the browser still considers the user's gesture live —
 * "transient user activation". On WebKit that activation does not survive an
 * `await`, so the obvious shape
 *
 *     const text = await readTheDocument();      // activation is spent here
 *     await navigator.clipboard.writeText(text); // NotAllowedError
 *
 * fails on exactly the phone this was written for, and works on the desktop
 * Chromium the tests run in. Same shape as the bug that started all this.
 *
 * The way through is the asynchronous form of the Clipboard API: a
 * `ClipboardItem` accepts a **Promise** of a Blob, so `navigator.clipboard.write`
 * can be called synchronously inside the handler — while the activation is
 * unquestionably live — and the browser waits for the text itself. That form
 * exists because of this problem. Where it is missing we fall back to the
 * simple form and then to the pre-2018 `execCommand` route, which needs no
 * permission at all because it copies from a selection the page already has.
 */

/**
 * `copied` means the text is on the clipboard. `manual` means every route was
 * refused and the caller must show the writer the text to copy by hand — which
 * the app does, rather than reporting a failure and stopping.
 */
export type CopyOutcome = 'copied' | 'manual';

export interface CopyResult {
  outcome: CopyOutcome;
  /**
   * The text, whether or not it reached the clipboard. The caller needs it for
   * the manual escape hatch, and re-reading the document to get it would be a
   * second full pass.
   */
  text: string;
}

const PLAIN_TEXT = 'text/plain';

/**
 * Copy the document, given a promise of its text.
 *
 * A PROMISE, not a string: the caller must not await the read before calling
 * this, or the user activation is gone before the first route is tried. See the
 * module comment.
 */
export async function copyDocumentText(pending: Promise<string>): Promise<CopyResult> {
  /*
   * The promise is consumed by more than one route — the asynchronous form
   * takes it directly, the others need the resolved string — and reading the
   * document twice is a second full pass over every block. `settled` is awaited
   * only after the asynchronous route has had its chance, so it never delays
   * the one call that has to happen inside the gesture.
   */
  let settled: string | undefined;
  const remembered = pending.then((text) => {
    settled = text;
    return text;
  });

  if (await writeAsync(remembered)) {
    return { outcome: 'copied', text: settled ?? (await remembered) };
  }

  const text = settled ?? (await remembered);

  if (await writeText(text)) return { outcome: 'copied', text };
  if (writeBySelection(text)) return { outcome: 'copied', text };

  return { outcome: 'manual', text };
}

/**
 * The asynchronous form, and the only one that can be started before the text
 * exists.
 *
 * `write` is called synchronously from the caller's handler — nothing is
 * awaited before it — so the gesture is still live when the browser checks.
 * Safari added this form precisely so that a copy could wait on a network or a
 * database read without losing permission.
 */
async function writeAsync(pending: Promise<string>): Promise<boolean> {
  if (typeof ClipboardItem === 'undefined') return false;
  if (navigator.clipboard?.write === undefined) return false;

  try {
    const blob = pending.then((text) => new Blob([text], { type: PLAIN_TEXT }));
    await navigator.clipboard.write([new ClipboardItem({ [PLAIN_TEXT]: blob })]);
    return true;
  } catch {
    // Refused, unsupported, or the promise rejected. The caller has two more
    // routes; the read itself is reported separately if it genuinely failed.
    return false;
  }
}

async function writeText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText === undefined) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * The route that needs no permission: copy what is selected.
 *
 * Deprecated for a decade and still the only thing that works in some in-app
 * browser views, where the async Clipboard API is either absent or permanently
 * refused. The details are not optional:
 *
 * - `readOnly` rather than `disabled`, or iOS refuses to select the contents.
 * - `setSelectionRange` over the whole value, because iOS ignores `select()`
 *   on a field it considers non-editable.
 * - `font-size: 16px`, because iOS zooms the viewport when a field with smaller
 *   text is focused, and the page would visibly lurch.
 * - Positioned off-screen rather than `display: none`; a hidden field has no
 *   selectable contents.
 *
 * The previous selection is restored, so a copy does not silently discard the
 * writer's own selection in the paragraph they were reading.
 */
function writeBySelection(text: string): boolean {
  const previous = document.activeElement;
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.cssText =
    'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;font-size:16px;';

  document.body.append(field);
  let copied = false;
  try {
    field.focus({ preventScroll: true });
    field.setSelectionRange(0, text.length);
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    field.remove();
    if (previous instanceof HTMLElement) previous.focus({ preventScroll: true });
  }
  return copied;
}
