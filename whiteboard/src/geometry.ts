// Deterministic pen-stroke geometry: smoothing, corners, resampling.
// No ML, no network. Pure functions so they run in tests + workers.
import type { InkPoint } from './types.ts';

export function dist(a: InkPoint, b: InkPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function pathLength(pts: InkPoint[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
  return L;
}

export function bbox(pts: InkPoint[]): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x; if (p.y > y1) y1 = p.y;
  }
  if (!isFinite(x0)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Remove consecutive duplicate/near-zero-length points (digitizer noise). */
export function dedupe(pts: InkPoint[], minDist = 0.75): InkPoint[] {
  if (pts.length < 2) return pts.slice();
  const out: InkPoint[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (dist(out[out.length - 1], pts[i]) >= minDist) out.push(pts[i]);
  }
  if (out.length === 1 && pts.length > 1) out.push(pts[pts.length - 1]);
  return out;
}

/** Small moving-average denoise. Window must be odd; preserves endpoints. */
export function movingAverage(pts: InkPoint[], window = 3): InkPoint[] {
  if (pts.length <= 2 || window <= 1) return pts.slice();
  const half = Math.floor(window / 2);
  return pts.map((p, i) => {
    if (i === 0 || i === pts.length - 1) return { ...p };
    let sx = 0, sy = 0, n = 0;
    for (let k = -half; k <= half; k++) {
      const q = pts[i + k];
      if (!q) continue;
      sx += q.x; sy += q.y; n++;
    }
    return { ...p, x: sx / n, y: sy / n };
  });
}

/** Angle (radians) at b formed by a->b->c. */
function cornerAngle(a: InkPoint, b: InkPoint, c: InkPoint): number {
  const v1x = a.x - b.x, v1y = a.y - b.y;
  const v2x = c.x - b.x, v2y = c.y - b.y;
  const d1 = Math.hypot(v1x, v1y), d2 = Math.hypot(v2x, v2y);
  if (d1 < 1e-6 || d2 < 1e-6) return Math.PI;
  const cos = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (d1 * d2)));
  return Math.acos(cos);
}

/**
 * Corner indices where direction changes sharply.
 * lookahead smooths over jitter so only intentional cusps trigger.
 */
export function detectCorners(pts: InkPoint[], thresholdDeg = 55, lookahead = 3): number[] {
  const out: number[] = [];
  if (pts.length < 2 * lookahead + 1) return out;
  const th = (thresholdDeg * Math.PI) / 180;
  for (let i = lookahead; i < pts.length - lookahead; i++) {
    const ang = cornerAngle(pts[i - lookahead], pts[i], pts[i + lookahead]);
    if (ang < Math.PI - th) {
      if (out.length === 0 || i - out[out.length - 1] > lookahead) out.push(i);
    }
  }
  return out;
}

function catmullRomPoint(p0: InkPoint, p1: InkPoint, p2: InkPoint, p3: InkPoint, t: number): InkPoint {
  const t2 = t * t, t3 = t2 * t;
  return {
    x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
    t: p1.t + (p2.t - p1.t) * t,
    p: p1.p !== undefined ? p1.p + ((p2.p ?? p1.p) - p1.p) * t : undefined,
  };
}

/** Catmull-Rom resample: subdivid per segment; endpoints preserved exactly. */
export function catmullRom(pts: InkPoint[], subdiv = 4): InkPoint[] {
  if (pts.length < 3 || subdiv < 1) return pts.slice();
  const out: InkPoint[] = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let k = 1; k <= subdiv; k++) out.push(catmullRomPoint(p0, p1, p2, p3, k / subdiv));
  }
  return out;
}

