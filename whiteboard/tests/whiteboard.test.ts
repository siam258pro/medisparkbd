// Automated tests for the local smart whiteboard engine.
// Run: node --experimental-strip-types --test tests/whiteboard.test.ts
// Covers: capture/dedupe, smoothing, endpoints, corners, grouping/separation,
// beautify rollback, memory persistence shape, export, failure handling,
// offline (no fetch), Bangla/English/math/diagram handling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupe, movingAverage, detectCorners, catmullRom, rdp, smoothAdaptive, smoothSpeedAware, resampleEven, pointSpeeds, bbox, pathLength } from '../src/geometry.ts';
import { beautifyStrokePoints, beautifyStroke, revertStroke, layoutCorrectGroup } from '../src/beautify.ts';
import { groupStrokes } from '../src/grouping.ts';
import { learnFromFeedback, deleteExample, clearMemory, exportProfile, importProfile, DEFAULT_PROFILE } from '../src/memory.ts';
import type { InkPoint, Stroke } from '../src/types.ts';

function pts(coords: Array<[number, number]>, t0 = 1000, step = 20): InkPoint[] {
  return coords.map(([x, y], i) => ({ x, y, t: t0 + i * step, p: 0.5 }));
}
/** Jittery diagonal line simulating shaky pen. */
function shakyLine(n = 40): InkPoint[] {
  const out: InkPoint[] = [];
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5;
  for (let i = 0; i < n; i++) out.push({ x: i * 5 + rnd() * 6, y: i * 3 + rnd() * 6, t: 1000 + i * 16, p: 0.5 });
  return out;
}
/** Bangla-like shape: curve + detached diacritic dot above (must not merge/distort). */
function banglaLike(t0 = 1000): Stroke[] {
  const curve: Stroke = { id: 'bn1', points: pts([[0, 40], [10, 20], [25, 12], [40, 20], [48, 40]], t0), color: '#111', width: 3, tool: 'pen', createdAt: t0 };
  const dot: Stroke = { id: 'bn-dot', points: pts([[24, 0], [26, 2]], t0 + 60), color: '#111', width: 3, tool: 'pen', createdAt: t0 + 60 };
  return [curve, dot];
}
function mkStroke(id: string, p: InkPoint[], createdAt: number, tool: Stroke['tool'] = 'pen'): Stroke {
  return { id, points: p, color: '#111', width: 3, tool, createdAt };
}

test('stroke capture: dedupe removes digitizer duplicates, keeps endpoints', () => {
  const raw = pts([[0, 0], [0.1, 0.1], [0.2, 0], [10, 0], [20, 0]]);
  const d = dedupe(raw);
  assert.ok(d.length < raw.length && d.length >= 2);
  assert.equal(d[0].x, 0);
  assert.equal(d[d.length - 1].x, 20);
});

test('smoothing reduces jitter but preserves endpoints exactly', () => {
  const raw = shakyLine();
  const sm = smoothAdaptive(raw, 1);
  assert.equal(sm[0].x, raw[0].x);
  assert.equal(sm[sm.length - 1].x, raw[raw.length - 1].x);
  const jitter = (a: InkPoint[]) => {
    let s = 0;
    for (let i = 1; i < a.length - 1; i++) s += Math.abs(a[i + 1].y - 2 * a[i].y + a[i - 1].y);
    return s;
  };
  assert.ok(jitter(sm) < jitter(raw), 'smoothed curve should have less second-difference noise');
});

