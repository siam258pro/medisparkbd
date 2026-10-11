// Pointer-input helpers (Phase 1): coalesced events, pointer types,
// palm rejection. Pure/testable: pass plain event-like objects.
import type { InkPoint } from './types.ts';

export interface CoalescedLike {
  clientX: number;
  clientY: number;
  pressure?: number;
  pointerType?: string;
  getCoalescedEvents?: () => CoalescedLike[];
}

/** Expand a pointer event into all coalesced raw samples (high-Hz styli). */
export function expandCoalesced(e: CoalescedLike): Array<{ x: number; y: number; p: number; pt: string }> {
  const list = (typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e]) as CoalescedLike[];
  const src = list.length ? list : [e];
  return src.map((e) => ({
    x: e.clientX,
    y: e.clientY,
    p: typeof e.pressure === 'number' && e.pressure > 0 ? e.pressure : 0.5,
    pt: e.pointerType ?? 'mouse',
  }));
}

/** Palm rejection: ignore touch while a pen pointer is active (if enabled). */
export function shouldIgnorePointer(pointerType: string | undefined, penActive: boolean, setting: boolean): boolean {
  if (!setting) return false;
  return pointerType === 'touch' && penActive;
}

export function toInkPoint(clientX: number, clientY: number, toWorld: (x: number, y: number) => { x: number; y: number }, p: number, pt: string): InkPoint {
  const w = toWorld(clientX, clientY);
  return { x: w.x, y: w.y, t: Date.now(), p, pt };
}
