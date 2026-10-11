// Phase 1 tests: word/line grouping from synthetic stroke fixtures.
// Run: node --experimental-strip-types --test tests/lines.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupIntoLines } from '../src/lines.ts';
import type { InkPoint, Stroke } from '../src/types.ts';

function pts(coords: Array<[number, number]>, t0: number, step = 20): InkPoint[] {
  return coords.map(([x, y], i) => ({ x, y, t: t0 + i * step, p: 0.5 }));
}
function mk(id: string, p: InkPoint[], createdAt: number): Stroke {
  return { id, points: p, color: '#111', width: 3, tool: 'pen', createdAt };
}
// Synthetic "hello"-like word: 3 strokes, close in space+time.
function englishWord(x0: number, t0: number, pfx: string): Stroke[] {
  return [
    mk(`${pfx}a`, pts([[x0, 0], [x0 + 8, 30], [x0 + 16, 0]], t0), t0),
    mk(`${pfx}b`, pts([[x0 + 22, 0], [x0 + 30, 30]], t0 + 120), t0 + 120),
    mk(`${pfx}c`, pts([[x0 + 36, 10], [x0 + 52, 10]], t0 + 260), t0 + 260),
  ];
}
// Synthetic Bangla-like word: base curve + detached diacritic dot above.
function banglaWord(x0: number, t0: number, pfx: string): Stroke[] {
  return [
    mk(`${pfx}a`, pts([[x0, 40], [x0 + 12, 20], [x0 + 28, 14], [x0 + 42, 22]], t0), t0),
    mk(`${pfx}dot`, pts([[x0 + 20, 0], [x0 + 22, 2]], t0 + 90), t0 + 90),
  ];
}

test('one english word groups into one line, one word', () => {
  const lines = groupIntoLines(englishWord(0, 1000, 'e'));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].words.length, 1);
  assert.deepEqual(lines[0].words[0].strokeIds, ['ea', 'eb', 'ec']);
});

test('bangla diacritic dot stays in the same word', () => {
  const lines = groupIntoLines(banglaWord(0, 1000, 'b'));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].words.length, 1);
  assert.deepEqual(lines[0].words[0].strokeIds, ['ba', 'bdot']);
});

test('two stacked rows become two lines', () => {
  const strokes = [...englishWord(0, 1000, 'l1'), ...banglaWord(0, 5000, 'l2').map((s) => ({
    ...s, points: s.points.map((p) => ({ ...p, y: p.y + 120 })),
  }))];
  const lines = groupIntoLines(strokes);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].bbox.y < lines[1].bbox.y);
});

test('long pause splits words on one row', () => {
  const strokes = [...englishWord(0, 1000, 'w1'), ...englishWord(120, 5000, 'w2')];
  const lines = groupIntoLines(strokes, { pauseMs: 700 });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].words.length, 2);
});

test('wide spatial gap splits words even without pause', () => {
  const strokes = [...englishWord(0, 1000, 'w1'), ...englishWord(300, 1300, 'w2')];
  const lines = groupIntoLines(strokes, { pauseMs: 60000 });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].words.length, 2);
});

test('mixed line: latin + bangla words split by gap', () => {
  const strokes = [...englishWord(0, 1000, 'm1'), ...banglaWord(150, 1400, 'm2')];
  const lines = groupIntoLines(strokes);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].words.length, 2);
});

test('empty and non-ink strokes yield no lines', () => {
  assert.deepEqual(groupIntoLines([]), []);
  const img: Stroke = { ...mk('img', pts([[0, 0]], 0), 0), isImage: true };
  assert.deepEqual(groupIntoLines([img]), []);
});