test('corner preservation: sharp cusp survives strong smoothing', () => {
  const raw = pts([[0, 50], [20, 50], [40, 50], [50, 50], [50, 30], [50, 10], [50, 0]]);
  const corners = detectCorners(raw);
  assert.ok(corners.length >= 1, 'right-angle corner must be detected');
  const sm = smoothAdaptive(raw, 2);
  // corner region must remain sharp-ish: max curvature point near (50,50)
  let best = 0, bi = -1;
  for (let i = 1; i < sm.length - 1; i++) {
    const a = Math.hypot(sm[i].x - sm[i - 1].x, sm[i].y - sm[i - 1].y);
    const b = Math.hypot(sm[i + 1].x - sm[i].x, sm[i + 1].y - sm[i].y);
    const dot = ((sm[i].x - sm[i - 1].x) * (sm[i + 1].x - sm[i].x) + (sm[i].y - sm[i - 1].y) * (sm[i + 1].y - sm[i].y)) / Math.max(1e-9, a * b);
    const turn = 1 - Math.max(-1, Math.min(1, dot));
    if (turn > best) { best = turn; bi = i; }
  }
  assert.ok(best > 0.3, 'sharp turn must survive');
  assert.ok(Math.abs(sm[bi].x - 50) < 15 && Math.abs(sm[bi].y - 50) < 15);
});

test('beautify: balanced smooths + resamples, endpoints exact, no cumulative re-processing', () => {
  const raw = shakyLine();
  const s = mkStroke('s1', raw, 1000);
  const b1 = beautifyStroke(s, 'balanced');
  assert.ok(b1.beautified && b1.originalPoints);
  assert.equal(b1.points[0].x, raw[0].x);
  assert.equal(b1.points[b1.points.length - 1].x, raw[raw.length - 1].x);
  const b2 = beautifyStroke(b1, 'strong');
  assert.equal(b2.points.length, b1.points.length, 'must not re-beautify already-beautified output');
});

test('beautify rollback: revert restores original ink byte-for-byte', () => {
  const raw = shakyLine();
  const b = beautifyStroke(mkStroke('s1', raw, 1000), 'strong');
  const r = revertStroke(b);
  assert.deepEqual(r.points, raw);
  assert.ok(!r.beautified && !r.originalPoints);
});

test('grouping: nearby strokes in time+space cluster; far strokes split', () => {
  const a = mkStroke('a', pts([[0, 0], [10, 0]]), 1000);
  const b = mkStroke('b', pts([[20, 2], [30, 2]]), 1100);
  const c = mkStroke('c', pts([[900, 900], [920, 900]]), 1200);
  const g = groupStrokes([a, b, c]);
  assert.equal(g.length, 2);
  assert.deepEqual(g[0].strokeIds, ['a', 'b']);
});

test('detection: long straight single stroke is shape, not handwriting', () => {
  const line = mkStroke('l', pts(Array.from({ length: 20 }, (_, i) => [i * 10, 0] as [number, number])), 1000);
  const g = groupStrokes([line]);
  assert.equal(g[0].kind, 'shape');
});

test('detection: fraction bar with above/below strokes is math (protected)', () => {
  const bar = mkStroke('bar', pts(Array.from({ length: 20 }, (_, i) => [i * 6, 50] as [number, number])), 1000);
  const num = mkStroke('num', pts([[30, 20], [50, 25]]), 1100);
  const den = mkStroke('den', pts([[30, 80], [55, 85]]), 1200);
  const g = groupStrokes([bar, num, den]);
  assert.equal(g[0].kind, 'math');
});

test('mixed Bangla-English: diacritic dot groups with base curve as handwriting', () => {
  const g = groupStrokes(banglaLike());
  assert.ok(g.length === 1);
  assert.ok(g[0].kind === 'handwriting' || g[0].kind === 'unknown');
  // beautify must not delete the diacritic stroke
  const ptsOut = beautifyStrokePoints(banglaLike()[1].points, 'strong');
  assert.ok(ptsOut.length >= 1);
  const b = bbox(ptsOut);
  assert.ok(b.y < 20, 'diacritic must stay above the base curve, not pulled down');
});

test('layout correction is capped: never yanks Bangla lines onto a grid', () => {
  const g1 = pts([[0, 0], [20, 2], [40, 0]]);
  const g2 = pts([[0, 60], [20, 62], [40, 60]]);
  const out = layoutCorrectGroup([g1, g2], 'strong');
  for (let gi = 0; gi < 2; gi++) for (let i = 0; i < out[gi].length; i++) {
    assert.ok(Math.abs(out[gi][i].y - [g1, g2][gi][i].y) <= 9.5, 'shift cap respected');
  }
});

