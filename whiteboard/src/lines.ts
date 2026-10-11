// Word/line grouping for handwriting recognition (Phase 1).
// Deterministic: pause threshold + spatial proximity. Pure functions.
// This does NOT recognize characters — it only clusters strokes into
// candidate lines and words for a recognizer backend (Phase 2).
import type { Stroke } from './types.ts';
import { bbox } from './geometry.ts';

export interface TextWord {
  strokeIds: string[];
  bbox: { x: number; y: number; w: number; h: number };
}

export interface TextLine {
  words: TextWord[];
  bbox: { x: number; y: number; w: number; h: number };
}

export interface LineGroupOptions {
  /** pause between strokes that forces a word split (ms) */
  pauseMs?: number;
  /** horizontal gap (× char height) that forces a word split */
  wordGapFactor?: number;
  /** vertical gap (× char height) that forces a new line */
  lineGapFactor?: number;
}

function union(a: { x: number; y: number; w: number; h: number } | null, b: { x: number; y: number; w: number; h: number }) {
  if (!a) return { ...b };
  const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w), y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function medianCharHeight(strokes: Stroke[]): number {
  const hs = strokes.map((s) => bbox(s.points).h).filter((h) => h > 3 && h < 1500).sort((a, b) => a - b);
  if (!hs.length) return 48;
  return hs[Math.floor(hs.length / 2)];
}

/**
 * Cluster strokes into lines (top-to-bottom), each split into words
 * (left-to-right). Word split on pause OR wide horizontal gap; line split
 * on vertical gap. Single-point/image/text strokes are skipped (not ink).
 */
export function groupIntoLines(strokes: Stroke[], opts: LineGroupOptions = {}): TextLine[] {
  const pauseMs = opts.pauseMs ?? 700;
  const wordGapFactor = opts.wordGapFactor ?? 0.8;
  const lineGapFactor = opts.lineGapFactor ?? 0.6;
  const ink = strokes.filter((s) => !s.isImage && s.text === undefined && s.points.length > 0);
  if (!ink.length) return [];
  const charH = medianCharHeight(ink);
  const boxes = new Map(ink.map((s) => [s.id, bbox(s.points)] as const));

  // 1. Row clustering by vertical position.
  const byTop = ink.slice().sort((a, b) => boxes.get(a.id)!.y - boxes.get(b.id)!.y || boxes.get(a.id)!.x - boxes.get(b.id)!.x);
  const rows: Stroke[][] = [];
  let rowBottom = -Infinity;
  for (const s of byTop) {
    const b = boxes.get(s.id)!;
    if (rows.length === 0 || b.y - rowBottom > lineGapFactor * charH) {
      rows.push([s]);
      rowBottom = b.y + b.h;
    } else {
      rows[rows.length - 1].push(s);
      rowBottom = Math.max(rowBottom, b.y + b.h);
    }
  }

  // 2. Within each row: left-to-right, split words on pause or wide gap.
  const lines: TextLine[] = [];
  for (const row of rows) {
    const ordered = row.slice().sort((a, b) => boxes.get(a.id)!.x - boxes.get(b.id)!.x);
    const words: TextWord[] = [];
    let cur: Stroke[] = [];
    let prev: Stroke | null = null;
    const flush = () => {
      if (!cur.length) return;
      let wb: { x: number; y: number; w: number; h: number } | null = null;
      for (const s of cur) wb = union(wb, boxes.get(s.id)!);
      words.push({ strokeIds: cur.map((s) => s.id), bbox: wb! });
      cur = [];
    };
    for (const s of ordered) {
      if (prev) {
        const pb = boxes.get(prev.id)!, sb = boxes.get(s.id)!;
        const gap = sb.x - (pb.x + pb.w);
        const dt = Math.abs(s.createdAt - prev.createdAt);
        if (dt > pauseMs || gap > wordGapFactor * charH) flush();
      }
      cur.push(s);
      prev = s;
    }
    flush();
    let lb: { x: number; y: number; w: number; h: number } | null = null;
    for (const w of words) lb = union(lb, w.bbox);
    if (words.length) lines.push({ words, bbox: lb! });
  }
  return lines;
}
