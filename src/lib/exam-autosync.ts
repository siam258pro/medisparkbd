import { ensureColumn, exec, parseJsonColumn, query, withTransaction } from "@/lib/mysql";

// ── Bilingual Exam Set Auto-Sync ────────────────────────────────────────────
// CORE RULE: Bangla rows in `exam_questions` are the SINGLE SOURCE OF TRUTH.
// English lives ONLY in `question_translations` (FK → exam_questions.id).
// No independent English question records are ever created.
// correct_option is stored as the A/B/C/D identifier (correct_index 0-3),
// never as translated text, so translation can never change the answer.

import type { Difficulty, SyncSet, SyncTopic, TranslationStatus } from "./exam-autosync-pure";
import {
  SET_REQUIRED_COUNT,
  SYNC_SETS,
  SYNC_TOPICS,
  TOPIC_REQUIRED_COUNT,
  correctIndexToLetter,
} from "./exam-autosync-pure";
export type { Difficulty, SyncLang, SyncSet, SyncTopic, TranslationStatus } from "./exam-autosync-pure";
export {
  DIFFICULTIES,
  SET_REQUIRED_COUNT,
  SYNC_SETS,
  SYNC_TOPICS,
  TOPIC_REQUIRED_COUNT,
  autoTranslateBnToEn,
  correctIndexToLetter,
  correctLetterToIndex,
  difficultyWarning,
  normalizeDifficulty,
  normalizeSyncSet,
  normalizeTopic,
} from "./exam-autosync-pure";

let ready: Promise<void> | null = null;

