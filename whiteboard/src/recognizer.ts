// Handwriting recognition interface + language utilities (Phase 3).
// Pluggable: VisionLlmRecognizer (backend vision LLM) now, native on-device
// backends later (e.g. via Capacitor + ML Kit). Pure helpers are unit-tested.
import type { Stroke } from './types.ts';

export type RecLang = 'en' | 'bn' | 'mixed' | 'unknown';

export interface RecResult {
  text: string;
  lang: RecLang;
  confidence: number;
  alternatives: string[];
}

export interface HandwritingRecognizer {
  id: string;
  recognize(strokes: Stroke[], opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<RecResult>;
}

const BENGALI_RE = /[\u0980-\u09FF]/; // Bengali block
const LATIN_RE = /[A-Za-z]/;

/** Normalize Bangla output to Unicode NFC. */
export function normalizeBanglaNFC(s: string): string {
  return s.normalize('NFC');
}

export function containsBengali(s: string): boolean {
  return BENGALI_RE.test(s);
}

export function containsLatin(s: string): boolean {
  return LATIN_RE.test(s);
}

function detectScript(text: string): RecLang {
  const bn = containsBengali(text), en = containsLatin(text);
  if (bn && en) return 'mixed';
  if (bn) return 'bn';
  if (en) return 'en';
  return 'unknown';
}

/** Trust-but-verify: override a claimed lang that contradicts Unicode ranges. */
export function verifyLang(text: string, claimed: RecLang): RecLang {
  const seen = detectScript(text);
  if (seen === 'unknown') return claimed === 'en' || claimed === 'bn' || claimed === 'mixed' ? claimed : 'unknown';
  if (claimed === 'mixed' || seen === 'mixed') return 'mixed';
  return seen;
}

export interface ScriptRun { script: 'bn' | 'en' | 'other'; text: string; }

/** Split a mixed line into script runs (digits/punctuation stay attached). */
export function splitMixedLine(text: string): ScriptRun[] {
  const runs: ScriptRun[] = [];
  let cur = '', kind: ScriptRun['script'] | null = null;
  const klass = (ch: string): ScriptRun['script'] =>
    BENGALI_RE.test(ch) ? 'bn' : LATIN_RE.test(ch) ? 'en' : 'other';
  for (const ch of text) {
    const k = klass(ch);
    const eff: ScriptRun['script'] = k === 'other' ? (kind ?? 'other') : k;
    if (kind !== null && eff !== kind) {
      runs.push({ script: kind, text: cur });
      cur = '';
    }
    kind = eff;
    cur += ch;
  }
  if (cur) runs.push({ script: kind ?? 'other', text: cur });
  return runs.filter((r) => r.text.length > 0);
}

/** Below this confidence the app never auto-replaces (chips instead). */
export const LOW_CONFIDENCE = 0.6;

/** Deterministic hash of stroke geometry for caching (cyrb53). */
export function hashStrokes(strokes: Stroke[]): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  const mix = (n: number) => {
    const x = Math.round(n * 10);
    h1 = Math.imul(h1 ^ x, 2654435761);
    h2 = Math.imul(h2 ^ x, 1597334677);
  };
  for (const s of strokes) for (const p of s.points) { mix(p.x); mix(p.y); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/** Validate + sanitize a backend payload into a RecResult. */
export function sanitizeResult(data: unknown, fallbackLang: RecLang = 'unknown'): RecResult {
  const d = (data ?? {}) as Record<string, unknown>;
  const text = normalizeBanglaNFC(typeof d.text === 'string' ? d.text.slice(0, 500) : '');
  const claimed = (d.lang === 'en' || d.lang === 'bn' || d.lang === 'mixed' ? d.lang : fallbackLang) as RecLang;
  const confidence = typeof d.confidence === 'number' ? Math.max(0, Math.min(1, d.confidence)) : 0;
  const alternatives = Array.isArray(d.alternatives)
    ? d.alternatives.filter((a): a is string => typeof a === 'string').map((a) => normalizeBanglaNFC(a.slice(0, 500))).slice(0, 5)
    : [];
  return { text, lang: verifyLang(text, claimed), confidence, alternatives };
}

/**
 * Rasterize a stroke group to a high-contrast PNG (black ink on white,
 * padded, ~lineHeight px tall) for the vision recognizer.
 */
export async function rasterizeStrokes(strokes: Stroke[], lineHeight = 192): Promise<Blob> {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) for (const p of s.points) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  if (!isFinite(x0)) throw new Error('No ink to rasterize.');
  const pad = 16;
  const h = Math.max(8, y1 - y0);
  const scale = Math.min(4, lineHeight / h);
  const W = Math.min(1600, Math.ceil((x1 - x0) * scale + pad * 2));
  const H = Math.ceil(h * scale + pad * 2);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, W);
  canvas.height = Math.max(1, H);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D unavailable.');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#000000';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of strokes) {
    const pts = s.originalPoints ?? s.points;
    ctx.lineWidth = Math.max(2, (s.width || 3) * scale * 0.8);
    ctx.beginPath();
    pts.forEach((p, i) => {
      const X = (p.x - x0) * scale + pad, Y = (p.y - y0) * scale + pad;
      if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y);
    });
    ctx.stroke();
  }
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
  if (!blob) throw new Error('PNG encode failed.');
  return blob;
}

/** Backend vision-LLM recognizer: POSTs PNG to same-origin /api/recognize. */
export class VisionLlmRecognizer implements HandwritingRecognizer {
  id = 'vision-llm';
  async recognize(strokes: Stroke[], opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<RecResult> {
    const blob = await rasterizeStrokes(strokes);
    const fd = new FormData();
    fd.append('image', blob, 'line.png');
    fd.append('hash', hashStrokes(strokes));
    const res = await fetch('/api/recognize', {
      method: 'POST',
      body: fd,
      signal: opts?.signal ?? AbortSignal.timeout(opts?.timeoutMs ?? 30000),
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => res.statusText);
      throw new Error(`Recognizer HTTP ${res.status}: ${msg.slice(0, 200)}`);
    }
    return sanitizeResult(await res.json());
  }
}

/** In-memory mock backend for unit tests and offline demos. */
export class MockRecognizer implements HandwritingRecognizer {
  id = 'mock';
  private handler: (strokes: Stroke[]) => RecResult | Promise<RecResult>;
  constructor(handler: (strokes: Stroke[]) => RecResult | Promise<RecResult>) {
    this.handler = handler;
  }
  recognize(strokes: Stroke[]): Promise<RecResult> {
    return Promise.resolve(this.handler(strokes));
  }
}