test('memory: accept/reject learning updates bias in opposite directions', () => {
  let p = DEFAULT_PROFILE;
  const ex = { script: 'bangla' as const, accepted: true, strength: 'balanced' as const, original: [shakyLine()], beautified: [shakyLine()] };
  p = learnFromFeedback(p, ex);
  assert.equal(p.accepts, 1);
  assert.ok(p.examples.length === 1 && p.params.smoothingBias > 0);
  const biasAfterAccept = p.params.smoothingBias;
  p = learnFromFeedback(p, { ...ex, accepted: false });
  assert.equal(p.rejects, 1);
  assert.ok(p.params.smoothingBias < biasAfterAccept);
});

test('memory: delete + clear + export/import round-trip', () => {
  let p = learnFromFeedback(DEFAULT_PROFILE, { script: 'english', accepted: true, strength: 'subtle', original: [shakyLine()], beautified: [shakyLine()] });
  const id = p.examples[0].id;
  p = deleteExample(p, id);
  assert.equal(p.examples.length, 0);
  p = learnFromFeedback(p, { script: 'mixed', accepted: true, strength: 'subtle', original: [shakyLine()], beautified: [shakyLine()] });
  const json = exportProfile(p);
  const back = importProfile(json);
  assert.equal(back.examples.length, 1);
  assert.throws(() => importProfile('{"nope":1}'));
  const cleared = clearMemory(back);
  assert.equal(cleared.examples.length, 0);
});

test('processing failure: tiny/degenerate strokes pass through unchanged, never throw', () => {
  for (const bad of [[], pts([[5, 5]]), pts([[5, 5], [5, 5], [5, 5]])]) {
    assert.doesNotThrow(() => {
      const o1 = smoothAdaptive(bad, 2);
      const o2 = beautifyStrokePoints(bad, 'strong');
      const o3 = catmullRom(bad.length < 3 ? pts([[0, 0], [1, 1]]) : bad);
      const o4 = rdp(bad.length < 2 ? pts([[0, 0], [1, 1]]) : bad);
      const o5 = movingAverage(bad, 3);
      void [o1, o2, o3, o4, o5];
    });
  }
  assert.ok(pathLength([]) === 0);
});

test('offline: engine modules perform zero network calls', async () => {
  const origFetch = globalThis.fetch;
  let calls = 0;
  // @ts-ignore test hook: simulate offline engine (must not call fetch)
  globalThis.fetch = () => { calls++; throw new Error('must not fetch'); };
  try {
    smoothAdaptive(shakyLine(), 1);
    beautifyStrokePoints(shakyLine(), 'balanced');
    groupStrokes(banglaLike());
    learnFromFeedback(DEFAULT_PROFILE, { script: 'unknown', accepted: true, strength: 'subtle', original: [shakyLine()], beautified: [shakyLine()] });
  } finally {
    globalThis.fetch = origFetch;
  }
  assert.equal(calls, 0);
});

test('export shape: board serializes to JSON with raw ink retained', () => {
  const raw = shakyLine();
  const b = beautifyStroke(mkStroke('s1', raw, 1000), 'balanced');
  const json = JSON.stringify({ strokes: [b] });
  const back = JSON.parse(json) as { strokes: Stroke[] };
  assert.ok(back.strokes[0].originalPoints && back.strokes[0].originalPoints.length === raw.length);
});

test('v2: even resample gives uniform spacing and exact endpoints', () => {
  const raw = shakyLine(60);
  const out = resampleEven(raw, 4);
  assert.equal(out[0].x, raw[0].x);
  assert.equal(out[out.length - 1].x, raw[raw.length - 1].x);
  const gaps: number[] = [];
  for (let i = 1; i < out.length; i++) gaps.push(Math.hypot(out[i].x - out[i - 1].x, out[i].y - out[i - 1].y));
  const mean = gaps.reduce((a, g) => a + g, 0) / gaps.length;
  for (const g of gaps) assert.ok(Math.abs(g - mean) < mean * 0.6 + 1, `gap ${g} near mean ${mean}`);
});