/** Ramer-Douglas-Peucker simplification (keeps shape, drops redundant points). */
export function rdp(pts: InkPoint[], eps = 1.2): InkPoint[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Array<boolean>(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  const perp = (p: InkPoint, a: InkPoint, b: InkPoint): number => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return dist(p, a);
    return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
  };
  while (stack.length) {
    const [s, e] = stack.pop() as [number, number];
    let dmax = 0, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = perp(pts[i], pts[s], pts[e]);
      if (d > dmax) { dmax = d; idx = i; }
    }
    if (dmax > eps && idx > 0) { keep[idx] = true; stack.push([s, idx], [idx, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/**
 * Adaptive smoothing: split at corners, smooth each run, rejoin at exact
 * corner points so intentional sharp turns (Bangla angles, cusps) survive.
 */
export function smoothAdaptive(pts: InkPoint[], strength: 0 | 1 | 2): InkPoint[] {
  const clean = dedupe(pts);
  if (clean.length < 3) return clean;
  const window = strength === 0 ? 3 : strength === 1 ? 5 : 7;
  const threshold = strength === 2 ? 70 : 55;
  const corners = detectCorners(clean, threshold, 3);
  if (corners.length === 0) return movingAverage(clean, window);
  const bounds = [0, ...corners, clean.length - 1];
  const out: InkPoint[] = [];
  for (let s = 0; s < bounds.length - 1; s++) {
    const seg = clean.slice(bounds[s], bounds[s + 1] + 1);
    const sm = seg.length > 2 ? movingAverage(seg, window) : seg;
    // keep exact corner endpoints
    sm[0] = { ...clean[bounds[s]] };
    sm[sm.length - 1] = { ...clean[bounds[s + 1]] };
    out.push(...(s > 0 ? sm.slice(1) : sm));
  }
  // Wide windows on short runs can collapse neighbours onto identical
  // coordinates; drop degenerates so downstream curvature stays valid.
  return dedupe(out, 1.0);
}

/** Linear least-squares fit of stroke centroids -> writing-line direction. */
export function lineDirection(centroids: Array<{ x: number; y: number }>): number {  const n = centroids.length;
  if (n < 2) return 0;
  let mx = 0, my = 0;
  for (const c of centroids) { mx += c.x; my += c.y; }
  mx /= n; my /= n;
  let sxy = 0, sxx = 0;
  for (const c of centroids) { sxy += (c.x - mx) * (c.y - my); sxx += (c.x - mx) * (c.x - mx); }
  if (sxx < 1e-9) return Math.PI / 2;
  return Math.atan2(sxy, sxx);
}

/** Instantaneous speed (px/ms) per point from timestamps. */
export function pointSpeeds(pts: InkPoint[]): number[] {
  const out = new Array<number>(pts.length).fill(0);
  for (let i = 1; i < pts.length; i++) {
    const dt = Math.max(1, pts[i].t - pts[i - 1].t);
    out[i] = dist(pts[i - 1], pts[i]) / dt;
  }
  out[0] = out[1] ?? 0;
  return out;
}

/**
 * Speed-aware smoothing: fast pen motion (long loops, connectors) gets a
 * wider denoising window; slow careful motion (details, diacritics) keeps a
 * narrow window. Corner-split first so cusps are never rounded. Endpoints
 * preserved exactly.
 */
export function smoothSpeedAware(pts: InkPoint[], strength: 0 | 1 | 2): InkPoint[] {
  const clean = dedupe(pts);
  if (clean.length < 3) return clean;
  const speeds = pointSpeeds(clean);
  const sorted = speeds.slice().sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const lo = q(0.25), hi = Math.max(lo + 1e-6, q(0.9));
  const base = strength === 0 ? 1 : strength === 1 ? 2 : 3; // half-window baseline
  const threshold = strength === 2 ? 70 : 55;
  const corners = detectCorners(clean, threshold, 3);
  const bounds = [0, ...corners, clean.length - 1];
  const out: InkPoint[] = [];
  for (let s = 0; s < bounds.length - 1; s++) {
    const seg = clean.slice(bounds[s], bounds[s + 1] + 1);
    const sm = seg.map((p, i) => {
      const gi = bounds[s] + i;
      const norm = Math.max(0, Math.min(1, (speeds[gi] - lo) / hi));
      const half = Math.max(1, Math.round(base * (0.6 + 1.1 * norm)));
      let sx = 0, sy = 0, n = 0;
      for (let k = -half; k <= half; k++) {
        const qpt = seg[i + k];
        if (!qpt) continue;
        sx += qpt.x; sy += qpt.y; n++;
      }
      return { ...p, x: sx / n, y: sy / n };
    });
    sm[0] = { ...clean[bounds[s]] };
    sm[sm.length - 1] = { ...clean[bounds[s + 1]] };
    out.push(...(s > 0 ? sm.slice(1) : sm));
  }
  return dedupe(out, 1.0);
}

/**
 * Arc-length even resampling: uniform point spacing gives smooth,
 * constant-quality curves and stable rendering at any zoom. Endpoints exact.
 */
export function resampleEven(pts: InkPoint[], spacing = 4): InkPoint[] {
  const clean = dedupe(pts, 0.5);
  if (clean.length < 2 || spacing <= 0) return clean.slice();
  const total = pathLength(clean);
  if (total < 1e-9) return clean.slice(0, 1);
  const count = Math.max(1, Math.round(total / spacing));
  const out: InkPoint[] = [{ ...clean[0] }];
  let acc = 0, target = total / count, si = 1;
  let prev = clean[0];
  for (let i = 1; i < clean.length; i++) {
    let segStart = prev;
    const segEnd = clean[i];
    let segLen = dist(segStart, segEnd);
    while (acc + segLen >= target && segLen > 1e-9) {
      const need = target - acc;
      const t = need / segLen;
      const np: InkPoint = {
        x: segStart.x + (segEnd.x - segStart.x) * t,
        y: segStart.y + (segEnd.y - segStart.y) * t,
        t: Math.round(segStart.t + (segEnd.t - segStart.t) * t),
        p: segStart.p,
      };
      out.push(np);
      segStart = np;
      segLen = dist(segStart, segEnd);
      acc = 0;
      target = total / count;
    }
    acc += segLen;
    prev = clean[i];
  }
  out.push({ ...clean[clean.length - 1] });
  return out;
}
