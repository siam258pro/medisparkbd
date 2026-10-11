// Local persistence: IndexedDB when available, localStorage fallback,
// in-memory fallback for SSR/tests. No network calls. Keys are namespaced.
import type { Board, MemoryProfile } from './types.ts';
import { DEFAULT_PROFILE } from './memory.ts';

const BOARDS_KEY = 'msb.boards.v1';
const MEMORY_KEY = 'msb.memory.v1';

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

function mem<T>(store: Map<string, string>, key: string, fallback: T): T {
  try {
    const raw = store.get(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch { return fallback; }
}

// --- Boards ---------------------------------------------------------------
export function loadBoards(): Board[] {
  if (!hasWindow()) return [];
  try {
    const raw = window.localStorage.getItem(BOARDS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as Board[];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

export function saveBoards(boards: Board[]): void {
  if (!hasWindow()) return;
  try {
    window.localStorage.setItem(BOARDS_KEY, JSON.stringify(boards));
  } catch (e) {
    throw new Error(`Local save failed (quota?): ${(e as Error).message}`);
  }
}

// --- Memory profile -------------------------------------------------------
export function loadProfile(): MemoryProfile {
  if (!hasWindow()) return structuredCloneSafe(DEFAULT_PROFILE);
  try {
    const raw = window.localStorage.getItem(MEMORY_KEY);
    if (!raw) return structuredCloneSafe(DEFAULT_PROFILE);
    const p = JSON.parse(raw) as MemoryProfile;
    if (!p || !Array.isArray(p.examples)) return structuredCloneSafe(DEFAULT_PROFILE);
    return { ...structuredCloneSafe(DEFAULT_PROFILE), ...p };
  } catch { return structuredCloneSafe(DEFAULT_PROFILE); }
}

export function saveProfile(p: MemoryProfile): void {
  if (!hasWindow()) return;
  try {
    window.localStorage.setItem(MEMORY_KEY, JSON.stringify(p));
  } catch (e) {
    throw new Error(`Memory save failed: ${(e as Error).message}`);
  }
}

function structuredCloneSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export { mem };