test('v2: speed-aware smoothing treats fast jitter more than slow detail', () => {
  // First half: slow + careful small curve; second half: fast + heavy jitter.
  const pts: InkPoint[] = [];
  let seed = 9;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5;
  for (let i = 0; i < 30; i++) pts.push({ x: i * 3, y: Math.sin(i / 3) * 8 + rnd() * 2, t: 1000 + i * 60, p: 0.5 });
  for (let i = 30; i < 60; i++) pts.push({ x: 90 + (i - 30) * 8, y: rnd() * 30, t: 2800 + (i - 30) * 8, p: 0.5 });
  const sm = smoothSpeedAware(pts, 1);
  const rough = (a: InkPoint[]) => {
    let s = 0;
    for (let i = 1; i < a.length - 1; i++) s += Math.abs(a[i + 1].y - 2 * a[i].y + a[i - 1].y);
    return s / Math.max(1, a.length);
  };
  const mid = Math.floor(sm.length / 2);
  const slowBefore = rough(pts.slice(0, 30)), slowAfter = rough(sm.slice(0, mid));
  const fastBefore = rough(pts.slice(30)), fastAfter = rough(sm.slice(mid));
  assert.ok(fastAfter < fastBefore * 0.7, 'fast jittery part must be smoothed strongly');
  assert.ok(slowAfter < slowBefore, 'slow part still denoised');
  assert.ok((slowBefore - slowAfter) / slowBefore < (fastBefore - fastAfter) / fastBefore + 0.25,
    'fast section should improve relatively more than the slow section');
  assert.equal(sm[0].x, pts[0].x);
  assert.equal(sm[sm.length - 1].x, pts[pts.length - 1].x);
});

test('ink-to-shape: straight pen stroke becomes a line', async () => {
  const { detectInkShape } = await import('../src/inkShape.ts');
  const line: InkPoint[] = [];
  for (let i = 0; i < 25; i++) line.push({ x: i * 8, y: i * 0.5 + (i % 2), t: 1000 + i * 16, p: 0.5 });
  const d = detectInkShape(line);
  assert.ok(d && d.shape === 'line');
});

test('ink-to-shape: rough circle becomes an ellipse, scribble stays ink', async () => {
  const { detectInkShape } = await import('../src/inkShape.ts');
  const circ: InkPoint[] = [];
  for (let i = 0; i <= 40; i++) {
    const t = (i / 40) * Math.PI * 2;
    circ.push({ x: 100 + Math.cos(t) * 60 + (i % 3), y: 100 + Math.sin(t) * 45, t: 1000 + i * 16, p: 0.5 });
  }
  const d = detectInkShape(circ);
  assert.ok(d && d.shape === 'ellipse');
  // tiny squiggle: too small, must NOT convert
  const tiny = pts([[0, 0], [3, 2], [6, 0], [9, 3], [12, 1], [15, 2], [18, 0]]);
  assert.equal(detectInkShape(tiny), null);
  // open wavy curve (like handwriting): must NOT convert
  const open: InkPoint[] = [];
  for (let i = 0; i < 24; i++) open.push({ x: i * 5, y: Math.sin(i / 2) * 14, t: 1000 + i * 16, p: 0.5 });
  assert.equal(detectInkShape(open), null);
});

test('lasso: point-in-polygon selects interior, rejects exterior', async () => {
  const { pointInPolygon } = await import('../src/grouping.ts');
  const square = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  assert.ok(pointInPolygon(50, 50, square));
  assert.ok(!pointInPolygon(150, 50, square));
  assert.ok(!pointInPolygon(-5, -5, square));
});
