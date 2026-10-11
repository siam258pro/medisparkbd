// Phase 3 tests: language utils, sanitizer, hash, mock recognizer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeBanglaNFC, containsBengali, containsLatin, verifyLang,
  splitMixedLine, hashStrokes, sanitizeResult, MockRecognizer,
} from '../src/recognizer.ts';
import type { Stroke } from '../src/types.ts';

const s = (id: string, x: number, y: number): Stroke =>
  ({ id, points: [{ x, y, t: 1, p: 0.5 }], color: '#111', width: 3, tool: 'pen', createdAt: 1 });

test('NFC normalization composes decomposed input, preserves Bangla', () => {
  assert.equal(normalizeBanglaNFC('é'), 'é');
  assert.equal(normalizeBanglaNFC('বিজ্ঞান'), 'বিজ্ঞান');
  assert.equal(normalizeBanglaNFC('বিজ্ঞান'.normalize('NFD')), 'বিজ্ঞান');
  assert.ok(containsBengali('বিজ্ঞান') && !containsLatin('বিজ্ঞান'));
  assert.ok(containsLatin('hello') && !containsBengali('hello'));
});

test('verifyLang overrides contradicting claims', () => {
  assert.equal(verifyLang('বাংলা', 'en'), 'bn');
  assert.equal(verifyLang('hello', 'bn'), 'en');
  assert.equal(verifyLang('hello বাংলা', 'en'), 'mixed');
  assert.equal(verifyLang('123', 'bn'), 'bn'); // unknown script: trust claim
});

test('mixed line splits into script runs', () => {
  const runs = splitMixedLine('hello বাংলা test');
  assert.deepEqual(runs.map((r) => r.script), ['en', 'bn', 'en']);
  assert.equal(runs.map((r) => r.text).join('|'), 'hello |বাংলা |test');
});

test('stroke hash is deterministic and geometry-sensitive', () => {
  const a = [s('a', 10, 20), s('b', 30, 40)];
  const b = [s('a', 10, 20), s('b', 30, 40)];
  const c = [s('a', 11, 20), s('b', 30, 40)];
  assert.equal(hashStrokes(a), hashStrokes(b));
  assert.notEqual(hashStrokes(a), hashStrokes(c));
  assert.match(hashStrokes(a), /^[0-9a-f]+$/);
});

test('sanitizeResult clamps, truncates and normalizes', () => {
  const r = sanitizeResult({ text: 'বাংলা', lang: 'bn', confidence: 9, alternatives: ['a', 1, 'b'] });
  assert.equal(r.confidence, 1);
  assert.equal(r.lang, 'bn');
  assert.deepEqual(r.alternatives, ['a', 'b']);
  const bad = sanitizeResult({ nope: true });
  assert.equal(bad.text, '');
  assert.equal(bad.confidence, 0);
});

test('mock recognizer resolves canned results', async () => {
  const mock = new MockRecognizer(() => ({ text: 'hello', lang: 'en', confidence: 0.9, alternatives: [] }));
  const r = await mock.recognize([s('a', 0, 0)]);
  assert.equal(r.text, 'hello');
});
