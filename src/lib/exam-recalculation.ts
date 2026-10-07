import { exec, parseJsonColumn, query } from "@/lib/mysql";
import { fetchExamById } from "@/lib/exams-admin";
import {
  fetchVariantMap,
  normalizeSet,
  normalizeVersion,
  resolveMarks,
  resolveQuestions,
} from "@/lib/exam-variants";
import { normalizeStoredAnswerIndex } from "@/lib/paste-mcq-parser";
import {
  negativePerWrongFor,
  updateMeritPositions,
} from "@/lib/exam-taking";

// Automatic result recalculation after an Admin corrects an Answer Key.
//
// The latest corrected Answer Key (base `exam_questions.correct_index` +
// per-version/set `exam_question_variants.correct_index`) is the single
// source of truth. Every stored result is recomputed FROM SCRATCH from the
// student's immutable stored answers + the latest key — never by stacking
// deltas — so repeated corrections converge instead of double-adding.
//
// Per-question rules (mirror `gradeAnswers` in exam-taking.ts):
//   - unanswered (chosen null)                        → obtained 0
//   - chosen matches the corrected key                → obtained +marks
//     (any previous negative on that question disappears with the rebuild)
//   - chosen does not match (or key unknown)          → obtained −neg, wrong+1
// Student answers, snapshots, timer penalties and history are preserved;
// only score / details / negative_deduction / total_marks are rewritten,
// then merit positions are rebuilt for ranked attempts.

export type AnswerKeySnapshot = {
  base: Map<number, string>;
  variants: Map<string, string>;
};

function cellKey(correct: unknown, marks: unknown, options?: unknown): string {
  const c = correct === null || correct === undefined ? "null" : String(Number(correct));
  const m = Number(marks);
  const o = typeof options === "string" ? options : JSON.stringify(options ?? null);
  return `${c}|${Number.isFinite(m) ? m : 1}|${o}`;
}

/** Best-effort snapshot of an exam's full answer key (base + all variants). */
export async function snapshotAnswerKey(
  examId: string,
): Promise<AnswerKeySnapshot | null> {
  try {
    const id = examId?.trim();
    if (!id) return null;
    const base = new Map<number, string>();
    try {
      const rows = await query<
        { id: number; correct_index: number | null; marks: string | number; options: string; is_active: number | boolean }[]
      >(
        `SELECT id, correct_index, marks, options, is_active FROM exam_questions WHERE exam_id = ?`,
        [id],
      );
      for (const r of rows) {
        base.set(Number(r.id), `${cellKey(r.correct_index, r.marks, r.options)}|${r.is_active ? 1 : 0}`);
      }
    } catch {
      return null;
    }
    const variants = new Map<string, string>();
    try {
      const map = await fetchVariantMap(id);
      for (const [key, cell] of map) {
        variants.set(key, cellKey(cell.correct_index, cell.marks, cell.options));
      }
    } catch {
      // Base-only snapshot still detects base key changes.
    }
    return { base, variants };
  } catch {
    return null;
  }
}

function snapshotsEqual(a: AnswerKeySnapshot, b: AnswerKeySnapshot): boolean {
  if (a.base.size !== b.base.size || a.variants.size !== b.variants.size) return false;
  for (const [k, v] of a.base) if (b.base.get(k) !== v) return false;
  for (const [k, v] of a.variants) if (b.variants.get(k) !== v) return false;
  return true;
}

export type RecalcOutcome = {
  /** True when the key actually changed (recalculation ran). */
  changed: boolean;
  /** Number of stored results rewritten. */
  recalculated: number;
  /** Results left untouched (mapping could not be proven safe). */
  skipped: number;
};

/**
 * Compare the live key against a pre-save snapshot; when anything changed,
 * recompute every stored result of the exam from answers + latest key and
 * rebuild merit positions. Safe to call when nothing changed (no-op).
 */
export async function recalculateIfAnswerKeyChanged(
  examId: string,
  before: AnswerKeySnapshot | null,
): Promise<RecalcOutcome> {
  try {
    if (!before) return { changed: false, recalculated: 0, skipped: 0 };
    const after = await snapshotAnswerKey(examId);
    if (!after || snapshotsEqual(before, after)) {
      return { changed: false, recalculated: 0, skipped: 0 };
    }
    const { recalculated, skipped } = await recalculateExamResults(examId);
    return { changed: true, recalculated, skipped };
  } catch {
    return { changed: false, recalculated: 0, skipped: 0 };
  }
}

type StoredResultRow = {
  id: number;
  answers: string | null;
  details: string | null;
  timer_penalty: string | number | null;
  question_version?: string | null;
  assigned_set?: string | null;
};

type RecalcDetail = {
  questionId: number;
  chosenIndex: number | null;
  correctIndex: number | null;
  marks: number;
  obtained: number;
  question?: string;
  options?: string[];
  explanation?: string | null;
  questionImage?: string | null;
  gradingSource?: "base" | "variant";
  questionVersion?: string;
  assignedSet?: string;
};

/**
 * Recompute every stored result of one exam from immutable student answers
 * plus the latest answer key. Applies to Public AND Course exams alike.
 * Timer penalties are preserved as stored; merit is rebuilt afterwards.
 * A result is rewritten only when its key mapping is proven; the rest are
 * reported as skipped and left untouched.
 */
