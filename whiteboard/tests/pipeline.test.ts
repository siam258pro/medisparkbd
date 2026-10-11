// Phase 6: end-to-end pipeline tests on recorded-style fixtures with a
// mocked backend. Covers grouping -> mock recognize -> sanitize -> font /
// auto-replace decision, plus a <300ms local-processing budget check.
// NOTE (honest): recognition text accuracy itself depends on the live vision
// LLM; these tests verify the pipeline makes the right decisions on fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupIntoLines } from '../src/lines.ts';
import { sanitizeResult, splitMixedLine, MockRecognizer, LOW_CONFIDENCE } from '../src/recognizer.ts';
import { pickFont, EN_FONT, BN_FONT } from '../src/handText.ts';
import { cleanStrokePoints } from '../src/cleanStrokes.ts';
import { fixtureHello, fixtureMixed, fixtureBiggan } from './fixtures.ts';

function mockFor(text: string, lang: 'en' | 'bn' | 'mixed', confidence: number, alternatives: string[] = []) {
  return new MockRecognizer(() => ({ text, lang, confidence, alternatives }));
}

test('EN fixture: one line/word -> recognized -> EN font, auto-replace allowed', async () => {
  const strokes = fixtureHello();
  const lines = groupIntoLines(strokes, { pauseMs: 700 });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].words.length, 1);
  const rec = new MockRecognizer(async () => ({ text: 'hello', lang: 'en', confidence: 0.95, alternatives: [] }));
  const flat = lines[0].words.flatMap((w) => w.strokeIds);
  const byId = new Map(strokes.map((s) => [s.id, s]));
  const group = flat.map((id) => byId.get(id)!);
  const r = sanitizeResult(await rec.recognize(group));
  assert.equal(r.text, 'hello');
  assert.equal(r.lang, 'en');
  assert.ok(r.confidence >= LOW_CONFIDENCE);
  assert.equal(pickFont(r.text), EN_FONT);
});

test('BN conjunct fixture: diacritics stay grouped -> BN font, NFC intact', async () => {
  const strokes = fixtureBiggan();
  const lines = groupIntoLines(strokes, { pauseMs: 700 });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].words.length, 1);
  assert.equal(lines[0].words[0].strokeIds.length, 5);
  const rec = mockFor('বিজ্ঞান', 'bn', 0.92, ['বিজ্ঞান']);
  const r = sanitizeResult(await rec.recognize(strokes));
  assert.equal(r.text, 'বিজ্ঞান');
  assert.equal(r.lang, 'bn');
  assert.equal(pickFont(r.text), BN_FONT);
});

test('mixed fixture: two words, mixed transcription splits by script', async () => {
  const strokes = fixtureMixed();
  const lines = groupIntoLines(strokes, { pauseMs: 700 });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].words.length, 2);
  const rec = mockFor('hello বাংলা', 'mixed', 0.88, []);
  const r = sanitizeResult(await rec.recognize(strokes));
  assert.equal(r.lang, 'mixed');
  const runs = splitMixedLine(r.text);
  assert.deepEqual(runs.map((x) => x.script), ['en', 'bn']);
});

test('low confidence blocks auto-replace, surfaces alternatives', async () => {
  const rec = mockFor('helo', 'en', 0.3, ['hello', 'helo']);
  const r = sanitizeResult(await rec.recognize(fixtureHello()));
  assert.ok(r.confidence < LOW_CONFIDENCE);
  assert.deepEqual(r.alternatives, ['hello', 'helo']);
});

test('local processing budget: grouping + cleaning one line under 300ms', () => {
  const strokes = fixtureMixed();
  const t0 = performance.now();
  const lines = groupIntoLines(strokes, { pauseMs: 700 });
  for (const l of lines) {
    for (const w of l.words) {
      for (const id of w.strokeIds) {
        const s = strokes.find((x) => x.id === id)!;
        cleanStrokePoints(s.points);
      }
    }
  }
  const ms = performance.now() - t0;
  assert.ok(ms < 300, `took ${ms.toFixed(1)}ms`);
});