/** Idempotent schema bootstrap (lazy — no manual migration needed). */
export function ensureAutoSyncTables(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await exec(`CREATE TABLE IF NOT EXISTS exam_sets (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        exam_id VARCHAR(64) NOT NULL,
        set_name ENUM('A','B') NOT NULL,
        status ENUM('draft','published','blocked') NOT NULL DEFAULT 'draft',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_exam_sets_exam_set (exam_id, set_name),
        KEY idx_exam_sets_exam (exam_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await exec(`CREATE TABLE IF NOT EXISTS question_translations (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        question_id BIGINT UNSIGNED NOT NULL,
        question_uid VARCHAR(32) NULL,
        language ENUM('en') NOT NULL DEFAULT 'en',
        question_text TEXT NOT NULL,
        option_a TEXT NOT NULL,
        option_b TEXT NOT NULL,
        option_c TEXT NOT NULL,
        option_d TEXT NOT NULL,
        explanation TEXT NULL,
        translation_status ENUM('pending','translating','completed','needs_update','failed','manually_edited') NOT NULL DEFAULT 'pending',
        translated_at TIMESTAMP NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_qt_qid_lang (question_id, language),
        KEY idx_qt_uid (question_uid),
        KEY idx_qt_status (translation_status),
        CONSTRAINT fk_qt_question FOREIGN KEY (question_id)
          REFERENCES exam_questions(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      // Master-record extensions on exam_questions (all nullable/additive).
      await ensureColumn("exam_questions", "set_label", "`set_label` ENUM('A','B') NULL AFTER exam_id");
      await ensureColumn("exam_questions", "topic", "`topic` VARCHAR(64) NULL AFTER bank_subject");
      await ensureColumn("exam_questions", "difficulty", "`difficulty` ENUM('Easy','Moderate','Hard') NULL DEFAULT NULL AFTER explanation");
      await ensureColumn("exam_questions", "question_uid", "`question_uid` VARCHAR(32) NULL AFTER id");
      try {
        await exec(`CREATE UNIQUE INDEX uq_exam_questions_uid ON exam_questions(question_uid)`);
      } catch (error) {
        if ((error as { code?: string }).code !== "ER_DUP_KEYNAME") throw error;
      }
    })().catch((e) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}

export async function ensureExamSets(examId: string): Promise<void> {
  await ensureAutoSyncTables();
  for (const set of SYNC_SETS) {
    await exec(
      `INSERT IGNORE INTO exam_sets (exam_id, set_name, status) VALUES (?, ?, 'draft')`,
      [examId, set],
    );
  }
}

function nextQuestionUid(existing: Set<string>, counterStart: number): string {
  let n = counterStart;
  for (;;) {
    const uid = `BIO-Q-${String(n).padStart(4, "0")}`;
    if (!existing.has(uid)) return uid;
    n += 1;
  }
}

export async function allocateQuestionUid(): Promise<string> {
  await ensureAutoSyncTables();
  const rows = await query<{ question_uid: string | null }[]>(
    `SELECT question_uid FROM exam_questions WHERE question_uid IS NOT NULL`,
    [],
    { cache: false },
  );
  const existing = new Set(rows.map((r) => String(r.question_uid)));
  let max = 0;
  for (const uid of existing) {
    const m = /^BIO-Q-(\d+)$/.exec(uid);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return nextQuestionUid(existing, max + 1);
}

import { autoTranslateBnToEn } from "./exam-autosync-pure";

// ── Translation safety ─────────────────────────────────────────────────────
// Scientific terms pass through via the pure dictionary translator above
// (Mitochondria, Ribosome, DNA, RNA, ATP, … are never mangled).

export type MasterQuestionInput = {
  examId: string;
  set: SyncSet;
  topic: SyncTopic;
  question: string;
  options: [string, string, string, string];
  correctLetter: "A" | "B" | "C" | "D";
  difficulty?: Difficulty | null;
  explanation?: string | null;
  subject?: string;
  marks?: number;
  sortOrder?: number | null;
};

export type MasterRow = {
  id: number;
  question_uid: string | null;
  exam_id: string | null;
  set_label: SyncSet | null;
  topic: string | null;
  bank_subject: string;
  question: string;
  options: string;
  correct_index: number | null;
  explanation: string | null;
  difficulty: Difficulty | null;
  marks: string | number;
  sort_order: number | null;
  is_active: number | boolean;
};

export function masterRowToOptions(row: MasterRow): [string, string, string, string] {
  const parsed = parseJsonColumn<unknown[]>(row.options);
  const arr = Array.isArray(parsed) ? parsed.map(String) : [];
  while (arr.length < 4) arr.push("");
  return [arr[0], arr[1], arr[2], arr[3]];
}

/** Fetch Bangla master questions for one (exam, set) in admin order. */
export async function fetchMasterSet(examId: string, set: SyncSet): Promise<MasterRow[]> {
  await ensureAutoSyncTables();
  return query<MasterRow[]>(
    `SELECT id, question_uid, exam_id, set_label, topic, bank_subject, question,
            options, correct_index, explanation, difficulty, marks, sort_order, is_active
       FROM exam_questions
      WHERE exam_id = ? AND set_label = ? AND is_active = 1
      ORDER BY sort_order ASC, id ASC`,
    [examId, set],
  );
}

export type TranslationRow = {
  question_id: number;
  question_uid: string | null;
  language: string;
  question_text: string;
  option_a: string;
  option_b: string;
  option_c: string;
  option_d: string;
  explanation: string | null;
  translation_status: TranslationStatus;
};

export async function fetchTranslations(examId: string, set: SyncSet): Promise<Map<number, TranslationRow>> {
  await ensureAutoSyncTables();
  const map = new Map<number, TranslationRow>();
  const rows = await query<TranslationRow[]>(
    `SELECT t.question_id, t.question_uid, t.language, t.question_text, t.option_a,
            t.option_b, t.option_c, t.option_d, t.explanation, t.translation_status
       FROM question_translations t
       JOIN exam_questions q ON q.id = t.question_id
      WHERE q.exam_id = ? AND q.set_label = ? AND q.is_active = 1 AND t.language = 'en'`,
    [examId, set],
  );
  for (const r of rows) map.set(Number(r.question_id), r);
  return map;
}

/** Automatic sync preserves manual wording; only explicit regeneration replaces it. */
export async function syncTranslationFor(questionId: number, regenerate = false): Promise<TranslationStatus> {
  if (!Number.isSafeInteger(questionId) || questionId <= 0) return "failed";
  await ensureAutoSyncTables();
  try {
    return await withTransaction(async (connection) => {
      // Serialize source edits with translation generation; never cache this read.
      const [masters] = await connection.query(
        `SELECT id, question_uid, options, question, explanation FROM exam_questions
          WHERE id = ? AND is_active = 1 FOR UPDATE`,
        [questionId],
      );
      const row = (masters as MasterRow[])[0];
      if (!row) return "failed";
      const [translations] = await connection.query(
        `SELECT translation_status FROM question_translations WHERE question_id = ? AND language = 'en' FOR UPDATE`,
        [questionId],
      );
      const status = (translations as { translation_status: TranslationStatus }[])[0]?.translation_status;
      if (status === "manually_edited" && !regenerate) return status;
      const options = parseJsonColumn<unknown[]>(row.options);
      if (!row.question.trim() || !Array.isArray(options) || options.length !== 4
        || options.some((o) => typeof o !== "string" || !o.trim())) return "failed";
      const [a, b, c, d] = options as string[];
      await connection.query(
        `INSERT INTO question_translations
           (question_id, question_uid, language, question_text, option_a, option_b, option_c, option_d, explanation, translation_status, translated_at)
         VALUES (?, ?, 'en', ?, ?, ?, ?, ?, ?, 'completed', CURRENT_TIMESTAMP)
         ON DUPLICATE KEY UPDATE question_uid = VALUES(question_uid), question_text = VALUES(question_text),
           option_a = VALUES(option_a), option_b = VALUES(option_b), option_c = VALUES(option_c),
           option_d = VALUES(option_d), explanation = VALUES(explanation),
           translation_status = 'completed', translated_at = CURRENT_TIMESTAMP`,
        [row.id, row.question_uid ?? null, autoTranslateBnToEn(row.question),
          autoTranslateBnToEn(a), autoTranslateBnToEn(b), autoTranslateBnToEn(c), autoTranslateBnToEn(d),
          row.explanation ? autoTranslateBnToEn(row.explanation) : null],
      );
      return "completed";
    });
  } catch {
    // Preserve cached wording and manual status when the transaction rolls back.
    try {
      await exec(
        `UPDATE question_translations SET translation_status = 'failed'
          WHERE question_id = ? AND language = 'en' AND translation_status != 'manually_edited'`,
        [questionId],
      );
    } catch {}
    return "failed";
  }
}

/** Mark cached translation stale after any Bangla master change. Queued, non-blocking. */
export async function markTranslationStale(questionId: number): Promise<void> {
  await ensureAutoSyncTables();
  try {
    await exec(
      `UPDATE question_translations SET translation_status = IF(translation_status = 'manually_edited', 'manually_edited', 'needs_update')
        WHERE question_id = ? AND language = 'en'`,
      [questionId],
    );
    // Best-effort immediate regeneration (local dict = instant, never blocks UI
    // because callers never await the queue drain — fire and forget).
    void syncTranslationFor(questionId).catch(() => {});
  } catch {}
}

// ── Validation ─────────────────────────────────────────────────────────────

export type SetValidation = {
  examId: string;
  set: SyncSet;
  masterCount: number;
  expectedCount: number;
  countsOk: boolean;
  topicCounts: Record<string, number>;
  topicsOk: boolean;
  orderMatch: boolean;
  answersMatch: boolean;
  translationCoverage: number;
  translationsOk: boolean;
  difficulty: Record<Difficulty, number>;
  publishable: boolean;
  blockers: string[];
};

export async function validateSet(examId: string, set: SyncSet): Promise<SetValidation> {
  await ensureAutoSyncTables();
  const masters = await fetchMasterSet(examId, set);
  const translations = await fetchTranslations(examId, set);
  const blockers: string[] = [];
  const topicCounts: Record<string, number> = {};
  for (const t of SYNC_TOPICS) topicCounts[t] = 0;
  const difficulty: Record<Difficulty, number> = { Easy: 0, Moderate: 0, Hard: 0 };
  let answersMatch = true;
  let covered = 0;
  for (const m of masters) {
    if (m.topic && m.topic in topicCounts) topicCounts[m.topic] += 1;
    const d = m.difficulty as Difficulty | null;
    if (d && d in difficulty) difficulty[d] += 1;
    const tr = translations.get(Number(m.id));
    // English translation is a pure projection: same ID, same order, same
    // correct_index (the identifier). Structural mismatch blocks publishing.
    if (tr && (tr.translation_status === "completed" || tr.translation_status === "manually_edited")
      && [tr.question_text, tr.option_a, tr.option_b, tr.option_c, tr.option_d]
        .every((value) => typeof value === "string" && value.trim())) covered += 1;
    const options = parseJsonColumn<unknown[]>(m.options);
    if (correctIndexToLetter(m.correct_index) === null || !m.question.trim()
      || !Array.isArray(options) || options.length !== 4
      || options.some((o) => typeof o !== "string" || !o.trim())) answersMatch = false;
  }
  const countsOk = masters.length === SET_REQUIRED_COUNT;
  if (!countsOk) blockers.push(`Question count ${masters.length}/${SET_REQUIRED_COUNT}.`);
  let topicsOk = true;
  for (const t of SYNC_TOPICS) {
    if ((topicCounts[t] ?? 0) !== TOPIC_REQUIRED_COUNT) {
      topicsOk = false;
      blockers.push(`${t}: ${topicCounts[t] ?? 0}/${TOPIC_REQUIRED_COUNT}.`);
    }
  }
  if (!answersMatch) blockers.push("Every question must have a correct option (A/B/C/D).");
  const translationsOk = masters.length > 0 && covered === masters.length;
  if (!translationsOk) blockers.push(`English translations completed ${covered}/${masters.length}.`);
  // Order is defined by sort_order; a gap/duplicate breaks the auto-sync order.
  const orders = masters.map((m) => Number(m.sort_order));
  const orderMatch = orders.every((o, i) => o === i + 1) || masters.length === 0;
  if (!orderMatch) blockers.push("Question order has gaps — reorder to 1..N.");
  const publishable = blockers.length === 0;
  return {
    examId, set, masterCount: masters.length, expectedCount: SET_REQUIRED_COUNT,
    countsOk, topicCounts, topicsOk, orderMatch, answersMatch,
    translationCoverage: covered, translationsOk, difficulty, publishable, blockers,
  };
}

/** Set A ∩ Set B must be empty — question_uids are globally unique per exam. */
export async function checkSetDisjoint(examId: string): Promise<{ disjoint: boolean; duplicates: string[] }> {
  await ensureAutoSyncTables();

  // Stronger check: same master row must not be assigned to both sets (a row
  // has exactly one set_label, so any shared question_uid across rows is a dup).
  const dupRows = await query<{ question_uid: string }[]>(
    `SELECT question_uid FROM exam_questions WHERE exam_id = ? AND is_active = 1 AND question_uid IS NOT NULL
      GROUP BY question_uid HAVING COUNT(DISTINCT set_label) > 1`,
    [examId],
  );
  const duplicates = dupRows.map((r) => String(r.question_uid));
  return { disjoint: duplicates.length === 0, duplicates };
}
