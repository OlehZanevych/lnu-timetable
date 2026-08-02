/**
 * Loads the report typeface once per session.
 *
 * The PDF has to carry its own font: the fourteen fonts every viewer ships are Latin-1 only, so a
 * Ukrainian document written with them would come out as blanks. Liberation Serif is used because
 * it is metric-compatible with Times New Roman — the face ДСТУ 4163:2020 documents are written in —
 * covers Cyrillic, and is redistributable under the SIL Open Font License.
 *
 * The files in `public/fonts/` are subsets: only Latin, Cyrillic and the punctuation these
 * documents use, which brings each face down to ~16 KB. They are fetched lazily, on the first
 * download, rather than bundled — a user who never exports a report never pays for them.
 */

import { TtfFont } from './pdf-writer';

export interface ReportFonts {
  regular: TtfFont;
  bold: TtfFont;
}

const FONT_FILES = {
  regular: { file: 'fonts/LiberationSerif-Regular.ttf', postScriptName: 'LiberationSerif' },
  bold:    { file: 'fonts/LiberationSerif-Bold.ttf',    postScriptName: 'LiberationSerif-Bold' }
} as const;

/** Kept as a promise, so concurrent clicks share one fetch and a failure can be retried. */
let pending: Promise<ReportFonts> | null = null;

export function loadReportFonts(): Promise<ReportFonts> {
  if (!pending) {
    pending = Promise.all(
      (Object.keys(FONT_FILES) as (keyof typeof FONT_FILES)[]).map(async (key) => {
        const { file, postScriptName } = FONT_FILES[key];
        // Resolved against <base href> so the app still works when deployed under a sub-path.
        const url = new URL(file, document.baseURI).toString();
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Не вдалося завантажити шрифт ${file} (${response.status})`);
        return [key, TtfFont.parse(new Uint8Array(await response.arrayBuffer()), postScriptName)] as const;
      })
    ).then((pairs) => Object.fromEntries(pairs) as unknown as ReportFonts)
     .catch((e) => { pending = null; throw e; });
  }
  return pending;
}

/** Hands a generated document to the browser as a download. */
export function downloadPdf(bytes: Uint8Array, fileName: string): void {
  const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking immediately can race the download in some browsers; one tick is enough.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
