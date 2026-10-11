// Local PDF template loader (pdfjs-dist, fully offline after npm install).
// Renders each page to a JPEG dataURL + world size for canvas background use.
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export interface PdfTemplateData {
  name: string;
  pages: string[];
  /** world-unit size of each page image */
  pw: number;
  ph: number;
  /** world top-left where the template is anchored */
  ox: number;
  oy: number;
  pageIndex: number;
}

const MAX_W = 1600;

/** Render all pages of a PDF file to background images. */
export async function loadPdfTemplate(
  file: File,
  anchor: { x: number; y: number },
  onProgress?: (done: number, total: number) => void,
): Promise<PdfTemplateData> {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
  const pages: string[] = [];
  let pw = 800, ph = 600;
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const vp0 = page.getViewport({ scale: 1 });
    const scale = Math.min(2.5, MAX_W / vp0.width);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, viewport: vp }).promise;
    pages.push(canvas.toDataURL('image/jpeg', 0.85));
    if (i === 1) {
      // World units: keep on-screen size ≈ rendered px at zoom 1.
      pw = canvas.width;
      ph = canvas.height;
    }
    onProgress?.(i, pdf.numPages);
    page.cleanup();
  }
  return { name: file.name, pages, pw, ph, ox: anchor.x - pw / 2, oy: anchor.y - ph / 2, pageIndex: 0 };
}
