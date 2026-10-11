// Ink-to-shape: recognize deliberately-drawn rough shapes and convert them
// to perfect parametric geometry (Microsoft-Whiteboard-style). Conservative:
// only converts when the evidence is strong; otherwise leaves raw ink alone.
import type { InkPoint } from './types.ts';
import { bbox, detectCorners, dist, pathLength } from './geometry.ts';

export interface DetectedShape {
  shape: 'line' | 'rect' | 'ellipse';
  ax: number; ay: number; bx: number; by: number;
}

function straightness(pts: InkPoint[]): number {
  if (pts.length < 2) return 1;
  const chord = dist(pts[0], pts[pts.length - 1]);
  const len = pathLength(pts);
  return len < 1e-6 ? 1 : chord / len;
}

/**
 * Classify a raw pen stroke. Returns null when it is NOT clearly a shape
 * (ordinary handwriting must never be converted).
 */
export function detectInkShape(raw: InkPoint[]): DetectedShape | null {
  if (raw.length < 6) return null;
  const b = bbox(raw);
  const size = Math.max(b.w, b.h);
  if (size < 50) return null; // too small to be a deliberate shape
  const len = pathLength(raw);
  const st = straightness(raw);

  // 1. Straight line: very high chord/path ratio.
  if (st > 0.965 && size > 60) {
    return { shape: 'line', ax: raw[0].x, ay: raw[0].y, bx: raw[raw.length - 1].x, by: raw[raw.length - 1].y };
  }

  // Closed-ish loop candidates only from here on.
  const endGap = dist(raw[0], raw[raw.length - 1]);
  if (endGap > size * 0.45) return null;

  const corners = detectCorners(raw, 50, 3);
  // 2. Rectangle: ~4 sharp corners and boxy fill.
  if (corners.length >= 3 && corners.length <= 6 && b.w > 30 && b.h > 25) {
    const area = b.w * b.h;
    // Stroke length of a rectangle outline ≈ perimeter; handwriting loops differ.
    const peri = 2 * (b.w + b.h);
    if (len > peri * 0.55 && len < peri * 1.9) {
      return { shape: 'rect', ax: b.x, ay: b.y, bx: b.x + b.w, by: b.y + b.h };
    }
  }
  // 3. Ellipse/circle: no strong corners, round fill, loop-like length.
  if (corners.length <= 2) {
    const rx = b.w / 2, ry = b.h / 2;
    if (rx > 15 && ry > 12) {
      const expected = Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry))); // Ramanujan
      if (len > expected * 0.5 && len < expected * 1.8) {
        const aspect = Math.min(b.w, b.h) / Math.max(b.w, b.h);
        if (aspect > 0.25) {
          return { shape: 'ellipse', ax: b.x, ay: b.y, bx: b.x + b.w, by: b.y + b.h };
        }
      }
    }
  }
  return null;
}
