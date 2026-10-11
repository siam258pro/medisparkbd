// Clean-strokes beautification (Phase 2): keeps the user's own style.
// Pipeline per stroke: One-Euro adaptive smoothing -> RDP simplify
// (simplify-js) -> baseline straighten (<=10deg). Group level: capped
// height normalization. Rendered with perfect-freehand variable width.
import simplify from 'simplify-js';
import type { InkPoint, Stroke } from './types.ts';
import { bbox, lineDirection } from './geometry.ts';

export interface CleanOptions {
  minCutoff?: number;
  beta?: number;
  tolerance?: number;
  maxTiltDeg?: number;
}

/** One-Euro adaptive filter over x/y using point timestamps. */
export function oneEuroFilter(pts: InkPoint[], minCutoff = 1.0, beta = 0.02, dcutoff = 1.0): InkPoint[] {
  if (pts.length < 3) return pts.slice();
  const smoothFactor = (tE: number, cutoff: number) => {
    const r = 2 * Math.PI * cutoff * Math.max(1e-3, tE);
    return r / (r + 1);
  };
  const run = (vals: number[]): number[] => {
    let xPrev = vals[0], dxPrev = 0, tPrev = pts[0].t;
    const out = [vals[0]];
    for (let i = 1; i < vals.length; i++) {
      const tE = Math.max(1e-3, (Math.max(1, pts[i].t - tPrev)) / 1000);
      const aD = smoothFactor(tE, dcutoff);
      const dx = (vals[i] - xPrev) / tE;
      const dxHat = aD * dx + (1 - aD) * dxPrev;
      const cutoff = minCutoff + beta * Math.abs(dxHat);
      const a = smoothFactor(tE, cutoff);
      const xHat = a * vals[i] + (1 - a) * xPrev;
      out.push(xHat);
      xPrev = xHat; dxPrev = dxHat; tPrev = pts[i].t;
    }
    return out;
  };
  const xs = run(pts.map((p) => p.x));
  const ys = run(pts.map((p) => p.y));
  return pts.map((p, i) => ({ ...p, x: xs[i], y: ys[i] }));
}

/** RDP simplification via simplify-js (keeps t/p metadata on survivors). */
export function simplifyPoints(pts: InkPoint[], tolerance = 1.2): InkPoint[] {
  if (pts.length < 3) return pts.slice();
  return simplify(pts, tolerance, false) as InkPoint[];
}

/** Rotate a stroke upright when its baseline tilt is within maxTiltDeg. */
export function straightenBaseline(pts: InkPoint[], maxTiltDeg = 10): { points: InkPoint[]; rotated: boolean; angleDeg: number } {
  if (pts.length < 3) return { points: pts.slice(), rotated: false, angleDeg: 0 };
  const angle = lineDirection(pts.map((p) => ({ x: p.x, y: p.y })));
  // Normalize to [-90, 90] so near-vertical strokes are never "straightened".
  let deg = (angle * 180) / Math.PI;
  if (deg > 90) deg -= 180;
  if (deg < -90) deg += 180;
  if (Math.abs(deg) > maxTiltDeg) return { points: pts.slice(), rotated: false, angleDeg: deg };
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p.x; cy += p.y; }
  cx /= pts.length; cy /= pts.length;
  const rad = (-deg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return {
    points: pts.map((p) => ({ ...p, x: cx + (p.x - cx) * cos - (p.y - cy) * sin, y: cy + (p.x - cx) * sin + (p.y - cy) * cos })),
    rotated: true,
    angleDeg: deg,
  };
}

/** Single-stroke clean pipeline (no group context). */
export function cleanStrokePoints(raw: InkPoint[], opts: CleanOptions = {}): InkPoint[] {
  if (raw.length < 3) return raw.slice();
  let pts = oneEuroFilter(raw, opts.minCutoff ?? 1.0, opts.beta ?? 0.02);
  pts = simplifyPoints(pts, opts.tolerance ?? 1.2);
  const { points } = straightenBaseline(pts, opts.maxTiltDeg ?? 10);
  pts = points;
  pts[0] = { ...raw[0] };
  pts[pts.length - 1] = { ...raw[raw.length - 1] };
  return pts;
}

/**
 * Group height normalization: scale each stroke's height toward the group
 * median, capped at ±10% so letterforms are never distorted.
 */
export function normalizeGroupHeight(strokes: InkPoint[][], maxAdjust = 0.1): InkPoint[][] {
  const hs = strokes.map((g) => bbox(g).h).filter((h) => h > 4 && h < 1500).sort((a, b) => a - b);
  if (!hs.length) return strokes.map((g) => g.slice());
  const med = hs[Math.floor(hs.length / 2)];
  return strokes.map((g) => {
    const b = bbox(g);
    if (b.h < 4) return g.slice();
    const scale = Math.max(1 - maxAdjust, Math.min(1 + maxAdjust, med / b.h));
    if (Math.abs(scale - 1) < 0.01) return g.slice();
    const bottom = b.y + b.h;
    return g.map((p) => ({ ...p, y: bottom - (bottom - p.y) * scale }));
  });
}

/** Guard: never re-clean an already-cleaned stroke (no compounding). */
export function cleanStroke(stroke: Stroke, opts: CleanOptions = {}): Stroke {
  const raw = stroke.originalPoints ?? stroke.points;
  if (stroke.beautified && stroke.originalPoints) return stroke;
  const pts = cleanStrokePoints(raw, opts);
  return { ...stroke, originalPoints: raw.slice(), points: pts, beautified: true, variableWidth: true };
}
