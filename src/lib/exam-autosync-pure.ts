// Pure helpers for the Exam Set Auto-Sync system (no DB imports — testable
// with plain node). The DB-backed module re-exports everything from here.

export type SyncSet = "A" | "B";
export type SyncLang = "bn" | "en";
export type Difficulty = "Easy" | "Moderate" | "Hard";
export type TranslationStatus =
  | "pending"
  | "translating"
  | "completed"
  | "needs_update"
  | "failed"
  | "manually_edited";

export const SYNC_SETS: SyncSet[] = ["A", "B"];
export const SYNC_TOPICS = [
  "Cell Structure",
  "Cell Division",
  "Cell Chemistry",
  "Microorganisms",
] as const;
export type SyncTopic = (typeof SYNC_TOPICS)[number];
export const TOPIC_REQUIRED_COUNT = 25;
export const SET_REQUIRED_COUNT = 100;
export const DIFFICULTIES: Difficulty[] = ["Easy", "Moderate", "Hard"];

export function normalizeSyncSet(v: unknown): SyncSet | null {
  const t = String(v ?? "").trim().toUpperCase();
  if (t === "A" || t === "SET A" || t === "SET-A") return "A";
  if (t === "B" || t === "SET B" || t === "SET-B") return "B";
  return null;
}

export function normalizeTopic(v: unknown): SyncTopic | null {
  const t = String(v ?? "").trim().toLowerCase();
  for (const topic of SYNC_TOPICS) {
    if (topic.toLowerCase() === t) return topic;
  }
  return null;
}

export function normalizeDifficulty(v: unknown): Difficulty | null {
  const t = String(v ?? "").trim().toLowerCase();
  if (t === "easy") return "Easy";
  if (t === "moderate" || t === "medium") return "Moderate";
  if (t === "hard") return "Hard";
  return null;
}

export function correctLetterToIndex(letter: unknown): number | null {
  const t = String(letter ?? "").trim().toUpperCase();
  const map: Record<string, number> = { A: 0, B: 1, C: 2, D: 3 };
  if (Object.hasOwn(map, t)) return map[t];
  if (typeof letter !== "number" && (typeof letter !== "string" || !letter.trim())) return null;
  const n = Number(letter);
  if (Number.isInteger(n) && n >= 0 && n <= 3) return n;
  return null;
}

export function correctIndexToLetter(index: unknown): "A" | "B" | "C" | "D" | null {
  if (typeof index !== "number" && (typeof index !== "string" || !index.trim())) return null;
  const n = Number(index);
  if (!Number.isInteger(n) || n < 0 || n > 3) return null;
  return (["A", "B", "C", "D"] as const)[n];
}

const BN_EN_DICT: Array<[RegExp, string]> = [
  [/উদ্ভিদ\s*কোষে?/g, "in a plant cell"],
  [/প্রাণী\s*কোষে?/g, "in an animal cell"],
  [/কোষগহ্বর/g, "Vacuole"],
  [/মাইটোকন্ড্রিয়া/g, "Mitochondria"],
  [/রাইবোসোম/g, "Ribosome"],
  [/গ্রাইঅক্সিসোম|গ্লাইঅক্সিসোম/g, "Glyoxysome"],
  [/ক্লোরোপ্লাস্ট/g, "Chloroplast"],
  [/নিউক্লিয়াস/g, "Nucleus"],
  [/লাইসোসোম/g, "Lysosome"],
  [/কোন\s*অঙ্গাণু/g, "which organelle"],
  [/কোনটি/g, "which one"],
  [/সাহায্য\s*করে/g, "helps"],
  [/রক্ষা\s*করে/g, "maintain"],
  [/pH\s*রক্ষা/g, "pH maintenance"],
  [/কোষ\s*বিভাজন/g, "cell division"],
  [/কোষ\s*রসায়ন/g, "cell chemistry"],
  [/অণুজীব/g, "microorganism"],
  [/কোষ\s*গঠন/g, "cell structure"],
  [/নিচের/g, "of the following"],
  [/সঠিক/g, "correct"],
  [/ব্যাখ্যা/g, "Explanation"],
  [/কোষ/g, "cell"],
  [/অঙ্গাণু/g, "organelle"],
];

/** Deterministic offline Bn→En translation. Preserves numbers, units, formulas. */
export function autoTranslateBnToEn(input: string): string {
  let out = String(input ?? "");
  if (!out.trim()) return out;
  for (const [re, en] of BN_EN_DICT) out = out.replace(re, en);
  out = out.replace(/।/g, ".");
  out = out.replace(/\s{2,}/g, " ").trim();
  return out;
}

export function difficultyWarning(
  a: Record<Difficulty, number>,
  b: Record<Difficulty, number>,
): string | null {
  const total = (d: Record<Difficulty, number>) => d.Easy + d.Moderate + d.Hard;
  if (total(a) === 0 || total(b) === 0) return null;
  const share = (d: Record<Difficulty, number>) => ({
    Easy: d.Easy / total(d), Moderate: d.Moderate / total(d), Hard: d.Hard / total(d),
  });
  const sa = share(a);
  const sb = share(b);
  const drift = Math.max(
    Math.abs(sa.Easy - sb.Easy), Math.abs(sa.Moderate - sb.Moderate), Math.abs(sa.Hard - sb.Hard),
  );
  if (drift > 0.15) {
    return `Difficulty drift ${(drift * 100).toFixed(0)}% between Set A and Set B — review balance before publishing.`;
  }
  return null;
}
