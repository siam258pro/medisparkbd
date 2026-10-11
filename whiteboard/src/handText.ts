// Convert-to-text helpers (Phase 4): font picking, font loading,
// width-fitted sizing. Canvas measuring is injectable for unit tests.
import { splitMixedLine } from './recognizer.ts';

export const EN_FONT = '"Caveat", "Segoe Script", cursive';
export const BN_FONT = '"Atma", "Noto Sans Bengali", cursive';

/** One font per line: the dominant script's font wins. */
export function pickFont(text: string): string {
  const runs = splitMixedLine(text);
  let bn = 0, en = 0;
  for (const r of runs) {
    if (r.script === 'bn') bn += r.text.length;
    else if (r.script === 'en') en += r.text.length;
  }
  if (!bn && !en) return EN_FONT;
  return bn >= en ? BN_FONT : EN_FONT;
}

/** Ensure handwriting fonts are loaded before measuring/drawing. */
export async function ensureFonts(): Promise<void> {
  if (typeof document === 'undefined' || !('fonts' in document)) return;
  try {
    await Promise.all([
      document.fonts.load('16px Caveat', 'hello'),
      document.fonts.load('16px Atma', 'বিজ্ঞান'),
    ]);
  } catch {
    /* offline-first: fall back to system fonts */
  }
}

/** Shrink font size until text fits maxWidth (measure injected for tests). */
export function fitFontSize(
  text: string,
  font: string,
  maxWidth: number,
  startPx: number,
  measure: (fontCss: string, text: string) => number,
  minPx = 10,
): number {
  let px = Math.max(minPx, startPx);
  let guard = 0;
  while (px > minPx && measure(`${px}px ${font}`, text) > maxWidth && guard++ < 40) {
    px = Math.max(minPx, px * 0.92);
  }
  return px;
}

/** Width of a canvas-measured string (browser helper). */
export function measureCanvas(fontCss: string, text: string): number {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  if (!ctx) return text.length * 10;
  ctx.font = fontCss;
  return ctx.measureText(text).width;
}
