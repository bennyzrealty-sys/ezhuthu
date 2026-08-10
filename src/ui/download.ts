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
 * The object URL is revoked on a later task, not on the next line. Revoking
 * synchronously after `click()` races the fetch the click just started, and
 * loses it often enough to be reported as "the export button does nothing".
 */

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';

  document.body.append(anchor);
  anchor.click();
  anchor.remove();

  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadText(filename: string, text: string, type: string): void {
  downloadBlob(filename, new Blob([text], { type }));
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
