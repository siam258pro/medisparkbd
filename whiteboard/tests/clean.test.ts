// Phase 2 tests: One-Euro smoothing, RDP simplify, baseline straighten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getStroke } from 'perfect-freehand';
import { oneEuroFilter, simplifyPoints, straightenBaseline, normalizeGroupHeight, cleanStroke } from '../src/cleanStrokes.ts';
import type { InkPoint, Stroke } from '../src/types.ts';

function shaky(n = 40, amp = 3): InkPoint[] {
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5;
  const out: InkPoint[] = [];
  for (let i = 0; i < n; i++) out.push({ x: i * 5 + rnd() * amp * 2, y: i * 3 + rnd() * amp * 2, t: 1000 + i * 16, p: 0.5 });
  return out;
}
const rough = (a: InkPoint[]) => {
  let s = 0;
  for (let i = 1; i < a.length - 1; i++) s += Math.abs(a[i + 1].y - 2 * a[i].y + a[i - 1].y);
  return s;
};

test('one-euro reduces jitter, keeps endpoints', () => {
  const raw = shaky();
  const sm = oneEuroFilter(raw);
  assert.equal(sm.length, raw.length);
  assert.equal(sm[0].x, raw[0].x);
  assert.ok(rough(sm) < rough(raw));
});

test('simplify-js drops redundant points, keeps metadata', () => {
  const raw = shaky(60);
  const sp = simplifyPoints(raw, 1.5);
  assert.ok(sp.length < raw.length && sp.length >= 2);
  assert.ok(sp.every((p) => typeof p.t === 'number' && typeof p.p === 'number'));
});

test('baseline straightens small tilt, refuses steep tilt', () => {
  const tilted: InkPoint[] = [];
  for (let i = 0; i < 20; i++) tilted.push({ x: i * 10, y: i * 10 * Math.tan(6 * Math.PI / 180), t: 1000 + i * 16, p: 0.5 });
  const r1 = straightenBaseline(tilted, 10);
  assert.equal(r1.rotated, true);
  assert.ok(Math.abs(r1.angleDeg - 6) < 1.5);
  const steep: InkPoint[] = [];
  for (let i = 0; i < 20; i++) steep.push({ x: i * 10, y: i * 10 * Math.tan(30 * Math.PI / 180), t: 1000 + i * 16, p: 0.5 });
  const r2 = straightenBaseline(steep, 10);
  assert.equal(r2.rotated, false);
});

test('group height normalization is capped at ±10%', () => {
  const a = shaky().map((p) => ({ ...p, y: p.y * 0.2 }));
  const b = shaky().map((p) => ({ ...p, y: 200 + p.y * 3 }));
  const [na, nb] = normalizeGroupHeight([a, b]);
  const h = (g: InkPoint[]) => Math.max(...g.map((p) => p.y)) - Math.min(...g.map((p) => p.y));
  assert.ok(Math.abs(h(na) / h(a) - 1) <= 0.11);
  assert.ok(Math.abs(h(nb) / h(b) - 1) <= 0.11);
});

test('perfect-freehand renders a variable-width outline', () => {
  const raw = shaky();
  const outline = getStroke(raw.map((p) => [p.x, p.y, p.p ?? 0.5]), { size: 8, thinning: 0.6 });
  assert.ok(outline.length > raw.length);
});

test('cleanStroke marks variableWidth and never re-cleans', () => {
  const s: Stroke = { id: 'c', points: shaky(), color: '#111', width: 3, tool: 'pen', createdAt: 1 };
  const c1 = cleanStroke(s);
  assert.ok(c1.variableWidth && c1.originalPoints);
  const c2 = cleanStroke(c1);
  assert.equal(c2.points.length, c1.points.length);
});
