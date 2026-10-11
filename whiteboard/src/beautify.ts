// Deterministic beautification engine (geometric only — no ML, no network).
// Pipeline per stroke: denoise -> corner-aware smooth -> resample -> light simplify.
// Layout correction per group: small baseline/skew/spacing nudges with hard caps,
// skipped entirely for math/diagram/shape groups.
import type { BeautifyStrength, InkPoint, PersonalParams, Stroke } from './types.ts';
import { bbox, catmullRom, lineDirection, pathLength, rdp, smoothAdaptive, smoothSpeedAware, resampleEven } from './geometry.ts';

export const STRENGTH_LEVEL: Record<BeautifyStrength, 0 | 1 | 2> = {
  subtle: 0, balanced: 1, strong: 2,
};

export const DEFAULT_PARAMS: PersonalParams = {
  smoothingBias: 0,
  slant: 0,
  avgHeight: 48,
  avgWidth: 3,
  spacing: 28,
};

const MAX_SHIFT = { subtle: 2, balanced: 5, strong: 9 } as const;
const MAX_SHEAR = { subtle: 0.01, balanced: 0.03, strong: 0.06 } as const;

export function beautifyStrokePoints(
  raw: InkPoint[],
  strength: BeautifyStrength = 'balanced',
  personal?: PersonalParams,
): InkPoint[] {
  if (raw.length < 3) return raw.slice();
  const lvl = STRENGTH_LEVEL[strength];
  // v2 pipeline: speed-aware denoise (fast loops smoothed more, slow detail
  // preserved) -> even arc-length resample -> curve fit -> light simplify.
  let pts = smoothSpeedAware(raw, lvl);
  if (personal && personal.smoothingBias > 0.05 && lvl < 2) {
    // One extra light pass only; never cascade (input must be raw ink).
    pts = smoothAdaptive(pts, 0);
  }
  pts = resampleEven(pts, lvl === 0 ? 3 : lvl === 1 ? 4 : 5);
  const subdiv = lvl === 0 ? 2 : lvl === 1 ? 3 : 4;
  pts = catmullRom(pts, subdiv);
  pts = rdp(pts, lvl === 0 ? 0.6 : lvl === 1 ? 1.0 : 1.5);
  // Endpoint preservation: exact original endpoints.
  pts[0] = { ...raw[0] };
  pts[pts.length - 1] = { ...raw[raw.length - 1] };
  return pts;
}

/** Median character height estimate for a group (bbox heights). */
export function estimateCharHeight(strokes: Stroke[]): number {
  const hs = strokes
    .map((s) => bbox(s.points).h)
    .filter((h) => h > 4 && h < 1200)
    .sort((a, b) => a - b);
  if (hs.length === 0) return DEFAULT_PARAMS.avgHeight;
  return hs[Math.floor(hs.length / 2)];
}

function centroid(pts: InkPoint[]): { x: number; y: number } {
  let x = 0, y = 0;
  for (const p of pts) { x += p.x; y += p.y; }
  return { x: x / pts.length, y: y / pts.length };
}

/**
 * Conservative group layout correction. Returns shifted copies; shifts are
 * capped so Bangla diacritics/conjuncts are never pulled apart. Callers must
 * skip math/diagram/shape groups before invoking.
 */
export function layoutCorrectGroup(
  groups: InkPoint[][],
  strength: BeautifyStrength,
  personal: PersonalParams = DEFAULT_PARAMS,
): InkPoint[][] {
  if (groups.length < 2) return groups.map((g) => g.slice());
  const maxShift = MAX_SHIFT[strength];
  const maxShear = MAX_SHEAR[strength];
  const cents = groups.map(centroid);
  const angle = lineDirection(cents);
  // Only correct near-horizontal writing lines (<= ~12deg); never rotate diagrams.
  if (Math.abs(angle) > 0.21) return groups.map((g) => g.slice());
  const meanY = cents.reduce((a, c) => a + c.y, 0) / cents.length;
  const shear = Math.max(-maxShear, Math.min(maxShear, Math.tan(angle) * 0.5 - personal.slant * 0.1));
  const meanX = cents.reduce((a, c) => a + c.x, 0) / cents.length;
  return groups.map((g, i) => {
    const dy = Math.max(-maxShift, Math.min(maxShift, (meanY - cents[i].y) * 0.35));
    if (Math.abs(dy) < 0.3 && Math.abs(shear) < 0.004) return g.slice();
    return g.map((p) => ({ ...p, x: p.x - shear * (p.y - meanY), y: p.y + dy * 0.5 + shear * (p.x - meanX) * 0.2 }));
  });
}

/** Guard: never beautify an already-beautified stroke again (no compounding). */
export function beautifyStroke(stroke: Stroke, strength: BeautifyStrength, personal?: PersonalParams): Stroke {
  const raw = stroke.originalPoints ?? stroke.points;
  if (stroke.beautified && stroke.originalPoints) return stroke; // already processed
  const pts = beautifyStrokePoints(raw, strength, personal);
  return { ...stroke, originalPoints: raw.slice(), points: pts, beautified: true, strength };
}

/** Revert to captured raw ink. */
export function revertStroke(stroke: Stroke): Stroke {
  if (!stroke.originalPoints) return stroke;
  const { originalPoints: _drop, beautified: _b, strength: _s, ...rest } = stroke;
  return { ...rest, points: (_drop as InkPoint[]).slice() };
}

/** Average deviation of beautified vs original (px) — for compare UI honesty. */
export function deviationOf(stroke: Stroke): number {
  if (!stroke.originalPoints) return 0;
  const a = stroke.originalPoints, b = stroke.points;
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let d = 0;
  for (let i = 0; i < n; i++) d += Math.hypot(a[Math.floor(i * a.length / n)].x - b[Math.floor(i * b.length / n)].x, a[Math.floor(i * a.length / n)].y - b[Math.floor(i * b.length / n)].y);
  void pathLength;
  return d / n;
}
