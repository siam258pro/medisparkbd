// Local stroke grouping + conservative classification.
// Spatio-temporal clustering only; geometric proximity is NOT character
// recognition, so low-confidence groups stay 'unknown' (never force-merge).
import type { Stroke } from './types.ts';
import { bbox, pathLength } from './geometry.ts';

export type GroupKind = 'handwriting' | 'shape' | 'diagram' | 'math' | 'unknown';

export interface StrokeGroup {
  strokeIds: string[];
  kind: GroupKind;
  confidence: number;
}

export interface GroupOptions {
  timeGapMs?: number;
  distPx?: number;
}

function strokeBox(s: Stroke) {
  return bbox(s.points);
}

function boxesGap(a: ReturnType<typeof bbox>, b: ReturnType<typeof bbox>): number {
  const dx = Math.max(0, Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w)));
  const dy = Math.max(0, Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)));
  return Math.hypot(dx, dy);
}

/** Point-in-polygon (ray cast) for lasso selection, in world coordinates. */
export function pointInPolygon(x: number, y: number, poly: Array<{ x: number; y: number }>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Single-pass spatio-temporal clustering in stroke order. */
export function groupStrokes(strokes: Stroke[], opts: GroupOptions = {}): StrokeGroup[] {
  const timeGap = opts.timeGapMs ?? 2500;
  const distPx = opts.distPx ?? 120;
  const groups: StrokeGroup[] = [];
  let current: Stroke[] = [];
  const flush = () => {
    if (current.length) groups.push(classify(current));
    current = [];
  };
  const ordered = strokes.slice().sort((a, b) => a.createdAt - b.createdAt);
  for (const s of ordered) {
    const prev = current[current.length - 1];
    if (!prev) { current.push(s); continue; }
    const dt = s.createdAt - prev.createdAt;
    const gap = boxesGap(strokeBox(prev), strokeBox(s));
    if (dt <= timeGap && gap <= distPx) current.push(s);
    else { flush(); current.push(s); }
  }
  flush();
  return groups;
}

/** Straightness 0..1 (chord length / path length). */
function straightness(s: Stroke): number {
  const p = s.points;
  if (p.length < 2) return 1;
  const chord = Math.hypot(p[p.length - 1].x - p[0].x, p[p.length - 1].y - p[0].y);
  const len = pathLength(p);
  if (len < 1e-6) return 1;
  return chord / len;
}

function isClosed(s: Stroke): boolean {
  const p = s.points;
  if (p.length < 8) return false;
  const d = Math.hypot(p[p.length - 1].x - p[0].x, p[p.length - 1].y - p[0].y);
  const b = strokeBox(s);
  return d < Math.min(b.w, b.h) * 0.35 + 8;
}

function hasFractionBarLike(strokes: Stroke[]): boolean {
  // long straight horizontal stroke with small strokes above and below
  return strokes.some((s) => {
    const b = strokeBox(s);
    if (straightness(s) < 0.92 || b.w < 40 || b.h > Math.max(8, b.w * 0.2)) return false;
    const above = strokes.some((o) => o !== s && strokeBox(o).y + strokeBox(o).h < b.y - 4);
    const below = strokes.some((o) => o !== s && strokeBox(o).y > b.y + b.h + 4);
    return above && below;
  });
}

function classify(strokes: Stroke[]): StrokeGroup {
  const ids = strokes.map((s) => s.id);
  // Single straight/closed strokes are shapes, arrows, or underlines — not words.
  if (strokes.length === 1) {
    const s = strokes[0];
    if (s.tool === 'line' || s.tool === 'arrow' || s.tool === 'rect' || s.tool === 'ellipse') {
      return { strokeIds: ids, kind: 'shape', confidence: 0.95 };
    }
    const st = straightness(s);
    const b = strokeBox(s);
    const long = Math.max(b.w, b.h);
    if (st > 0.96 && long > 60) return { strokeIds: ids, kind: 'shape', confidence: 0.8 }; // line/underline/arrow shaft
    if (isClosed(s) && long > 50) return { strokeIds: ids, kind: 'shape', confidence: 0.7 };
    return { strokeIds: ids, kind: 'unknown', confidence: 0.4 };
  }
  if (hasFractionBarLike(strokes)) return { strokeIds: ids, kind: 'math', confidence: 0.75 };
  const closedCount = strokes.filter(isClosed).length;
  const straightCount = strokes.filter((s) => straightness(s) > 0.94).length;
  const many = strokes.length >= 5;
  if ((closedCount >= 2 && many) || straightCount >= 3) {
    return { strokeIds: ids, kind: 'diagram', confidence: 0.6 };
  }
  // Small clustered freehand strokes close in time+space: likely handwriting.
  const boxes = strokes.map(strokeBox);
  const allW = Math.max(...boxes.map((b) => b.x + b.w)) - Math.min(...boxes.map((b) => b.x));
  const heights = boxes.map((b) => b.h).filter((h) => h > 2);
  const medH = heights.sort((a, b) => a - b)[Math.floor(heights.length / 2)] ?? 0;
  if (medH > 6 && medH < 400 && allW < 3000) {
    return { strokeIds: ids, kind: 'handwriting', confidence: 0.65 };
  }
  return { strokeIds: ids, kind: 'unknown', confidence: 0.4 };
}
