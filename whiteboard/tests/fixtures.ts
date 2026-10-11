// Recorded-style stroke fixtures for pipeline tests (Phase 6).
// Synthetic but structurally faithful: multi-stroke Latin word, Bangla word
// with vowel signs + conjunct cluster + diacritic, and a mixed line.
// A seeded PRNG keeps them deterministic.
import type { InkPoint, Stroke } from '../src/types.ts';

function rng(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5;
}

function stroke(id: string, path: Array<[number, number]>, t0: number, jitter: number, r: () => number): Stroke {
  const pts: InkPoint[] = path.map(([x, y], i) => ({
    x: x + r() * jitter, y: y + r() * jitter, t: t0 + i * 18, p: 0.5, pt: 'pen',
  }));
  return { id, points: pts, color: '#f5f2ea', width: 3, tool: 'pen', handwritten: true, createdAt: t0 };
}

/** "hello": 5 disconnected letter-ish strokes, one row, quick succession. */
export function fixtureHello(seed = 7): Stroke[] {
  const r = rng(seed);
  let t = 10000;
  const letters: Array<Array<[number, number]>> = [
    [[0, 30], [0, 0], [0, 30], [10, 30]],           // h-ish
    [[16, 12], [22, 12], [22, 30], [16, 30]],       // e-ish
    [[28, 0], [28, 30]],                            // l
    [[34, 0], [34, 30]],                            // l
    [[40, 30], [48, 30], [48, 12], [40, 12]],       // o-ish
  ];
  return letters.map((p, i) => { const s = stroke(`h${i}`, p, t, 1.5, r); t += 140; return s; });
}

/** "বিজ্ঞান"-shaped word: base curve + upper vowel sign + conjunct cluster + dot. */
export function fixtureBiggan(seed = 21): Stroke[] {
  const r = rng(seed);
  let t = 20000;
  const parts: Array<Array<[number, number]>> = [
    [[0, 40], [14, 22], [30, 16], [46, 24], [58, 40]],  // base headline curve
    [[10, 8], [16, 2], [24, 4]],                        // upper vowel sign (ে/ি-like)
    [[34, 30], [40, 44], [48, 30], [52, 40]],           // conjunct cluster (জ্ঞ-like)
    [[62, 6], [64, 8]],                                 // diacritic dot
    [[66, 20], [78, 20], [78, 40], [66, 40]],           // final letter (ন-like)
  ];
  return parts.map((p, i) => { const s = stroke(`b${i}`, p, t, 1.2, r); t += 110; return s; });
}

/** Mixed line: "hello" + gap + Bangla-shaped word on the same row. */
export function fixtureMixed(seed = 33): Stroke[] {
  const en = fixtureHello(seed);
  const bn = fixtureBiggan(seed + 1).map((s) => ({
    ...s,
    id: `m${s.id}`,
    points: s.points.map((p) => ({ ...p, x: p.x + 130 })),
    createdAt: s.createdAt + 3000,
  }));
  return [...en, ...bn];
}
