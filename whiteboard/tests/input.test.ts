// Phase 1 tests: pointer input helpers (coalesced events, palm rejection).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandCoalesced, shouldIgnorePointer, toInkPoint } from '../src/input.ts';

test('coalesced events expand to all raw samples', () => {
  const e = {
    clientX: 10, clientY: 20, pressure: 0.5, pointerType: 'pen',
    getCoalescedEvents: () => [
      { clientX: 8, clientY: 19, pressure: 0.4, pointerType: 'pen' },
      { clientX: 9, clientY: 20, pressure: 0.45, pointerType: 'pen' },
      { clientX: 10, clientY: 20, pressure: 0.5, pointerType: 'pen' },
    ],
  };
  const out = expandCoalesced(e);
  assert.equal(out.length, 3);
  assert.equal(out[0].x, 8);
  assert.equal(out[2].p, 0.5);
  assert.ok(out.every((o) => o.pt === 'pen'));
});

test('events without coalesced API fall back to the event itself', () => {
  const out = expandCoalesced({ clientX: 5, clientY: 6, pointerType: 'mouse' });
  assert.equal(out.length, 1);
  assert.equal(out[0].p, 0.5); // missing pressure defaults
});

test('palm rejection ignores touch only when pen active and enabled', () => {
  assert.equal(shouldIgnorePointer('touch', true, true), true);
  assert.equal(shouldIgnorePointer('touch', false, true), false);
  assert.equal(shouldIgnorePointer('touch', true, false), false);
  assert.equal(shouldIgnorePointer('pen', true, true), false);
  assert.equal(shouldIgnorePointer('mouse', true, true), false);
});

test('captured points keep pressure, type and timestamp', () => {
  const before = Date.now();
  const p = toInkPoint(10, 20, (x, y) => ({ x, y }), 0.7, 'pen');
  assert.equal(p.p, 0.7);
  assert.equal(p.pt, 'pen');
  assert.ok(p.t >= before);
});