export async function recalculateExamResults(
  examId: string,
): Promise<{ recalculated: number; skipped: number }> {
  const id = examId?.trim();
  if (!id) return { recalculated: 0, skipped: 0 };
  const exam = await fetchExamById(id).catch(() => null);
  const negativePerWrong = negativePerWrongFor(
    exam ?? { courseType: "Academic" },
  );

  const baseRows = await query<
    { id: number; question: string; correct_index: number | null; marks: string | number; options: string; explanation: string | null; question_image?: string | null }[]
  >(
    `SELECT id, question, correct_index, marks, options, explanation, question_image FROM exam_questions
      WHERE exam_id = ? AND is_active = 1 ORDER BY sort_order ASC, id ASC`,
    [id],
  );
  if (baseRows.length === 0) return { recalculated: 0, skipped: 0 };

  const variantMap = await fetchVariantMap(id, true);

  const results = await query<StoredResultRow[]>(
    `SELECT id, answers, details, timer_penalty, question_version, assigned_set
       FROM exam_results WHERE exam_id = ? ORDER BY id ASC`,
    [id],
  ).catch(async () => {
    // Legacy DBs without the snapshot columns.
    const legacy = await query<{ id: number; answers: string | null; details: string | null; timer_penalty: string | number | null }[]>(
      `SELECT id, answers, details, timer_penalty FROM exam_results WHERE exam_id = ? ORDER BY id ASC`,
      [id],
    );
    return legacy as StoredResultRow[];
  });
  if (results.length === 0) return { recalculated: 0, skipped: 0 };

  let rewritten = 0;
  let skipped = 0;
  for (const result of results) {
    try {
      const answers = parseJsonColumn<Record<string, number>>(result.answers) ?? {};
      const storedDetails = parseJsonColumn<RecalcDetail[]>(result.details);
      const detailsList = Array.isArray(storedDetails) ? storedDetails : [];

      // Without an original option snapshot, a current numeric key cannot be
      // safely applied (options may have moved). Leave legacy rows untouched.
      if (detailsList.length === 0 || detailsList.some((d) =>
        !d || typeof d.question !== "string" || !Array.isArray(d.options) ||
        (d.gradingSource !== "base" && d.gradingSource !== "variant")
      )) {
        skipped += 1;
        continue;
      }
      const snapVersion = normalizeVersion(result.question_version ?? detailsList[0].questionVersion);
      const snapSet = normalizeSet(result.assigned_set ?? detailsList[0].assignedSet);
      const mapping =
        snapVersion && snapSet
          ? { version: snapVersion, set: snapSet } as const
          : null;
      if (!mapping) {
        skipped += 1;
        continue;
      }
      const originalIds = new Set(detailsList.map((d) => d.questionId));
      if (originalIds.size !== detailsList.length) {
        skipped += 1;
        continue;
      }
      const baseById = new Map(baseRows.map((r) => [Number(r.id), r]));
      const corrected = new Map<number, number | null>();
      for (const detail of detailsList) {
        const base = baseById.get(detail.questionId);
        if (!base) break;
        const version = "base" in mapping ? "bangla" : mapping.version;
        const set = "base" in mapping ? "A" : mapping.set;
        const live = resolveQuestions([base], detail.gradingSource === "base" ? new Map() : variantMap, version as "bangla" | "english", set as "A" | "B")[0];
        if (!live || (detail.gradingSource === "variant" && !live.fromVariant) ||
            live.question !== detail.question || JSON.stringify(live.options) !== JSON.stringify(detail.options) ||
            (live.questionImage ?? null) !== (detail.questionImage ?? null)) break;
        corrected.set(detail.questionId, live.correctIndex);
      }
      if (corrected.size !== detailsList.length) {
        skipped += 1;
        continue;
      }

      let score = 0;
      let wrongCount = 0;
      let totalMarks = 0;
      const details: RecalcDetail[] = [];
      for (const original of detailsList) {
        const qid = original.questionId;
        const correctIndex = corrected.get(qid) ?? null;
        const marks = resolveMarks(original.marks, 1);
        totalMarks += marks;
        const chosen = normalizeStoredAnswerIndex(answers[String(qid)] ?? original.chosenIndex);
        let obtained = 0;
        if (chosen !== null) {
          if (correctIndex !== null && chosen === correctIndex) obtained = marks;
          else {
            obtained = -negativePerWrong;
            wrongCount += 1;
          }
        }
        score += obtained;
        details.push({ ...original, chosenIndex: chosen, correctIndex, marks, obtained });
      }
      score = Math.max(0, Math.round(score * 100) / 100);
      totalMarks = Math.round(totalMarks * 100) / 100;
      const negativeDeduction =
        wrongCount > 0 && negativePerWrong > 0
          ? Math.round(negativePerWrong * wrongCount * 100) / 100
          : 0;
      const timerPenaltyRaw = Number(result.timer_penalty);
      const timerPenalty = Number.isFinite(timerPenaltyRaw) && timerPenaltyRaw > 0 ? timerPenaltyRaw : 0;
      const finalScore = Math.max(0, Math.round((score - timerPenalty) * 100) / 100);

      const updated = await exec(
        `UPDATE exam_results
            SET score = ?, total_marks = ?, details = ?, negative_deduction = ?
          WHERE id = ? AND details <=> ?`,
        [finalScore, totalMarks, JSON.stringify(details), negativeDeduction, result.id, result.details],
      );
      if (updated.affectedRows === 1) rewritten += 1;
      else skipped += 1;
    } catch {
      // One bad row never blocks the rest; count it as skipped.
      skipped += 1;
    }
  }

  // Rebuild merit positions for ranked attempts; practice stays NULL.
  try {
    await updateMeritPositions(id);
  } catch {
    // Best-effort — scores are already correct.
  }
  return { recalculated: rewritten, skipped };
}
