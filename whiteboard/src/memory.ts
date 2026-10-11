// Personal handwriting memory: geometric personalization only.
// Stores raw + beautified examples locally; learns measurable parameters
// (width, size, slant, spacing, smoothing preference). This is NOT neural
// network training — the profile format is forward-compatible with future
// local-model fine-tuning workflows.
import type { BeautifyStrength, InkPoint, MemoryExample, MemoryProfile, PersonalParams } from './types.ts';
import { bbox } from './geometry.ts';
import { uid } from './types.ts';

export const DEFAULT_PROFILE: MemoryProfile = {
  enabled: true,
  params: { smoothingBias: 0, slant: 0, avgHeight: 48, avgWidth: 3, spacing: 28 },
  examples: [],
  accepts: 0,
  rejects: 0,
};

function statsOf(strokes: InkPoint[][]): { avgHeight: number; avgWidth: number; slant: number } {
  const hs: number[] = [];
  let slantSum = 0, slantN = 0;
  for (const pts of strokes) {
    if (pts.length < 2) continue;
    const b = bbox(pts);
    if (b.h > 3 && b.h < 1500) hs.push(b.h);
    const dx = pts[pts.length - 1].x - pts[0].x;
    const dy = pts[pts.length - 1].y - pts[0].y;
    if (Math.abs(dx) > 5) { slantSum += Math.atan2(dy, dx); slantN++; }
  }
  hs.sort((a, b) => a - b);
  return {
    avgHeight: hs.length ? hs[Math.floor(hs.length / 2)] : DEFAULT_PROFILE.params.avgHeight,
    avgWidth: DEFAULT_PROFILE.params.avgWidth,
    slant: slantN ? slantSum / slantN : 0,
  };
}

function ema(prev: number, next: number, alpha = 0.15): number {
  return prev + (next - prev) * alpha;
}

export function learnFromFeedback(
  profile: MemoryProfile,
  example: Omit<MemoryExample, 'id' | 'createdAt' | 'avgWidth' | 'avgHeight' | 'slant'>,
): MemoryProfile {
  const st = statsOf(example.original);
  const full: MemoryExample = {
    ...example,
    id: uid('m'),
    createdAt: Date.now(),
    avgWidth: st.avgWidth,
    avgHeight: st.avgHeight,
    slant: st.slant,
  };
  const p: PersonalParams = { ...profile.params };
  if (example.accepted) {
    p.avgHeight = ema(p.avgHeight, st.avgHeight);
    p.slant = ema(p.slant, st.slant);
    p.smoothingBias = Math.min(1, p.smoothingBias + 0.02);
  } else {
    // Rejected beautification -> back off smoothing slightly.
    p.smoothingBias = Math.max(0, p.smoothingBias - 0.05);
  }
  const examples = [full, ...profile.examples].slice(0, 500);
  return {
    ...profile,
    params: p,
    examples,
    accepts: profile.accepts + (example.accepted ? 1 : 0),
    rejects: profile.rejects + (example.accepted ? 0 : 1),
  };
}

export function deleteExample(profile: MemoryProfile, id: string): MemoryProfile {
  return { ...profile, examples: profile.examples.filter((e) => e.id !== id) };
}

export function clearMemory(profile: MemoryProfile): MemoryProfile {
  return { ...DEFAULT_PROFILE, enabled: profile.enabled };
}

export function countByScript(profile: MemoryProfile): Record<string, number> {
  const out: Record<string, number> = { bangla: 0, english: 0, mixed: 0, numeral: 0, unknown: 0 };
  for (const e of profile.examples) out[e.script] = (out[e.script] ?? 0) + 1;
  return out;
}

export function exportProfile(profile: MemoryProfile): string {
  return JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), profile }, null, 2);
}

export function importProfile(json: string): MemoryProfile {
  const parsed = JSON.parse(json) as { profile?: MemoryProfile };
  const p = parsed.profile ?? (JSON.parse(json) as MemoryProfile);
  if (!p || !Array.isArray(p.examples) || typeof p.params !== 'object') {
    throw new Error('Not a handwriting-memory profile file.');
  }
  return {
    enabled: p.enabled !== false,
    params: { ...DEFAULT_PROFILE.params, ...p.params },
    examples: p.examples.slice(0, 500),
    accepts: p.accepts ?? 0,
    rejects: p.rejects ?? 0,
  };
}

export type { BeautifyStrength };
