// Phase 4 tests: font picking and width-fitted sizing (measure injected).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickFont, fitFontSize, EN_FONT, BN_FONT } from '../src/handText.ts';

test('font follows script, mixed uses dominant run', () => {
  assert.equal(pickFont('hello world'), EN_FONT);
  assert.equal(pickFont('বিজ্ঞান'), BN_FONT);
  assert.equal(pickFont('hello বাংলা'), EN_FONT); // latin run longer
  assert.equal(pickFont('বাংলা ভাষা test'), BN_FONT);
});

test('fitFontSize shrinks until width fits, never below minimum', () => {
  const fake = (_font: string, text: string) => text.length * 12; // 12px per char at any size? scale-aware:
  const scaled = (fontCss: string, text: string) => {
    const px = parseFloat(fontCss);
    return text.length * px * 0.6;
  };
  void fake;
  const px = fitFontSize('hello world', EN_FONT, 100, 40, scaled);
  assert.ok(px < 40 && px >= 10);
  assert.ok(scaled(`${px}px ${EN_FONT}`, 'hello world') <= 100);
  const big = fitFontSize('hi', EN_FONT, 10000, 40, scaled);
  assert.equal(big, 40);
});
