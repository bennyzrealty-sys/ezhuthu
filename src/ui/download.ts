/**
 * Handing a file to the browser.
 *
 * The whole of the app's egress: two features write a file to the device, and
 * neither of them, nor anything else here, ever sends a byte anywhere. There is
 * no upload path to review because there is no upload path.
 *
 * Two details that are not decoration:
 *
 * The anchor is in the document when it is clicked. A detached one downloads in
 * Chrome but does not reliably carry its `download` attribute, and the file
 * lands as "download" with no extension — which is what a backup of someone's
 * manuscript must never be called.
 *
 * The object URL is revoked on a later task, not on the next line — and the
 * anchor is removed on that same later task rather than immediately. Revoking
 * or detaching synchronously after `click()` races the fetch the click just
 * started, and loses it often enough to be reported as "the export button does
 * nothing". A zero-delay timeout is enough for Chromium and is not enough
 * everywhere: the save can still be in flight a second later, and the URL costs
 * nothing to keep until then.
 *
 * And where the `download` attribute is not honoured at all, the file is opened
 * instead of saved, and the caller is told which happened — see `DownloadOutcome`.
 */

/** How far the browser got. `opened` means the writer still has to save it. */
export type DownloadOutcome = 'downloaded' | 'opened';

/**
 * Long enough for a save that has not finished starting. The URL is a handle to
 * a blob already in memory, so holding it costs nothing that closing the tab
 * does not reclaim.
 */
const REVOKE_AFTER_MS = 60_000;

/**
 * Whether this browser will save an anchor's target to a file rather than
 * navigating to it.
 *
 * Feature-detected rather than sniffed. Where it is absent — older WebKit, and
 * the in-app browser views links from a messaging app actually open in — a
 * click on a `download` anchor navigates instead, and in a standalone PWA with
 * no address bar and no tabs that can look exactly like nothing happening.
 */
function savesToFile(): boolean {
  return typeof HTMLAnchorElement !== 'undefined' && 'download' in HTMLAnchorElement.prototype;
}

export function downloadBlob(filename: string, blob: Blob): DownloadOutcome {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';

  const outcome: DownloadOutcome = savesToFile() ? 'downloaded' : 'opened';
  if (outcome === 'downloaded') {
    anchor.download = filename;
  } else {
    // Nothing here can save the file, so put it where the writer can: a tab
    // showing their text, which every platform can then share or save from.
    // Better than a button that silently does nothing.
    anchor.target = '_blank';
  }

  document.body.append(anchor);
  anchor.click();

  setTimeout(() => {
    anchor.remove();
    URL.revokeObjectURL(url);
  }, REVOKE_AFTER_MS);

  return outcome;
}

export function downloadText(filename: string, text: string, type: string): DownloadOutcome {
  return downloadBlob(filename, new Blob([text], { type }));
}

/**
 * The part of a file name taken from a document title — ASCII only.
 *
 * This is not squeamishness about Unicode, and it is not the rule anywhere else
 * in the project: stored text keeps its bytes (ADR-0014), comparison folds
 * rather than strips (Rule 5), and file *content* is Malayalam throughout. It
 * is a fact about the `download` attribute, measured rather than assumed. In
 * the Chromium this project is tested against, a `download` value containing
 * any non-ASCII character — `നോവൽ`, and `café` equally — is discarded whole, and
 * the file arrives named `download`, with no extension and colliding with every
 * other download the browser has ever named that.
 *
 * For a corpus that is annoying. For a BACKUP it is the failure ADR-0013 exists
 * to prevent dressed as a success: the writer clicks Back up, a file appears
 * called `download`, the next one is `download(1)`, and nothing on disk says
 * which manuscript or which day. The stamp in the name is what identifies the
 * file; the title is inside it either way.
 *
 * Returns an empty string when a title contributes nothing, so callers can drop
 * the segment rather than emit a name full of dashes.
 */
export function fileNameStem(title: string): string {
  return title
    .replaceAll(/[^A-Za-z0-9._-]+/g, '-')
    .replaceAll(/-{2,}/g, '-')
    .replaceAll(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60);
}

/**
 * Whether this device can hand a FILE to the OS share sheet.
 *
 * This is the route that matters on an iPhone. In standalone display mode —
 * the app opened from its home-screen icon, which is how this app is meant to
 * be used — WebKit does not save an `<a download>` to Files, and there is no
 * address bar or tab strip for it to fall back into, so the tap looks like it
 * did nothing. `navigator.share` with a file opens the system sheet, from which
 * "Save to Files" is one more tap and every other app on the phone is available
 * besides.
 *
 * Feature-detected with a real (empty) File, because `canShare` is the only
 * honest answer to "will this accept a file" — support for sharing *text* says
 * nothing about support for sharing *files*. No user-agent sniffing anywhere in
 * this project (ADR-0034).
 */
export function canShareFile(): boolean {
  if (typeof File === 'undefined') return false;
  if (typeof navigator === 'undefined' || navigator.canShare === undefined) return false;
  try {
    return navigator.canShare({ files: [new File([''], 'ezhuthu.txt', { type: 'text/plain' })] });
  } catch {
    return false;
  }
}

/** `dismissed` is the writer closing the sheet — not a failure, and not silence. */
export type ShareOutcome = 'shared' | 'dismissed' | 'unavailable';

/**
 * Hand the document to the OS share sheet as a file.
 *
 * A share needs transient user activation, and unlike the clipboard there is no
 * form that accepts a promise — the text has to be read out of IndexedDB first,
 * which costs at least one task. WebKit's activation window is generous enough
 * for a read that takes tens of milliseconds, and where it is not, the refusal
 * arrives as `NotAllowedError` and the caller falls back rather than pretending.
 * This is the one path here that cannot be made certain from inside the page.
 */
export async function shareTextFile(
  filename: string,
  text: string,
  type = 'text/plain',
): Promise<ShareOutcome> {
  if (!canShareFile()) return 'unavailable';
  try {
    await navigator.share({ files: [new File([text], filename, { type })], title: filename });
    return 'shared';
  } catch (error) {
    // AbortError is the sheet being closed, which is an answer, not a fault.
    if (error instanceof DOMException && error.name === 'AbortError') return 'dismissed';
    return 'unavailable';
  }
}
