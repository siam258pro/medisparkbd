import { exec, parseJsonColumn, query, ensureColumn, withTransaction } from "@/lib/mysql";
import { buildDefaultExamRules } from "@/lib/exam-rules";
import { strictAnswerIndex } from "@/lib/paste-mcq-parser";
import { revalidatePath, revalidateTag, unstable_cache } from "next/cache";

let ensureTablesReady = false;
let ensureSettingsTableReady = false;
let ensureResultTablesReady = false;
let examsCache: { data: Exam[]; at: number } | null = null;
const EXAMS_CACHE_TTL = 30_000;

function invalidateExamsCache(): void {
  examsCache = null;
  try {
    // Next.js 16 deprecates single-arg revalidateTag; use "max" profile to bust all cache lifetimes
    (revalidateTag as unknown as (tag: string, profile: string) => void)("exams", "max");
  } catch {
    // revalidateTag may not be available in all runtimes (e.g. during build)
  }
  // Featured public exams render as homepage banner slides (fetchBannerSlides
  // embeds fetchFeaturedPublicExams in its 300s cache) — bust that layer and
  // the / ISR page too, otherwise an un-featured/deleted exam lingers on the
  // banner and shows up as stale content on slow networks.
  try {
    (revalidateTag as unknown as (tag: string, profile: string) => void)("banner-slides", "max");
  } catch {
    // Best-effort.
  }
  try {
    (revalidatePath as unknown as (path: string, type: "page" | "layout") => void)("/", "page");
  } catch {
    // Best-effort.
  }
}

// Admin Panel → Exams. Exams, question bank, enrollments, results and
// settings all live in MySQL. `exam_questions.exam_id = NULL` marks a
// bank-only question; the `answer_key` JSON column on `exams` stores
// per-question correct answers for published answer keys.

export type ExamKind = "public" | "practice" | "enrolled";
export type ExamStatus = "draft" | "published" | "closed";
export type ExamMode = "live" | "practice";

/**
 * Unified Exam System — access scope.
 * ONE engine, TWO scopes (no separate architectures):
 *  - "PUBLIC" → publicly visible, everyone can access/attempt (kind public/practice).
 *  - "COURSE" → only enrolled + eligible students of the linked course_id
 *    (kind enrolled, linked via exam_courses or the chapter → subject → course chain).
 * The scope is derived from `kind` (single source of truth) and mirrored into
 * the `type` column (public/course) for SQL-level filtering. Existing rows are
 * migrated, never deleted.
 */
export type ExamScope = "PUBLIC" | "COURSE";

export function getExamScope(exam: Pick<Exam, "kind"> | { kind?: string }): ExamScope {
  const kind = (exam as { kind?: string })?.kind;
  return kind === "enrolled" ? "COURSE" : "PUBLIC";
}

export function isCourseExam(exam: Pick<Exam, "kind"> | { kind?: string }): boolean {
  return getExamScope(exam) === "COURSE";
}

/** Normalize a scope/type input ("PUBLIC"/"COURSE", "public"/"course") or null. */
export function normalizeExamScope(value: unknown): ExamScope | null {
  const token = String(value ?? "").trim().toLowerCase();
  if (token === "course" || token === "enrolled") return "COURSE";
  if (token === "public" || token === "practice") return "PUBLIC";
  return null;
}

/** Flow 5 exam category. NULL/undefined = legacy exam (never listed in Flow 5). */
export type Flow5ExamFormat = "topic-wise" | "paper-final" | "subject-final" | "final-model";

export const FLOW5_EXAM_FORMATS: Flow5ExamFormat[] = [
  "topic-wise",
  "paper-final",
  "subject-final",
  "final-model",
];

export function normalizeFlow5ExamFormat(value: unknown): Flow5ExamFormat | null {
  return (FLOW5_EXAM_FORMATS as string[]).includes(String(value)) ? (value as Flow5ExamFormat) : null;
}

export const EXAM_KINDS: ExamKind[] = ["public", "practice", "enrolled"];
export const EXAM_MODES: ExamMode[] = ["live", "practice"];

export type ExamQuestionOption = string;

export type Exam = {
  id: string;
  title: string;
  /** Public description shown on the exam details page. */
  description: string | null;
  /** Public banner image shown on the exam details page. */
  bannerUrl: string | null;
  kind: ExamKind;
  /** Live Exam vs Practice Exam — independent from Published/Draft and Running/Upcoming/Expired. */
  examMode: ExamMode;
  batchId: string;
  subject: string;
  courseType: "Academic" | "Admission";
  durationMinutes: number;
  totalMarks: number;
  negativeMarks: number;
  /** Admin ON/OFF — when true, wrong answers cost `negativePerWrong`. */
  negativeEnabled: boolean;
  negativePerWrong: number;
  /** Admin ON/OFF — repeat attempt of the SAME exam loses marks. */
  secondTimerEnabled: boolean;
  secondTimerDeduction: number;
  questionCount: number;
  status: ExamStatus;
  /** Featured public exams auto-appear as homepage slider slides. */
  featured: boolean;
  scheduledAt: string | null;
  endsAt: string | null;
  answerKey: Record<string, number> | null;
  /** Courses whose enrolled students may take this exam (kind = "enrolled"). */
  courseIds: string[];
  /**
   * Unified access scope — derived from `kind` (COURSE when kind is
   * "enrolled", otherwise PUBLIC). PUBLIC → public access; COURSE →
   * restricted to the linked course_id(s) above (or the chapter chain).
   */
  scope: ExamScope;
  /** Chapter this exam belongs to (course content Exam card). */
  chapterId: string | null;
  /** Admin-controlled display order inside a chapter. */
  sortOrder: number;
  /** Public Exam Control category (synced from Course Control categories). */
  categoryId?: string | null;
  /** Selected rule template key (medical/academic/university). */
  ruleTemplate?: string | null;
  /** Marks per question (auto-calculates totalMarks). */
  marksPerQuestion?: number | null;
  /** Flow 5 exam category (NULL = legacy exam, never listed in Flow 5). */
  examFormat?: Flow5ExamFormat | null;
  /** Flow 5 topic-wise subject key (one of the 8 fixed subjects). */
  topicSubject?: string | null;
};

export type ExamQuestion = {
  id: number | null;
  examId: string | null;
  subject: string;
  question: string;
  /** Optional per-question image (question_image column). */
  questionImage?: string | null;
  options: ExamQuestionOption[];
  /** NULL = unknown answer (rendered as "—", never defaulted to A). */
  correctIndex: number | null;
  explanation: string | null;
  marks: number;
  isActive: boolean;
};

export type ExamEnrollment = {
  id: number;
  examId: string;
  studentUid: string;
  studentName: string;
  enrolledAt: string;
};

export type ExamResult = {
  id: number;
  examId: string;
  studentUid: string;
  studentName: string;
  score: number;
  totalMarks: number;
  submittedAt: string;
  meritPosition: number | null;
  timeTakenSeconds: number | null;
};

export type ExamSettings = {
  defaultDurationMinutes: number;
  negativeMarks: number;
  allowReview: boolean;
  showAnswersAfterSubmit: boolean;
  maxAttempts: number;
};

type ExamRow = {
  id: string;
  title: string;
  description: string | null;
  banner_url: string | null;
  kind: string;
  exam_mode: string;
  batch_id: string;
  subject: string;
  course_type: string;
  duration_minutes: number;
  total_marks: number;
  negative_marks: string | number;
  negative_enabled?: number | boolean;
  negative_per_wrong?: string | number;
  second_timer_enabled?: number | boolean;
  second_timer_deduction?: string | number;
  question_count: number;
  status: string;
  featured?: number | boolean;
  scheduled_at: Date | string | null;
  ends_at?: Date | string | null;
  answer_key: string | null;
  chapter_id: string | null;
  sort_order?: string | number | null;
  category_id?: string | null;
  rule_template?: string | null;
  marks_per_question?: string | number | null;
  exam_format?: string | null;
  topic_subject?: string | null;
};

type QuestionRow = {
  id: number;
  exam_id: string | null;
  bank_subject: string;
  question: string;
  question_image?: string | null;
  options: string;
  /** NULL = unknown (never defaulted to 0/A). */
  correct_index: number | null;
  explanation: string | null;
  marks: string | number;
  sort_order?: number | null;
  is_active: number | boolean;
};

function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toNumber(value: string | number | null): number {
  if (value === null) return 0;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function rowToExam(row: ExamRow): Exam {
  const parsedKey = parseJsonColumn<unknown>(row.answer_key);
  const answerKey: Record<string, number> | null =
    parsedKey && typeof parsedKey === "object" && !Array.isArray(parsedKey)
      ? (parsedKey as Record<string, number>)
      : null;
  const kind: ExamKind =
    row.kind === "practice"
      ? "practice"
      : row.kind === "enrolled"
        ? "enrolled"
        : "public";
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? null,
    bannerUrl: row.banner_url ?? null,
    kind,
    scope: kind === "enrolled" ? "COURSE" : "PUBLIC",
    examMode: row.exam_mode === "practice" ? "practice" : "live",
    batchId: row.batch_id ?? "",
    subject: row.subject ?? "",
    courseType: row.course_type === "Admission" ? "Admission" : "Academic",
    durationMinutes: row.duration_minutes ?? 30,
    totalMarks: row.total_marks ?? 0,
    negativeMarks: toNumber(row.negative_marks),
    negativeEnabled:
      row.negative_enabled === undefined
        ? // Rows read before the column existed keep the legacy behaviour.
          row.course_type === "Admission"
        : Boolean(row.negative_enabled),
    negativePerWrong:
      row.negative_per_wrong === undefined || row.negative_per_wrong === null
        ? 0.25
        : toNumber(row.negative_per_wrong as string | number),
    secondTimerEnabled: Boolean(row.second_timer_enabled),
    secondTimerDeduction:
      row.second_timer_deduction === undefined ||
      row.second_timer_deduction === null
        ? 5
        : toNumber(row.second_timer_deduction as string | number),
    questionCount: row.question_count ?? 0,
    status:
      row.status === "published"
        ? "published"
        : row.status === "closed"
          ? "closed"
          : "draft",
    featured: Boolean(row.featured),
    scheduledAt: toIso(row.scheduled_at),
    endsAt: toIso(row.ends_at),
    answerKey,
    courseIds: [],
    chapterId: row.chapter_id ?? null,
    sortOrder: toNumber(row.sort_order ?? null),
    categoryId: row.category_id ?? null,
    ruleTemplate: row.rule_template ?? null,
    marksPerQuestion:
      row.marks_per_question === undefined || row.marks_per_question === null
        ? null
        : toNumber(row.marks_per_question as string | number),
    examFormat: normalizeFlow5ExamFormat(row.exam_format),
    topicSubject: typeof row.topic_subject === "string" && row.topic_subject ? row.topic_subject : null,
  };
}

function rowToQuestion(row: QuestionRow): ExamQuestion {
  const options = parseJsonColumn<unknown[]>(row.options);
  return {
    id: row.id,
    examId: row.exam_id,
    subject: row.bank_subject ?? "",
    question: row.question,
    questionImage: row.question_image ?? null,
    options: Array.isArray(options) ? options.map(String) : [],
    // Preserve an explicit unknown (NULL) — never coerce it to 0/A here.
    correctIndex: row.correct_index === null || row.correct_index === undefined ? null : row.correct_index,
    explanation: row.explanation,
    marks: toNumber(row.marks),
    isActive: Boolean(row.is_active),
  };
}

// ── Auto-detect Rule Template ──────────────────────────────────────────

/**
 * Auto-detect rule template based on category.
 * - Medical Admission -> 'medical'
 * - SSC/HSC Academic -> 'academic'
 * - University Admission -> 'university'
 */
export function detectRuleTemplate(category: string): string {
  const normalized = category.trim().toLowerCase();
  if (normalized.includes("medical")) return "medical";
  if (normalized.includes("university") || normalized.includes("varsity")) return "university";
  if (
    normalized.includes("ssc") ||
    normalized.includes("hsc") ||
    normalized.includes("academic")
  )
    return "academic";
  // Fallback: academic for unknown academic-like categories
  return "academic";
}

export function ruleTemplateDefaults(template: string): {
  negativeEnabled: boolean;
  negativePerWrong: number;
  secondTimerEnabled: boolean;
  secondTimerDeduction: number;
} {
  switch (template) {
    case "medical":
      return {
        negativeEnabled: true,
        negativePerWrong: 0.25,
        secondTimerEnabled: true,
        secondTimerDeduction: 3,
      };
    case "university":
      return {
        negativeEnabled: true,
        negativePerWrong: 0.25,
        secondTimerEnabled: false,
        secondTimerDeduction: 0,
      };
    case "academic":
    default:
      return {
        negativeEnabled: false,
        negativePerWrong: 0,
        secondTimerEnabled: false,
        secondTimerDeduction: 0,
      };
  }
}

// ── Ensure Question Slots ──────────────────────────────────────────────

/**
 * Ensure N question slots exist for an exam with sort_order 1..N.
 * Missing slots are created with empty question text for incomplete slots.
 */
export async function ensureQuestionSlots(examId: string, count: number): Promise<void> {
  if (!examId || !count || count <= 0) return;
  await ensureTables();
  try {
    const existing = await query<{ sort_order: number }[]>(
      `SELECT sort_order FROM exam_questions WHERE exam_id = ? ORDER BY sort_order ASC`,
      [examId],
    );
    const existingOrders = new Set(existing.map((r) => Number(r.sort_order)));
    const missing: number[] = [];
    for (let i = 1; i <= count; i += 1) {
      if (!existingOrders.has(i)) missing.push(i);
    }
    if (missing.length === 0) return;
    // Use exam's marks_per_question for slot marks when available
    let marksPerSlot = 1;
    try {
      const examRows = await query<{ marks_per_question: string | number | null }[]>(
        `SELECT marks_per_question FROM exams WHERE id = ? LIMIT 1`,
        [examId],
      );
      const raw = Number(examRows[0]?.marks_per_question ?? 1);
      if (Number.isFinite(raw) && raw > 0) marksPerSlot = raw;
    } catch {
      marksPerSlot = 1;
    }
    if (missing.length > 0) {
      const placeholders = missing.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
      const values: unknown[] = [];
      for (const sortOrder of missing) {
        // Placeholder slots use correct_index 0: production schema is
        // NOT NULL DEFAULT 0, and NULL inserts fail silently here.
        // The answer is set properly when the admin fills the slot.
        values.push(
          examId,
          "",
          "",
          null,
          JSON.stringify(["", "", "", ""]),
          0,
          null,
          marksPerSlot,
          sortOrder,
          1,
        );
      }
      await exec(
        `INSERT INTO exam_questions (exam_id, bank_subject, question, question_image, options, correct_index, explanation, marks, sort_order, is_active)
         VALUES ${placeholders}`,
        values,
      );
    }
  } catch {
    // Best-effort — slots may be created on next call.
  }
}

async function ensureTables(): Promise<void> {
  if (ensureTablesReady) return;
  await exec(`CREATE TABLE IF NOT EXISTS exams (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    kind ENUM('public','practice','enrolled') NOT NULL DEFAULT 'public',
    exam_mode ENUM('live','practice') NOT NULL DEFAULT 'live',
    batch_id VARCHAR(32) NOT NULL DEFAULT '',
    subject VARCHAR(191) NOT NULL DEFAULT '',
    course_type ENUM('Academic','Admission') NOT NULL DEFAULT 'Academic',
    duration_minutes INT NOT NULL DEFAULT 30,
    total_marks INT NOT NULL DEFAULT 0,
    negative_marks DECIMAL(4,2) NOT NULL DEFAULT 0,
    question_count INT NOT NULL DEFAULT 0,
    status ENUM('draft','published','closed') NOT NULL DEFAULT 'draft',
    scheduled_at DATETIME NULL,
    ends_at DATETIME NULL,
    answer_key JSON NULL,
    created_by VARCHAR(191) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  // Exams created before end-time support need the column added.
  try {
    await ensureColumn("exams", "ends_at", "DATETIME NULL AFTER scheduled_at");
  } catch {
    // Best effort — column may already exist.
  }
  // Enrolled exams: widen the kind enum (older installs lack 'enrolled').
  try {
    await exec(
      `ALTER TABLE exams MODIFY COLUMN kind ENUM('public','practice','enrolled') NOT NULL DEFAULT 'public'`,
    );
  } catch {
    // Best effort — already widened.
  }
  // Chapter linkage for the student course-content Exam card.
  try {
    await ensureColumn("exams", "chapter_id", "VARCHAR(64) NULL AFTER subject");
  } catch {
    // Best effort — column may already exist.
  }
  // Admin-controlled exam ordering inside a chapter.
  try {
    await ensureColumn("exams", "sort_order", "INT NOT NULL DEFAULT 0 AFTER chapter_id");
  } catch {
    // Best effort — column may already exist.
  }
  // Public exam page content managed from the Admin Panel.
  try {
    await ensureColumn("exams", "description", "TEXT NULL AFTER title");
    await ensureColumn("exams", "banner_url", "VARCHAR(1024) NULL AFTER description");
  } catch {
    // Best effort — columns may already exist.
  }
  // Per-exam grading settings + category linkage + featured slider flag.
  try {
    await ensureColumn("exams", "category_id", "`category_id` VARCHAR(64) NULL AFTER answer_key");
  } catch {
    // Best effort — column may already exist.
  }
  try {
    await ensureColumn("exams", "negative_enabled", "`negative_enabled` TINYINT(1) NOT NULL DEFAULT 0 AFTER negative_marks");
  } catch {
    // Best effort — column may already exist.
  }
  try {
    await ensureColumn("exams", "negative_per_wrong", "`negative_per_wrong` DECIMAL(4,2) NOT NULL DEFAULT 0.25 AFTER negative_enabled");
  } catch {
    // Best effort — column may already exist.
  }
  try {
    await ensureColumn("exams", "second_timer_enabled", "`second_timer_enabled` TINYINT(1) NOT NULL DEFAULT 0 AFTER negative_per_wrong");
  } catch {
    // Best effort — column may already exist.
  }
  try {
    await ensureColumn("exams", "second_timer_deduction", "`second_timer_deduction` DECIMAL(6,2) NOT NULL DEFAULT 3 AFTER second_timer_enabled");
  } catch {
    // Best effort — column may already exist.
  }
  try {
    await ensureColumn("exams", "featured", "`featured` TINYINT(1) NOT NULL DEFAULT 0 AFTER status");
  } catch {
    // Best effort — column may already exist.
  }
  // ── Exam architecture: type, active, attempt_limit ──
  try {
    await ensureColumn("exams", "type", "`type` ENUM('public','course') NOT NULL DEFAULT 'public' AFTER kind");
  } catch {
    // Best effort — column may already exist.
  }
  try {
    // Unified scope backfill — kind stays the source of truth; type mirrors it.
    // Idempotent: safe to run on every boot, never deletes or moves rows.
    await exec(`UPDATE exams SET type = 'course' WHERE kind = 'enrolled'`);
    await exec(`UPDATE exams SET type = 'public' WHERE kind IN ('public','practice')`);
  } catch {
    // Best effort — type column may not exist yet.
  }
  try {
    await exec(`CREATE INDEX idx_exams_scope_status ON exams(kind, status)`);
  } catch {
    // Best effort — index may already exist.
  }
  try {
    await ensureColumn("exams", "active", "`active` TINYINT(1) NOT NULL DEFAULT 1 AFTER featured");
  } catch {
    // Best effort — column may already exist.
  }
  try {
    await ensureColumn("exams", "attempt_limit", "`attempt_limit` INT NOT NULL DEFAULT 0 AFTER second_timer_deduction");
  } catch {
    // Best effort — column may already exist.
  }
  // Preserve legacy behaviour: Admission exams always had −0.25 per wrong.
  try {
    await exec(`UPDATE exams SET negative_enabled = 1 WHERE course_type = 'Admission' AND negative_enabled = 0`);
  } catch {
    // Best effort — column may not exist yet (apply the SQL migration).
  }
  // Archive flag for Public Exam Control archive action.
  try {
    await ensureColumn("exams", "archived", "`archived` TINYINT(1) NOT NULL DEFAULT 0 AFTER featured");
  } catch {
    // Best effort — column may already exist.
  }
  // Question ordering column for admin reorder.
  try {
    await ensureColumn("exam_questions", "sort_order", "`sort_order` INT NOT NULL DEFAULT 0 AFTER marks");
  } catch {
    // Best effort.
  }
  // ── Exam Mode: Live vs Practice (separate from Published/Draft and Running/Upcoming) ──
  try {
    await ensureColumn("exams", "exam_mode", "`exam_mode` ENUM('live','practice') NOT NULL DEFAULT 'live' AFTER kind");
  } catch {
    // Best effort — column may already exist.
  }
  // ── Exam System v2: rule_template + marks_per_question + question_image ──
  try {
    await ensureColumn("exams", "rule_template", "`rule_template` VARCHAR(32) NULL AFTER category_id");
  } catch {
    // Best effort — column may already exist.
  }
  try {
    await ensureColumn("exams", "marks_per_question", "`marks_per_question` DECIMAL(5,2) NOT NULL DEFAULT 1 AFTER total_marks");
  } catch {
    // Best effort — column may already exist.
  }
  try {
    await ensureColumn("exam_questions", "question_image", "`question_image` VARCHAR(1024) NULL AFTER question");
  } catch {
    // Best effort — column may already exist.
  }
  // ── Flow 5 exam categories (additive; legacy rows keep NULL = old Exam flow) ──
  try {
    await ensureColumn(
      "exams",
      "exam_format",
      "`exam_format` ENUM('topic-wise','paper-final','subject-final','final-model') NULL DEFAULT NULL AFTER course_type",
    );
    await ensureColumn("exams", "topic_subject", "`topic_subject` VARCHAR(64) NULL DEFAULT NULL AFTER exam_format");
  } catch {
    // Best effort — columns may already exist.
  }
  try {
    await exec(`CREATE INDEX idx_exams_flow5_format ON exams(exam_format, topic_subject, status)`);
  } catch {
    // Best effort — index may already exist.
  }
  await exec(`CREATE TABLE IF NOT EXISTS exam_courses (
    exam_id VARCHAR(64) NOT NULL,
    course_id VARCHAR(191) NOT NULL,
    PRIMARY KEY (exam_id, course_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await exec(`CREATE TABLE IF NOT EXISTS exam_questions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    exam_id VARCHAR(64) NULL,
    bank_subject VARCHAR(191) NOT NULL DEFAULT '',
    question TEXT NOT NULL,
    options JSON NOT NULL,
    correct_index INT NULL DEFAULT NULL,
    explanation TEXT NULL,
    marks DECIMAL(5,2) NOT NULL DEFAULT 1,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  // ── Normalized question options ──
  await exec(`CREATE TABLE IF NOT EXISTS exam_question_options (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    question_id BIGINT UNSIGNED NOT NULL,
    option_index INT NOT NULL,
    option_text TEXT NOT NULL,
    is_correct TINYINT(1) NOT NULL DEFAULT 0,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_eqo_question (question_id),
    KEY idx_eqo_correct (question_id, is_correct),
    CONSTRAINT fk_eqo_question FOREIGN KEY (question_id)
      REFERENCES exam_questions(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  // ── Exam sessions (heartbeat, device, IP tracking) ──
  await exec(`CREATE TABLE IF NOT EXISTS exam_sessions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    exam_id VARCHAR(64) NOT NULL,
    student_uid VARCHAR(191) NOT NULL,
    session_token VARCHAR(64) NOT NULL,
    status ENUM('active','terminated','expired') NOT NULL DEFAULT 'active',
    ip_address VARCHAR(45) NULL,
    user_agent TEXT NULL,
    started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_heartbeat TIMESTAMP NULL,
    ended_at TIMESTAMP NULL,
    UNIQUE KEY exam_sessions_token_unique (session_token),
    KEY idx_exam_sessions_exam_student (exam_id, student_uid),
    KEY idx_exam_sessions_status (status),
    KEY idx_exam_sessions_started (started_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  // ── Exam rankings (pre-computed for fast leaderboard) ──
  await exec(`CREATE TABLE IF NOT EXISTS exam_rankings (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    exam_id VARCHAR(64) NOT NULL,
    student_uid VARCHAR(191) NOT NULL,
    student_name VARCHAR(255) NOT NULL DEFAULT '',
    student_id VARCHAR(32) NULL,
    score DECIMAL(6,2) NOT NULL DEFAULT 0,
    total_marks DECIMAL(6,2) NOT NULL DEFAULT 0,
    time_taken_seconds INT NULL,
    merit_position INT NULL,
    submitted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY exam_rankings_exam_student (exam_id, student_uid),
    KEY idx_exam_rankings_exam_score (exam_id, score DESC, time_taken_seconds ASC),
    KEY idx_exam_rankings_position (exam_id, merit_position)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  // ── Historical scoring snapshot on exam_results ──
  try {
    await ensureColumn("exam_results", "snapshot_marks", "`snapshot_marks` DECIMAL(6,2) NULL");
    await ensureColumn("exam_results", "snapshot_negative_per_wrong", "`snapshot_negative_per_wrong` DECIMAL(4,2) NULL");
    await ensureColumn("exam_results", "snapshot_second_timer_deduction", "`snapshot_second_timer_deduction` DECIMAL(6,2) NULL");
    await ensureColumn("exam_results", "snapshot_duration_minutes", "`snapshot_duration_minutes` INT NULL");
    await ensureColumn("exam_results", "snapshot_negative_enabled", "`snapshot_negative_enabled` TINYINT(1) NULL");
    await ensureColumn("exam_results", "snapshot_second_timer_enabled", "`snapshot_second_timer_enabled` TINYINT(1) NULL");
  } catch {
    // Best effort — columns may already exist.
  }
  ensureTablesReady = true;
}

const EXAM_COLUMNS = `id, title, description, banner_url, kind, exam_mode, batch_id,
  subject, chapter_id, sort_order, course_type, exam_format, topic_subject, duration_minutes,
  total_marks, marks_per_question, negative_marks, negative_enabled, negative_per_wrong,
  second_timer_enabled, second_timer_deduction, question_count, status,
  featured, scheduled_at, ends_at, answer_key, category_id, rule_template`;

// ── Exams CRUD ───────────────────────────────────────────────────────────

/** exam_id → assigned course ids (for enrolled exams). */
async function fetchCourseAssignments(): Promise<Map<string, string[]>> {
  const rows = await query<{ exam_id: string; course_id: string }[]>(
    `SELECT exam_id, course_id FROM exam_courses ORDER BY course_id ASC`,
  );
  const map = new Map<string, string[]>();
  for (const row of rows) {
    const list = map.get(row.exam_id) ?? [];
    list.push(row.course_id);
    map.set(row.exam_id, list);
  }
  return map;
}

async function applyLiveTotals(exams: Exam[]): Promise<Exam[]> {
  if (exams.length === 0) return exams;
  try {
    const ids = exams.map((exam) => exam.id);
    const placeholders = ids.map(() => "?").join(",");
    const totals = await query<{ exam_id: string; total: string | number | null; cnt: number }[]>(
      `SELECT exam_id, SUM(marks) AS total, COUNT(*) AS cnt FROM exam_questions WHERE exam_id IN (${placeholders}) AND is_active = 1 GROUP BY exam_id`,
      ids,
    );
    const map = new Map<string, { total: number; cnt: number }>();
    for (const row of totals) {
      map.set(row.exam_id, {
        total: Number(row.total ?? 0) || 0,
        cnt: Number(row.cnt ?? 0) || 0,
      });
    }
    for (const exam of exams) {
      const live = map.get(exam.id);
      // Live question rows win when they exist. With no linked questions
      // yet (fresh exam, slots pending), keep the admin's configured
      // Total Questions × Marks Per Question instead of zeroing them —
      // otherwise a newly saved exam shows 0 marks until questions exist.
      if (live && live.cnt > 0) {
        exam.totalMarks = Math.round(live.total * 100) / 100;
        exam.questionCount = live.cnt;
      }
    }
  } catch {
    // Keep stored totals if live query fails — consistency is best-effort.
  }
  return exams;
}

export type ExamListFilters = {
  kind?: ExamKind;
  kinds?: ExamKind[];
  /** Unified access scope — PUBLIC (public access) or COURSE (linked course only). */
  scope?: ExamScope;
  ids?: string[];
  categoryId?: string;
  chapterId?: string;
  /** Flow 4 Exam Batch — exams assigned to this course via exam_courses. */
  courseId?: string;
  /** Filter by publish status (draft/published/closed). */
  status?: ExamStatus | ExamStatus[];
  /** Filter by archive flag (Public Exam Control archive action). */
  archived?: boolean;
};

/** Normalize the fetchExams argument (legacy single-kind string or filters). */
function normalizeExamFilters(
  kindOrFilters?: ExamKind | ExamListFilters,
): { filters: ExamListFilters; cacheable: boolean } {
  if (typeof kindOrFilters === "string") {
    return { filters: { kind: kindOrFilters }, cacheable: false };
  }
  const filters = kindOrFilters ?? {};
  const cacheable =
    !filters.kind &&
    (!filters.kinds || filters.kinds.length === 0) &&
    !filters.scope &&
    (!filters.ids || filters.ids.length === 0) &&
    !filters.categoryId &&
    !filters.chapterId &&
    !filters.courseId &&
    (!filters.status ||
      (Array.isArray(filters.status) && filters.status.length === 0)) &&
    filters.archived === undefined;
  return { filters, cacheable };
}

export async function fetchExams(
  kindOrFilters?: ExamKind | ExamListFilters,
): Promise<Exam[]> {
  const { filters, cacheable } = normalizeExamFilters(kindOrFilters);
  const now = Date.now();
  if (cacheable && examsCache && now - examsCache.at < EXAMS_CACHE_TTL) {
    return examsCache.data;
  }
  try {
    await ensureTables();
    // Push filters into SQL so list/manage pages never transfer + totalize
    // the whole exams table when they only need one kind/category/exam.
    const where: string[] = [];
    const params: unknown[] = [];
    const kinds = filters.kinds?.length
      ? filters.kinds
      : filters.kind
        ? [filters.kind]
        : [];
    if (kinds.length > 0) {
      where.push(`kind IN (${kinds.map(() => "?").join(",")})`);
      params.push(...kinds);
    }
    // Unified scope filter — derived from kind (single engine, no split tables).
    if (filters.scope === "COURSE") {
      where.push(`kind = 'enrolled'`);
    } else if (filters.scope === "PUBLIC") {
      where.push(`kind <> 'enrolled'`);
    }
    if (filters.ids?.length) {
      where.push(`id IN (${filters.ids.map(() => "?").join(",")})`);
      params.push(...filters.ids);
    }
    if (filters.categoryId) {
      where.push(`category_id = ?`);
      params.push(filters.categoryId);
    }
    if (filters.chapterId) {
      where.push(`chapter_id = ?`);
      params.push(filters.chapterId);
    }
    // Flow 4 course filter — join exam_courses (public flow untouched).
    const needsCourseJoin = Boolean(filters.courseId);
    if (filters.courseId) {
      where.push(
        `id IN (SELECT exam_id FROM exam_courses WHERE course_id = ?)`,
      );
      params.push(filters.courseId);
    }
    if (filters.status) {
      const statuses = (Array.isArray(filters.status) ? filters.status : [filters.status]).filter((st) =>
        ["draft", "published", "closed"].includes(st),
      );
      if (statuses.length > 0) {
        where.push(`status IN (${statuses.map(() => "?").join(",")})`);
        params.push(...statuses);
      }
    }
    if (filters.archived !== undefined) {
      where.push(`archived = ?`);
      params.push(filters.archived ? 1 : 0);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    void needsCourseJoin;
    const rows = await query<ExamRow[]>(
      `SELECT ${EXAM_COLUMNS} FROM exams ${clause} ORDER BY sort_order ASC, created_at DESC`,
      params,
    );
    let assignments: Map<string, string[]> | null = null;
    if (rows.some((row) => row.kind === "enrolled")) {
      assignments = await fetchCourseAssignments();
    }
    const exams = rows.map((row) => {
      const exam = rowToExam(row);
      exam.courseIds = assignments?.get(exam.id) ?? [];
      return exam;
    });
    const withTotals = await applyLiveTotals(exams);
    if (cacheable) examsCache = { data: withTotals, at: now };
    return withTotals;
  } catch {
    return [];
  }
}

export async function fetchExamById(id: string): Promise<Exam | null> {
  try {
    await ensureTables();
    const rows = await query<ExamRow[]>(`SELECT ${EXAM_COLUMNS} FROM exams WHERE id = ? LIMIT 1`, [id]);
    if (!rows[0]) return null;
    const exam = rowToExam(rows[0]);
    if (exam.kind === "enrolled") {
      const assignments = await fetchCourseAssignments();
      exam.courseIds = assignments.get(exam.id) ?? [];
    }
    const [withTotals] = await applyLiveTotals([exam]);
    return withTotals ?? exam;
  } catch {
    return null;
  }
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

/** Create or update an exam. Recomputes question_count/total_marks from linked questions when asked. */
export async function saveExam(
  input: Record<string, unknown>,
  adminUid: string,
): Promise<Exam> {
  await ensureTables();
  const id = asString(input.id);
  const title = asString(input.title);
  if (!/^[a-z0-9-]{2,64}$/.test(id)) {
    throw new Error("Exam id must be lowercase letters, numbers and dashes.");
  }
  if (title.length < 2) throw new Error("Exam title is required.");

  // Keep totals consistent with the linked questions.
  const totals = await query<{ count: number; marks: string | null }[]>(
    `SELECT COUNT(*) AS count, SUM(marks) AS marks FROM exam_questions WHERE exam_id = ? AND is_active = 1`,
    [id],
  );

  const scheduledRaw = asString(input.scheduledAt);
  const scheduledAt = scheduledRaw
    ? new Date(scheduledRaw).toISOString().slice(0, 19).replace("T", " ")
    : null;
  const endsRaw = asString(input.endsAt);
  let endsAt: string | null = null;
  if (endsRaw) {
    const endDate = new Date(endsRaw);
    if (!Number.isNaN(endDate.getTime()) && scheduledAt && endDate <= new Date(scheduledAt)) {
      throw new Error("End time must be after the start time.");
    }
    endsAt = endDate.toISOString().slice(0, 19).replace("T", " ");
  }

  let answerKeyJson: string | null = null;
  if (input.answerKey && typeof input.answerKey === "object") {
    answerKeyJson = JSON.stringify(input.answerKey);
  }

  // ── Unified scope → kind resolution ──
  // One engine: scope PUBLIC (public access) vs COURSE (linked course_id only).
  // Accepts `scope` ("PUBLIC"/"COURSE") or legacy `type` ("public"/"course")
  // as aliases; explicit scope wins over kind, otherwise kind is the truth.
  const requestedScope =
    normalizeExamScope((input as Record<string, unknown>).scope) ??
    normalizeExamScope((input as Record<string, unknown>).type);
  let kind: ExamKind = EXAM_KINDS.includes(input.kind as ExamKind)
    ? (input.kind as ExamKind)
    : "public";
  if (requestedScope === "COURSE") {
    kind = "enrolled";
  } else if (requestedScope === "PUBLIC" && kind === "enrolled") {
    kind = "public";
  }
  const scope: ExamScope = kind === "enrolled" ? "COURSE" : "PUBLIC";
  const rawExamMode = asString((input as Record<string, unknown>).examMode) || asString((input as Record<string, unknown>).exam_mode as string);
  const examMode: ExamMode = rawExamMode === "practice" ? "practice" : "live";
  const courseIds = Array.isArray(input.courseIds)
    ? Array.from(new Set(input.courseIds.map(String).map((value) => value.trim()).filter(Boolean)))
    : [];
  const chapterId = asString(input.chapterId) || null;
  // COURSE scope must stay linked to a course: direct exam_courses assignment
  // OR the chapter → subject → course chain. Chapter-linked course exams keep
  // working without a direct assignment (backward compatible, no data loss).
  if (kind === "enrolled" && courseIds.length === 0 && !chapterId) {
    throw new Error("Assign at least one course to a course exam.");
  }
  const categoryId = asString(input.categoryId) || null;
  // ── Rule template auto-detection ──
  let ruleTemplate = asString((input as Record<string, unknown>).ruleTemplate) || asString((input as Record<string, unknown>).rule_template as string) || "";
  if (!ruleTemplate) {
    const categoryForDetect = asString((input as Record<string, unknown>).category as string) || "";
    if (categoryForDetect) {
      ruleTemplate = detectRuleTemplate(categoryForDetect);
    } else if (categoryId) {
      // Resolve the human-readable category name/slug from Course Control for accurate template selection.
      try {
        const catRows = await query<{ name: string; slug: string }[]>(
          `SELECT name, slug FROM course_categories WHERE id = ? LIMIT 1`,
          [categoryId],
        );
        const cat = catRows[0];
        if (cat) {
          const token = `${cat.slug ?? ""} ${cat.name ?? ""}`.trim();
          if (token) ruleTemplate = detectRuleTemplate(token);
        }
        // Fallback to raw id detection if lookup fails
        if (!ruleTemplate) ruleTemplate = detectRuleTemplate(categoryId);
      } catch {
        ruleTemplate = detectRuleTemplate(categoryId);
      }
    }
  }
  const allowedTemplates = new Set(["medical", "academic", "university"]);
  if (ruleTemplate && !allowedTemplates.has(ruleTemplate)) {
    // Normalize unexpected values via detector
    ruleTemplate = detectRuleTemplate(ruleTemplate);
  }
  const resolvedRuleTemplate: string | null = ruleTemplate || null;

  // ── Marks per question & total marks auto-calc ──
  const marksPerQuestionRaw = Number((input as Record<string, unknown>).marksPerQuestion ?? (input as Record<string, unknown>).marks_per_question ?? 1);
  const marksPerQuestion =
    Number.isFinite(marksPerQuestionRaw) && marksPerQuestionRaw > 0
      ? Math.min(100, marksPerQuestionRaw)
      : 1;

  const questionCountRaw = Number((input as Record<string, unknown>).questionCount ?? (input as Record<string, unknown>).question_count ?? (input as Record<string, unknown>).totalQuestions ?? 0);
  const requestedQuestionCount =
    Number.isFinite(questionCountRaw) && questionCountRaw > 0
      ? Math.floor(questionCountRaw)
      : 0;

  // Per-exam marking settings (Admin → Public Exam Control).
  let negativeEnabled = input.negativeEnabled === true;
  const negativePerWrongRaw = Number(input.negativePerWrong);
  let negativePerWrong =
    Number.isFinite(negativePerWrongRaw) && negativePerWrongRaw > 0
      ? Math.min(99, negativePerWrongRaw)
      : 0.25;
  let secondTimerEnabled = input.secondTimerEnabled === true;
  const secondTimerDeductionRaw = Number(input.secondTimerDeduction);
  let secondTimerDeduction =
    Number.isFinite(secondTimerDeductionRaw) && secondTimerDeductionRaw > 0
      ? Math.min(9999, secondTimerDeductionRaw)
      : 3;

  // Override with template defaults when a template is selected, but keep Second Timer deduction editable (default 3)
  if (resolvedRuleTemplate) {
    const defaults = ruleTemplateDefaults(resolvedRuleTemplate);
    negativeEnabled = defaults.negativeEnabled;
    negativePerWrong = defaults.negativePerWrong;
    // Allow admin to override Second Timer penalty amount even with template (editable, suggested 3)
    if (input.secondTimerEnabled !== undefined || input.secondTimerDeduction !== undefined) {
      secondTimerEnabled = input.secondTimerEnabled === true;
      if (secondTimerEnabled) {
        const raw = Number(input.secondTimerDeduction);
        secondTimerDeduction = Number.isFinite(raw) && raw > 0 ? Math.min(9999, raw) : defaults.secondTimerDeduction || 3;
      } else {
        secondTimerDeduction = 0;
      }
    } else {
      secondTimerEnabled = defaults.secondTimerEnabled;
      secondTimerDeduction = defaults.secondTimerDeduction;
    }
  }

  const featured = input.featured === true;
  // Keep the admin's explicit order; new exams without one go to the end.
  let sortOrder = Math.max(0, Number(input.sortOrder) || 0);
  if (!sortOrder && !id) {
    const maxRows = await query<{ m: string | number | null }[]>(
      `SELECT MAX(sort_order) AS m FROM exams`,
    );
    sortOrder = toNumber(maxRows[0]?.m ?? null) + 1;
  }

  // Auto-calculate total marks when questionCount + marksPerQuestion are provided,
  // otherwise fall back to existing linked-question totals for backward compatibility.
  let questionCount: number;
  let totalMarks: number;
  if (requestedQuestionCount > 0) {
    questionCount = requestedQuestionCount;
    totalMarks = questionCount * marksPerQuestion;
  } else if (totals[0]?.count && totals[0]?.count > 0) {
    questionCount = totals[0].count;
    totalMarks = Number(totals[0].marks ?? 0) || questionCount * marksPerQuestion;
  } else {
    const fallbackCount = Number((input as Record<string, unknown>).question_count ?? 0) || 0;
    const fallbackMarks = Number(input.totalMarks ?? 0) || 0;
    questionCount = fallbackCount || 0;
    totalMarks = fallbackMarks || (questionCount ? questionCount * marksPerQuestion : 0);
  }

  const existing = await query<{ id: string; status: string }[]>(
    `SELECT id, status FROM exams WHERE id = ? LIMIT 1`,
    [id],
  );
  const isNew = existing.length === 0;
  const previousStatus = isNew ? null : (existing[0]?.status ?? null);
  // ── Flow 5 exam category (additive; NULL keeps the legacy Exam flow) ──
  // Topic-wise exams must carry one subject; other formats never keep one
  // (prevents mixing categories). When the caller does not send these keys
  // (e.g. the Public Exam Control payload), preserve the stored values so an
  // unrelated edit never wipes or leaks a Flow-5 category.
  const carriesFormatKey =
    Object.prototype.hasOwnProperty.call(input, "examFormat") ||
    Object.prototype.hasOwnProperty.call(input, "exam_format");
  const carriesSubjectKey =
    Object.prototype.hasOwnProperty.call(input, "topicSubject") ||
    Object.prototype.hasOwnProperty.call(input, "topic_subject");
  let examFormat = carriesFormatKey
    ? normalizeFlow5ExamFormat(input.examFormat ?? (input as Record<string, unknown>).exam_format)
    : null;
  let topicSubject: string | null = null;
  if (!isNew && (!carriesFormatKey || !carriesSubjectKey)) {
    try {
      const prev = await query<{ exam_format: string | null; topic_subject: string | null }[]>(
        `SELECT exam_format, topic_subject FROM exams WHERE id = ? LIMIT 1`,
        [id],
      );
      if (!carriesFormatKey) examFormat = normalizeFlow5ExamFormat(prev[0]?.exam_format);
      if (!carriesSubjectKey) topicSubject = prev[0]?.topic_subject ?? null;
    } catch {
      // Best effort — fall through to input-derived values.
    }
  }
  if (carriesSubjectKey) {
    const rawTopicSubject = asString(input.topicSubject ?? (input as Record<string, unknown>).topic_subject);
    topicSubject = examFormat === "topic-wise" && rawTopicSubject ? rawTopicSubject.slice(0, 64) : null;
  } else if (examFormat !== "topic-wise") {
    topicSubject = null;
  }
  // Single transaction: exam upsert + default rules + question slots + course
  // sync + scope mirror — all succeed or all roll back (same withTransaction
  // pattern as saveQuestionsBulk). Reads above stay outside; only writes are
  // inside.
  const examParams: unknown[] = [
    id,
    title,
    asString(input.description) || null,
    asString(input.bannerUrl) || null,
    kind,
    examMode,
    asString(input.batchId),
    asString(input.subject),
    chapterId,
    sortOrder,
    input.courseType === "Admission" ? "Admission" : "Academic",
    examFormat,
    topicSubject,
    Math.max(1, Number(input.durationMinutes) || 30),
    totalMarks,
    marksPerQuestion,
    Math.max(0, Number(input.negativeMarks) || 0) || (negativeEnabled ? negativePerWrong : 0),
    negativeEnabled ? 1 : 0,
    negativePerWrong,
    secondTimerEnabled ? 1 : 0,
    secondTimerDeduction,
    questionCount,
    ["draft", "published", "closed"].includes(String(input.status))
      ? String(input.status)
      : "draft",
    featured ? 1 : 0,
    scheduledAt,
    endsAt,
    answerKeyJson,
    categoryId,
    resolvedRuleTemplate,
    adminUid,
  ];
  const examUpsertSql = `INSERT INTO exams (${EXAM_COLUMNS}, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE title = VALUES(title), description = VALUES(description),
       banner_url = VALUES(banner_url),
       kind = VALUES(kind), exam_mode = VALUES(exam_mode), batch_id = VALUES(batch_id),
       subject = VALUES(subject), chapter_id = VALUES(chapter_id), sort_order = VALUES(sort_order),
       category_id = VALUES(category_id), rule_template = VALUES(rule_template),
       course_type = VALUES(course_type),
       exam_format = VALUES(exam_format), topic_subject = VALUES(topic_subject),
       duration_minutes = VALUES(duration_minutes),
       total_marks = VALUES(total_marks), marks_per_question = VALUES(marks_per_question), negative_marks = VALUES(negative_marks),
       negative_enabled = VALUES(negative_enabled),
       negative_per_wrong = VALUES(negative_per_wrong),
       second_timer_enabled = VALUES(second_timer_enabled),
       second_timer_deduction = VALUES(second_timer_deduction),
       question_count = VALUES(question_count), status = VALUES(status),
       featured = VALUES(featured),
       scheduled_at = VALUES(scheduled_at), ends_at = VALUES(ends_at),
       answer_key = VALUES(answer_key), created_by = VALUES(created_by)`;
  await withTransaction(async (conn) => {
    await conn.query(examUpsertSql, examParams);

    // New exams start with their template's rule set from the central Exam
    // Rules page — fully editable/deletable afterwards from Exam Control.
    if (isNew) {
      try {
        const [have] = await conn.query(`SELECT id FROM exam_rules WHERE exam_id = ? LIMIT 1`, [id]);
        if ((have as unknown[]).length === 0) {
          const { normalizeTemplate, normalizeLang } = await import("@/lib/exam-rule-templates");
          let seeded = false;
          try {
            for (const lang of ["bangla", "english"] as const) {
              const [tpl] = await conn.query(
                `SELECT rule_title, rule_text, sort_order FROM exam_rule_template_items WHERE template = ? AND lang = ? ORDER BY sort_order ASC`,
                [normalizeTemplate(resolvedRuleTemplate), normalizeLang(lang)],
              );
              const tplRows = tpl as unknown as { rule_title: string | null; rule_text: string; sort_order: number }[];
              const rows =
                tplRows.length > 0
                  ? tplRows.map((r) => ({ title: r.rule_title ?? "", text: r.rule_text, sortOrder: r.sort_order }))
                  : buildDefaultExamRules(id, resolvedRuleTemplate, lang).map((r) => ({ title: r.title, text: r.text, sortOrder: r.sortOrder }));
              for (const r of rows) {
                await conn.query(
                  `INSERT INTO exam_rules (exam_id, lang, rule_title, rule_text, sort_order) VALUES (?, ?, ?, ?, ?)`,
                  [id, lang, r.title, r.text, r.sortOrder],
                );
              }
            }
            seeded = true;
          } catch {
            seeded = false;
          }
          if (!seeded) {
            for (const lang of ["bangla", "english"] as const) {
              const rules = buildDefaultExamRules(id, resolvedRuleTemplate, lang);
              for (const rule of rules) {
                await conn.query(
                  `INSERT INTO exam_rules (exam_id, lang, rule_title, rule_text, sort_order) VALUES (?, ?, ?, ?, ?)`,
                  [rule.examId, lang, rule.title, rule.text, rule.sortOrder],
                );
              }
            }
          }
        }
      } catch {
        // Best effort — rules can still be added manually.
      }
    }

    // Auto-generate question slots when exam is created with question_count = N
    if (questionCount > 0) {
      try {
        const [have] = await conn.query(
          `SELECT sort_order FROM exam_questions WHERE exam_id = ? ORDER BY sort_order ASC`,
          [id],
        );
        const existingOrders = new Set((have as unknown as { sort_order: number }[]).map((r) => Number(r.sort_order)));
        const missing: number[] = [];
        for (let i = 1; i <= questionCount; i += 1) {
          if (!existingOrders.has(i)) missing.push(i);
        }
        if (missing.length > 0) {
          let marksPerSlot = marksPerQuestion;
          try {
            const [examRows] = await conn.query(`SELECT marks_per_question FROM exams WHERE id = ? LIMIT 1`, [id]);
            const raw = Number((examRows as unknown as { marks_per_question: string | number | null }[])[0]?.marks_per_question ?? marksPerQuestion);
            if (Number.isFinite(raw) && raw > 0) marksPerSlot = raw;
          } catch {
            // Keep input-derived marks.
          }
          const placeholders = missing.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
          const values: unknown[] = [];
          for (const order of missing) {
            // correct_index 0 (not NULL): production schema is NOT NULL
            // DEFAULT 0 — NULL fails the whole slot insert. Answer is set
            // when the admin fills the slot.
            values.push(id, "", "", null, JSON.stringify(["", "", "", ""]), 0, null, marksPerSlot, order, 1);
          }
          await conn.query(
            `INSERT INTO exam_questions (exam_id, bank_subject, question, question_image, options, correct_index, explanation, marks, sort_order, is_active)
             VALUES ${placeholders}`,
            values,
          );
        }
      } catch {
        // Best effort — slots may be created on next edit.
      }
      // Total Questions is the paper definition: slots beyond N leave the
      // paper (content preserved, reactivatable), and leftover empty slots
      // inside 1..N come back. Nothing is ever deleted, so result history
      // and authored content always survive a count change.
      try {
        await conn.query(
          `UPDATE exam_questions SET is_active = 0
            WHERE exam_id = ? AND sort_order > ? AND is_active <> 0`,
          [id, questionCount],
        );
      } catch {
        // Best effort — surplus stays visible until the next save.
      }
      try {
        const [inRange] = await conn.query(
          `SELECT q.id FROM exam_questions q
             LEFT JOIN exam_question_variants v ON v.question_id = q.id
            WHERE q.exam_id = ? AND q.sort_order <= ? AND q.is_active = 0
              AND (q.question IS NULL OR q.question = '')
              AND (q.question_image IS NULL OR q.question_image = '')
              AND (q.options IS NULL OR q.options = ''
                   OR q.options = '[]' OR q.options = '["","","",""]')
            GROUP BY q.id HAVING COUNT(v.question_id) = 0`,
          [id, questionCount],
        );
        const emptyIds = (inRange as unknown as { id: number }[]).map((r) => Number(r.id));
        if (emptyIds.length > 0) {
          const ph = emptyIds.map(() => "?").join(",");
          await conn.query(
            `UPDATE exam_questions SET is_active = 1 WHERE id IN (${ph})`,
            emptyIds,
          );
        }
      } catch {
        // Best effort — empty slots stay hidden until reactivated manually.
      }
      // Stored totals follow the live paper so the configured count and the
      // displayed count can never drift apart again.
      try {
        const [totRows] = await conn.query(
          `SELECT COUNT(*) AS count, SUM(marks) AS marks FROM exam_questions
            WHERE exam_id = ? AND is_active = 1`,
          [id],
        );
        const tot = (totRows as unknown as { count: number; marks: string | null }[])[0];
        await conn.query(`UPDATE exams SET question_count = ?, total_marks = ? WHERE id = ?`, [
          tot?.count ?? 0,
          Number(tot?.marks ?? 0) || 0,
          id,
        ]);
      } catch {
        // Best effort — readers recompute live totals anyway.
      }
    }

    // Keep course assignments in sync (COURSE scope).
    // Chapter-linked course exams (chapter_id chain) keep working with an empty
    // assignment list — the link itself carries the course scope.
    await conn.query(`DELETE FROM exam_courses WHERE exam_id = ?`, [id]);
    for (const courseId of courseIds) {
      await conn.query(`INSERT IGNORE INTO exam_courses (exam_id, course_id) VALUES (?, ?)`, [id, courseId]);
    }
    // Mirror the unified scope into the `type` column (public/course) so
    // SQL-level scope filtering stays consistent with `kind`. Best-effort on
    // legacy DBs where the column may not exist yet.
    try {
      await conn.query(`UPDATE exams SET type = ? WHERE id = ?`, [scope === "COURSE" ? "course" : "public", id]);
    } catch {
      // Best effort — kind remains the source of truth.
    }
  });

  const rows = await query<ExamRow[]>(`SELECT ${EXAM_COLUMNS} FROM exams WHERE id = ? LIMIT 1`, [id]);
  if (!rows[0]) throw new Error("Failed to save the exam.");
  const exam = rowToExam(rows[0]);
  exam.courseIds = courseIds;
  exam.chapterId = chapterId;
  exam.scope = scope;
  invalidateExamsCache();
  // Automatic publish notifications (Notification Control):
  //  - PUBLIC exam newly published → all students ("New Public Exam Published")
  //  - COURSE exam newly added/published → enrolled students of THOSE courses
  // Fires only on creation-as-published or the draft → published transition,
  // never on plain edits. Fully non-blocking + exactly-once.
  const becamePublished =
    ["draft", "published", "closed"].includes(String(input.status)) &&
    String(input.status) === "published" &&
    previousStatus !== "published";
  if (becamePublished) {
    const scopeSnapshot = scope;
    const courseIdsSnapshot = [...courseIds];
    const chapterSnapshot = chapterId;
    const titleSnapshot = title;
    void import("@/lib/notification-events")
      .then((events) => {
        if (scopeSnapshot === "COURSE") {
          return events
            .resolveCourseSlugsForExam(id, chapterSnapshot)
            .then((slugs) =>
              events.notifyCourseExamAdded({
                examId: id,
                examName: titleSnapshot,
                courseSlugs: slugs.length > 0 ? slugs : courseIdsSnapshot,
              }),
            );
        }
        return events.notifyPublicExamPublished(id, titleSnapshot);
      })
      .catch(() => undefined);
  }
  return exam;
}

/** Alias for saveExam for backward compatibility (exam creation). */
export const createExam = saveExam;

/** Change display order of exams from an ordered id list. */
export async function reorderExams(orderedIds: string[]): Promise<void> {
  await ensureTables();
  await withTransaction(async (conn) => {
    for (let index = 0; index < orderedIds.length; index += 1) {
      await conn.query(`UPDATE exams SET sort_order = ? WHERE id = ?`, [
        index + 1,
        orderedIds[index],
      ]);
    }
  });
  invalidateExamsCache();
}

export async function deleteExam(id: string): Promise<void> {
  await ensureTables();
  await withTransaction(async (conn) => {
    await conn.query(`DELETE FROM exam_questions WHERE exam_id = ?`, [id]);
    await conn.query(`DELETE FROM exam_enrollments WHERE exam_id = ?`, [id]);
    await conn.query(`DELETE FROM exam_results WHERE exam_id = ?`, [id]);
    await conn.query(`DELETE FROM exam_courses WHERE exam_id = ?`, [id]);
    await conn.query(`DELETE FROM exam_rules WHERE exam_id = ?`, [id]);
    await conn.query(`DELETE FROM exams WHERE id = ?`, [id]);
  });
  invalidateExamsCache();
}

// ── Question bank ────────────────────────────────────────────────────────

export async function fetchQuestions(
  filters: { examId?: string; subject?: string } = {},
): Promise<ExamQuestion[]> {
  try {
    await ensureTables();
    const where: string[] = [];
    const params: unknown[] = [];
    if (filters.examId) {
      where.push(filters.examId === "bank" ? "exam_id IS NULL" : "exam_id = ?");
      if (filters.examId !== "bank") params.push(filters.examId);
    }
    if (filters.subject) {
      where.push("bank_subject = ?");
      params.push(filters.subject);
    }
    // NOTE: capped at 500 rows — callers needing more must paginate (shape is
    // intentionally unchanged: plain ExamQuestion[], no truncation flag).
    const sql = `SELECT * FROM exam_questions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY sort_order ASC, id ASC LIMIT 500`;
    const rows = await query<QuestionRow[]>(sql, params);
    return rows.map(rowToQuestion);
  } catch {
    return [];
  }
}

export async function saveQuestion(
  input: Record<string, unknown>,
): Promise<ExamQuestion[]> {
  await ensureTables();
  const questionImageEarly =
    asString((input as Record<string, unknown>).questionImage as string) ||
    asString((input as Record<string, unknown>).question_image as string) ||
    null;
  const text = asString(input.question);
  if (text.length < 3 && !questionImageEarly) throw new Error("Question text or image is required (add at least 3 characters or an image).");
  const options = Array.isArray(input.options)
    ? input.options.map((option) => String(option))
    : [];
  if (options.length < 2 || options.some((option) => option.length === 0)) {
    throw new Error("At least two non-empty options are required.");
  }
  // Strict: missing/malformed answers are rejected loudly — never stored as A.
  const correctIndex = strictAnswerIndex(input.correctIndex as unknown, options.length);
  if (correctIndex === null) {
    throw new Error("Correct answer is missing or invalid — select A, B, C or D.");
  }
  const marks = Math.max(0.5, Number(input.marks) || 1);
  if (!Number.isFinite(marks) || marks <= 0) throw new Error("Marks must be a positive number.");
  const orderRaw = Number(input.order);
  const explicitOrder = Number.isInteger(orderRaw) && orderRaw > 0 ? orderRaw : null;
  const examId = asString(input.examId) || null;
  const questionImage = questionImageEarly;
  const values = [
    examId,
    asString(input.subject),
    text,
    questionImage,
    JSON.stringify(options),
    correctIndex,
    asString(input.explanation) || null,
    marks,
    input.isActive === false ? 0 : 1,
  ];

  const existingId = Number(input.id);
  if (Number.isInteger(existingId) && existingId > 0) {
    // Update an existing question (possibly moving it between exams/bank).
    const current = await query<{ exam_id: string | null }[]>(
      `SELECT exam_id FROM exam_questions WHERE id = ? LIMIT 1`,
      [existingId],
    );
    if (!current[0]) throw new Error("Question not found.");
    const orderClause = explicitOrder !== null ? `, sort_order = ${explicitOrder}` : "";
    await exec(
      `UPDATE exam_questions SET exam_id = ?, bank_subject = ?, question = ?, question_image = ?,
         options = ?, correct_index = ?, explanation = ?, marks = ?, is_active = ?${orderClause}
       WHERE id = ?`,
      [...values, existingId],
    );
    await recomputeExamTotals(current[0].exam_id);
    await recomputeExamTotals(examId);
    invalidateExamsCache();
    return fetchQuestions({ examId: examId ?? "bank", subject: asString(input.subject) });
  }

  // New question: assign next sort_order within this exam/bank scope.
  let nextOrder = 1;
  if (examId) {
    try {
      const max = await query<{ m: number | null }[]>(`SELECT MAX(sort_order) AS m FROM exam_questions WHERE exam_id = ?`, [examId]);
      nextOrder = (max[0]?.m ?? 0) + 1;
    } catch {
      nextOrder = 1;
    }
  } else {
    try {
      const max = await query<{ m: number | null }[]>(`SELECT MAX(sort_order) AS m FROM exam_questions WHERE exam_id IS NULL`);
      nextOrder = (max[0]?.m ?? 0) + 1;
    } catch {
      nextOrder = 1;
    }
  }
  const sortOrder = explicitOrder ?? nextOrder;
  await exec(
    `INSERT INTO exam_questions (exam_id, bank_subject, question, question_image, options, correct_index, explanation, marks, sort_order, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [values[0], values[1], values[2], values[3], values[4], values[5], values[6], values[7], sortOrder, values[8]],
  );
  await recomputeExamTotals(examId);
  invalidateExamsCache();
  return fetchQuestions({ examId: examId ?? "bank", subject: asString(input.subject) });
}

/**
 * Bulk save — saves multiple questions for one exam in a single request.
 * Only touches supplied items, preserves untouched questions, and recomputes
 * exam totals once at the end (vs per-question). Returns the exam's fresh
 * question list so the client can sync IDs without a second fetch.
 */
export async function saveQuestionsBulk(
  examId: string,
  items: Record<string, unknown>[],
): Promise<{ questions: ExamQuestion[]; savedIds: number[] }> {
  await ensureTables();
  const cleanExamId = asString(examId);
  if (!cleanExamId || !/^[a-z0-9-]{2,64}$/.test(cleanExamId)) throw new Error("Invalid exam id.");
  if (!Array.isArray(items) || items.length === 0) throw new Error("No questions to save.");
  if (items.length > 200) throw new Error("Too many questions in one batch (max 200).");

  // Validate all items upfront (fast fail, no DB work on invalid payload)
  for (let idx = 0; idx < items.length; idx += 1) {
    const input = items[idx] as Record<string, unknown>;
    const qImage =
      asString((input as Record<string, unknown>).questionImage as string) ||
      asString((input as Record<string, unknown>).question_image as string) ||
      null;
    const text = asString(input.question);
    if (text.length < 3 && !qImage) throw new Error(`Q${String(idx + 1).padStart(2, "0")}: Question text or image is required.`);
    const options = Array.isArray(input.options) ? input.options.map((o) => String(o)) : [];
    if (options.length < 2 || options.some((o) => o.length === 0)) throw new Error(`Q${String(idx + 1).padStart(2, "0")}: At least two non-empty options are required.`);
    // Strict: missing/malformed answers fail loudly — never stored as A.
    const correctIndex = strictAnswerIndex(input.correctIndex as unknown, options.length);
    if (correctIndex === null) throw new Error(`Q${String(idx + 1).padStart(2, "0")}: Correct answer is missing or invalid — select A, B, C or D.`);
    const marks = Math.max(0.5, Number(input.marks) || 1);
    if (!Number.isFinite(marks) || marks <= 0) throw new Error(`Q${String(idx + 1).padStart(2, "0")}: Marks must be positive.`);
  }

  // Single transaction: all updates/inserts + totals recompute atomically on one connection.
  const savedIds = await withTransaction(async (conn) => {
    const ids: number[] = [];
    // Determine next sort_order once
    let nextOrder = 1;
    try {
      const [rows] = await conn.query(`SELECT MAX(sort_order) AS m FROM exam_questions WHERE exam_id = ?`, [cleanExamId]);
      const r = rows as unknown as { m: number | null }[];
      nextOrder = (r[0]?.m ?? 0) + 1;
    } catch {
      nextOrder = 1;
    }

    for (let idx = 0; idx < items.length; idx += 1) {
      const input = items[idx] as Record<string, unknown>;
      const qImage =
        asString((input as Record<string, unknown>).questionImage as string) ||
        asString((input as Record<string, unknown>).question_image as string) ||
        null;
      const text = asString(input.question);
      const options = Array.isArray(input.options) ? input.options.map((o) => String(o)) : [];
      const correctIndex = Number(input.correctIndex);
      const marks = Math.max(0.5, Number(input.marks) || 1);
      const orderRaw = Number(input.order);
      const explicitOrder = Number.isInteger(orderRaw) && orderRaw > 0 ? orderRaw : null;
      const subject = asString(input.subject);
      const explanation = asString(input.explanation) || null;
      const isActive = input.isActive === false ? 0 : 1;
      const existingId = Number(input.id);
      if (Number.isInteger(existingId) && existingId > 0) {
        const [curRows] = await conn.query(`SELECT exam_id FROM exam_questions WHERE id = ? LIMIT 1`, [existingId]);
        const cur = curRows as unknown as { exam_id: string | null }[];
        if (!cur[0]) throw new Error(`Question ${existingId} not found.`);
        const orderClause = explicitOrder !== null ? `, sort_order = ${explicitOrder}` : "";
        await conn.query(
          `UPDATE exam_questions SET exam_id = ?, bank_subject = ?, question = ?, question_image = ?, options = ?, correct_index = ?, explanation = ?, marks = ?, is_active = ?${orderClause} WHERE id = ?`,
          [cleanExamId, subject, text, qImage, JSON.stringify(options), correctIndex, explanation, marks, isActive, existingId],
        );
        ids.push(existingId);
      } else {
        const sortOrder = explicitOrder ?? nextOrder++;
        const [result] = await conn.query(
          `INSERT INTO exam_questions (exam_id, bank_subject, question, question_image, options, correct_index, explanation, marks, sort_order, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [cleanExamId, subject, text, qImage, JSON.stringify(options), correctIndex, explanation, marks, sortOrder, isActive],
        );
        const insertId = (result as unknown as { insertId?: number })?.insertId;
        if (insertId) ids.push(Number(insertId));
      }
    }
    // Recompute exam totals once, within transaction (single connection, no extra pool roundtrip)
    try {
      const [totRows] = await conn.query(`SELECT COUNT(*) AS count, SUM(marks) AS marks FROM exam_questions WHERE exam_id = ? AND is_active = 1`, [cleanExamId]);
      const tot = (totRows as unknown as { count: number; marks: string | null }[])[0];
      await conn.query(`UPDATE exams SET question_count = ?, total_marks = ? WHERE id = ?`, [tot?.count ?? 0, Number(tot?.marks ?? 0) || 0, cleanExamId]);
    } catch {
      // Best-effort
    }
    return ids;
  });

  // Fetch fresh questions outside transaction (one query) — keeps read after commit consistent
  const questions = await fetchQuestions({ examId: cleanExamId });
  // Populate any missing insertIds from fresh list (e.g. if driver didn't return insertId)
  if (savedIds.length < items.length) {
    const freshIds = questions.map((q) => q.id).filter((id): id is number => id !== null);
    savedIds.length = 0;
    freshIds.forEach((id) => savedIds.push(id));
  }
  // Invalidate exams cache so updated totals show immediately without stale 30s cache
  invalidateExamsCache();
  return { questions, savedIds };
}

export async function duplicateQuestion(id: number): Promise<ExamQuestion[]> {
  await ensureTables();
  const rows = await query<QuestionRow[]>(`SELECT * FROM exam_questions WHERE id = ? LIMIT 1`, [id]);
  const src = rows[0];
  if (!src) throw new Error("Question not found.");
  const next = await query<{ m: number | null }[]>(
    src.exam_id ? `SELECT MAX(sort_order) AS m FROM exam_questions WHERE exam_id = ?` : `SELECT MAX(sort_order) AS m FROM exam_questions WHERE exam_id IS NULL`,
    src.exam_id ? [src.exam_id] : [],
  );
  const sortOrder = (next[0]?.m ?? 0) + 1;
  await withTransaction(async (conn) => {
    const [result] = await conn.query(
      `INSERT INTO exam_questions (exam_id, bank_subject, question, question_image, options, correct_index, explanation, marks, sort_order, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [src.exam_id, src.bank_subject, src.question, (src as unknown as { question_image?: string | null }).question_image ?? null, src.options, src.correct_index, src.explanation, Math.max(0.5, Number(src.marks) || 1), sortOrder, 1],
    );
    const newId = (result as unknown as { insertId?: number })?.insertId;
    // Carry the bilingual variant cells (bangla/english x set A/B) to the copy.
    if (newId) {
      try {
        await conn.query(
          `INSERT INTO exam_question_variants (question_id, lang, set_label, question, options, correct_index, explanation, marks, question_image)
           SELECT ?, lang, set_label, question, options, correct_index, explanation, marks, question_image
           FROM exam_question_variants WHERE question_id = ?`,
          [newId, id],
        );
      } catch {
        // Best effort — variants table may not exist yet.
      }
    }
  });
  await recomputeExamTotals(src.exam_id);
  invalidateExamsCache();
  return fetchQuestions({ examId: src.exam_id ?? "bank" });
}

export async function reorderQuestions(examId: string | null, orderedIds: number[]): Promise<ExamQuestion[]> {
  await ensureTables();
  await withTransaction(async (conn) => {
    for (let index = 0; index < orderedIds.length; index += 1) {
      await conn.query(`UPDATE exam_questions SET sort_order = ? WHERE id = ? AND ${examId ? "exam_id = ?" : "exam_id IS NULL"}`, examId ? [index + 1, orderedIds[index], examId] : [index + 1, orderedIds[index]]);
    }
  });
  const key = examId ?? "bank";
  invalidateExamsCache();
  return fetchQuestions({ examId: key });
}

/** Attach a copy of a reusable bank question to an exam. */
export async function attachBankQuestion(
  questionId: number,
  examId: string,
): Promise<ExamQuestion[]> {
  await ensureTables();
  if (!/^[a-z0-9-]{2,64}$/.test(examId)) {
    throw new Error("Invalid exam id.");
  }
  const source = await query<
    { bank_subject: string; question: string; question_image: string | null; options: string; correct_index: number; explanation: string | null; marks: string | number }[]
  >(
    `SELECT bank_subject, question, question_image, options, correct_index, explanation, marks
     FROM exam_questions WHERE id = ? AND exam_id IS NULL LIMIT 1`,
    [questionId],
  );
  const src = source[0];
  if (!src) throw new Error("Bank question not found.");
  // Append at the end (MAX sort_order + 1) so the copy never collides with an
  // existing slot order.
  let nextOrder = 1;
  try {
    const max = await query<{ m: number | null }[]>(`SELECT MAX(sort_order) AS m FROM exam_questions WHERE exam_id = ?`, [examId]);
    nextOrder = (max[0]?.m ?? 0) + 1;
  } catch {
    nextOrder = 1;
  }
  await exec(
    `INSERT INTO exam_questions (exam_id, bank_subject, question, question_image, options, correct_index, explanation, marks, sort_order, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [examId, src.bank_subject, src.question, (src as unknown as { question_image?: string | null }).question_image ?? null, src.options, src.correct_index, src.explanation, Math.max(0.5, Number(src.marks) || 1), nextOrder],
  );
  await recomputeExamTotals(examId);
  invalidateExamsCache();
  return fetchQuestions({ examId });
}

export async function deleteQuestion(id: number): Promise<void> {
  await ensureTables();
  const rows = await query<{ exam_id: string | null }[]>(
    `SELECT exam_id FROM exam_questions WHERE id = ? LIMIT 1`,
    [id],
  );
  await withTransaction(async (conn) => {
    // Explicit variant cleanup alongside the FK CASCADE — legacy DBs may lack
    // the constraint, and orphans would otherwise leak into variant lookups.
    try {
      await conn.query(`DELETE FROM exam_question_variants WHERE question_id = ?`, [id]);
    } catch {
      // Best effort — variants table may not exist yet.
    }
    await conn.query(`DELETE FROM exam_questions WHERE id = ?`, [id]);
  });
  await recomputeExamTotals(rows[0]?.exam_id ?? null);
  invalidateExamsCache();
}

export async function duplicateExam(sourceId: string, adminUid: string): Promise<Exam> {
  await ensureTables();
  const rows = await query<ExamRow[]>(`SELECT ${EXAM_COLUMNS} FROM exams WHERE id = ? LIMIT 1`, [sourceId]);
  const src = rows[0];
  if (!src) throw new Error("Exam not found.");
  const baseId = sourceId.replace(/-copy.*$/, "");
  let newId = `${baseId}-copy-${Date.now().toString(36).slice(2, 6)}`.slice(0, 64).toLowerCase();
  // Ensure uniqueness
  let attempt = 0;
  while (attempt < 5) {
    const exists = await query<{ id: string }[]>(`SELECT id FROM exams WHERE id = ? LIMIT 1`, [newId]);
    if (exists.length === 0) break;
    newId = `${baseId}-copy-${Date.now().toString(36).slice(2, 6)}${attempt}`.slice(0, 64).toLowerCase();
    attempt += 1;
  }
  const newTitle = `${src.title} (Copy)`.slice(0, 255);
  // Preserve sort order: put duplicate after source
  const maxRows = await query<{ m: number | null }[]>(`SELECT MAX(sort_order) AS m FROM exams`);
  const nextOrder = (maxRows[0]?.m ?? 0) + 1;
  // Read source payloads before the transaction (reads outside; copy writes atomic).
  const qs = await query<QuestionRow[]>(`SELECT * FROM exam_questions WHERE exam_id = ?`, [sourceId]);
  let ruleRows: { rule_title: string; rule_text: string; sort_order: number }[] = [];
  try {
    ruleRows = await query<{ rule_title: string; rule_text: string; sort_order: number }[]>(`SELECT rule_title, rule_text, sort_order FROM exam_rules WHERE exam_id = ? ORDER BY sort_order ASC`, [sourceId]);
  } catch {
    // rules table may not exist yet
  }
  let courseRows: { course_id: string }[] = [];
  try {
    courseRows = await query<{ course_id: string }[]>(`SELECT course_id FROM exam_courses WHERE exam_id = ?`, [sourceId]);
  } catch {
    // best effort
  }
  // Single transaction: exam + questions (+ their variants) + rules + course
  // assignments + scope mirror + totals — a partial copy never persists.
  await withTransaction(async (conn) => {
    await conn.query(
      `INSERT INTO exams (${EXAM_COLUMNS}, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId,
        newTitle,
        src.description,
        src.banner_url,
        src.kind,
        (src as unknown as { exam_mode?: string }).exam_mode ?? "live",
        src.batch_id,
        src.subject,
        src.chapter_id,
        nextOrder,
        src.course_type,
        src.exam_format ?? null,
        src.topic_subject ?? null,
        src.duration_minutes,
        0,
        (src as unknown as { marks_per_question?: string | number | null }).marks_per_question ?? 1,
        src.negative_marks,
        src.negative_enabled ?? 0,
        src.negative_per_wrong ?? 0.25,
        src.second_timer_enabled ?? 0,
        src.second_timer_deduction ?? 3,
        0,
        "draft",
        0,
        null,
        null,
        null,
        src.category_id ?? null,
        (src as unknown as { rule_template?: string | null }).rule_template ?? null,
        adminUid,
      ],
    );
    // Copy questions (+ their bilingual variant cells, remapped to the new ids)
    for (const q of qs) {
      const [result] = await conn.query(
        `INSERT INTO exam_questions (exam_id, bank_subject, question, question_image, options, correct_index, explanation, marks, sort_order, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [newId, q.bank_subject, q.question, (q as unknown as { question_image?: string | null }).question_image ?? null, q.options, q.correct_index, q.explanation, q.marks, q.sort_order ?? 0, q.is_active],
      );
      const newQid = (result as unknown as { insertId?: number })?.insertId;
      if (newQid) {
        try {
          await conn.query(
            `INSERT INTO exam_question_variants (question_id, lang, set_label, question, options, correct_index, explanation, marks, question_image)
             SELECT ?, lang, set_label, question, options, correct_index, explanation, marks, question_image
             FROM exam_question_variants WHERE question_id = ?`,
            [newQid, q.id],
          );
        } catch {
          // Best effort — variants table may not exist yet.
        }
      }
    }
    // Copy rules
    for (const r of ruleRows) {
      await conn.query(`INSERT INTO exam_rules (exam_id, rule_title, rule_text, sort_order) VALUES (?, ?, ?, ?)`, [newId, r.rule_title, r.rule_text, r.sort_order]);
    }
    // Copy course assignments (same COURSE scope linkage as the source).
    for (const c of courseRows) {
      await conn.query(`INSERT IGNORE INTO exam_courses (exam_id, course_id) VALUES (?, ?)`, [newId, c.course_id]);
    }
    // Mirror the unified scope (kind → type) for the duplicate.
    try {
      await conn.query(`UPDATE exams SET type = ? WHERE id = ?`, [
        src.kind === "enrolled" ? "course" : "public",
        newId,
      ]);
    } catch {
      // Best effort — kind remains the source of truth.
    }
    // Recompute totals inside the transaction (single connection).
    try {
      const [totRows] = await conn.query(`SELECT COUNT(*) AS count, SUM(marks) AS marks FROM exam_questions WHERE exam_id = ? AND is_active = 1`, [newId]);
      const tot = (totRows as unknown as { count: number; marks: string | null }[])[0];
      await conn.query(`UPDATE exams SET question_count = ?, total_marks = ? WHERE id = ?`, [tot?.count ?? 0, Number(tot?.marks ?? 0) || 0, newId]);
    } catch {
      // Best-effort sync.
    }
  });
  invalidateExamsCache();
  const newRows = await query<ExamRow[]>(`SELECT ${EXAM_COLUMNS} FROM exams WHERE id = ? LIMIT 1`, [newId]);
  if (!newRows[0]) throw new Error("Failed to duplicate exam.");
  const exam = rowToExam(newRows[0]);
  const assignments = await fetchCourseAssignments();
  exam.courseIds = assignments.get(newId) ?? [];
  return exam;
}

export async function archiveExam(id: string, archived: boolean): Promise<void> {
  await ensureTables();
  try {
    await exec(`UPDATE exams SET archived = ? WHERE id = ?`, [archived ? 1 : 0, id]);
  } catch {
    // fallback to closed status if column missing
    await setExamStatus(id, archived ? "closed" : "draft");
    return;
  }
  // Also mirror status for legacy filter: archived exams should be closed; unarchived → draft
  try {
    await exec(`UPDATE exams SET status = ? WHERE id = ? AND archived = ?`, [archived ? "closed" : "draft", id, archived ? 1 : 0]);
  } catch {
    // ignore
  }
  invalidateExamsCache();
}

/** Keep exams.question_count / total_marks in sync with linked questions. */
async function recomputeExamTotals(examId: string | null): Promise<void> {
  if (!examId) return; // bank-only question — nothing to update
  try {
    const totals = await query<{ count: number; marks: string | null }[]>(
      `SELECT COUNT(*) AS count, SUM(marks) AS marks
       FROM exam_questions WHERE exam_id = ? AND is_active = 1`,
      [examId],
    );
    await exec(
      `UPDATE exams SET question_count = ?, total_marks = ? WHERE id = ?`,
      [
        totals[0]?.count ?? 0,
        Number(totals[0]?.marks ?? 0) || 0,
        examId,
      ],
    );
  } catch {
    // Best-effort sync.
  }
}

// ── Enrollments & Results ────────────────────────────────────────────────

async function ensureResultTables(): Promise<void> {
  if (ensureResultTablesReady) return;
  await exec(`CREATE TABLE IF NOT EXISTS exam_enrollments (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    exam_id VARCHAR(64) NOT NULL,
    student_uid VARCHAR(191) NOT NULL,
    student_name VARCHAR(255) NOT NULL DEFAULT '',
    enrolled_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY exam_enrollments_unique (exam_id, student_uid)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await exec(`CREATE TABLE IF NOT EXISTS exam_results (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    exam_id VARCHAR(64) NOT NULL,
    student_uid VARCHAR(191) NOT NULL,
    student_name VARCHAR(255) NOT NULL DEFAULT '',
    score DECIMAL(6,2) NOT NULL DEFAULT 0,
    total_marks DECIMAL(6,2) NOT NULL DEFAULT 0,
    answers JSON NULL,
    submitted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY exam_results_exam_idx (exam_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  // Databases created before the richer result storage need these columns.
  try {
    await ensureColumn("exam_results", "time_taken_seconds", "INT NULL");
    await ensureColumn("exam_results", "merit_position", "INT NULL");
    await ensureColumn("exam_results", "details", "JSON NULL");
    await ensureColumn("exam_results", "negative_deduction", "`negative_deduction` DECIMAL(6,2) NOT NULL DEFAULT 0");
    await ensureColumn("exam_results", "timer_penalty", "`timer_penalty` DECIMAL(6,2) NOT NULL DEFAULT 0");
    await ensureColumn("exam_results", "is_second_timer", "`is_second_timer` TINYINT(1) NOT NULL DEFAULT 0");
  } catch {
    // Best effort — columns may already exist.
  }
  ensureResultTablesReady = true;
}

type EnrollmentRow = {
  id: number;
  exam_id: string;
  student_uid: string;
  student_name: string;
  enrolled_at: Date | string;
};

type ResultRow = EnrollmentRow & {
  score: string | number;
  total_marks: string | number;
  submitted_at: Date | string;
  merit_position: number | null;
  time_taken_seconds: number | null;
};

export async function fetchEnrollments(examId?: string): Promise<ExamEnrollment[]> {
  try {
    await ensureResultTables();
    const rows = examId
      ? await query<EnrollmentRow[]>(
          `SELECT * FROM exam_enrollments WHERE exam_id = ? ORDER BY enrolled_at DESC LIMIT 1000`,
          [examId],
        )
      : await query<EnrollmentRow[]>(
          `SELECT * FROM exam_enrollments ORDER BY enrolled_at DESC LIMIT 1000`,
        );
    return rows.map((row) => ({
      id: row.id,
      examId: row.exam_id,
      studentUid: row.student_uid,
      studentName: row.student_name,
      enrolledAt: toIso(row.enrolled_at) ?? "",
    }));
  } catch {
    return [];
  }
}

export async function fetchResults(examId?: string): Promise<ExamResult[]> {
  try {
    await ensureResultTables();
    const rows = examId
      ? await query<ResultRow[]>(
          `SELECT * FROM exam_results WHERE exam_id = ? ORDER BY submitted_at DESC LIMIT 1000`,
          [examId],
        )
      : await query<ResultRow[]>(
          `SELECT * FROM exam_results ORDER BY submitted_at DESC LIMIT 1000`,
        );
    return rows.map((row) => ({
      id: row.id,
      examId: row.exam_id,
      studentUid: row.student_uid,
      studentName: row.student_name,
      score: toNumber(row.score),
      totalMarks: toNumber(row.total_marks),
      submittedAt: toIso(row.submitted_at) ?? "",
      meritPosition: row.merit_position ?? null,
      timeTakenSeconds: row.time_taken_seconds ?? null,
    }));
  } catch {
    return [];
  }
}

export async function deleteResult(id: number): Promise<void> {
  await ensureResultTables();
  await exec(`DELETE FROM exam_results WHERE id = ?`, [id]);
}

// ── Settings ─────────────────────────────────────────────────────────────

type SettingsRow = {
  default_duration_minutes: number;
  negative_marks: string | number;
  allow_review: number | boolean;
  show_answers_after_submit: number | boolean;
  max_attempts: number;
};

async function ensureSettingsTable(): Promise<void> {
  if (ensureSettingsTableReady) return;
  await exec(`CREATE TABLE IF NOT EXISTS exam_settings (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    default_duration_minutes INT NOT NULL DEFAULT 30,
    negative_marks DECIMAL(4,2) NOT NULL DEFAULT 0.25,
    allow_review TINYINT(1) NOT NULL DEFAULT 1,
    show_answers_after_submit TINYINT(1) NOT NULL DEFAULT 0,
    max_attempts INT NOT NULL DEFAULT 1,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    updated_by VARCHAR(191) NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await exec(`INSERT IGNORE INTO exam_settings (id) VALUES ('active')`);
  ensureSettingsTableReady = true;
}

const DEFAULT_SETTINGS: ExamSettings = {
  defaultDurationMinutes: 30,
  negativeMarks: 0.25,
  allowReview: true,
  showAnswersAfterSubmit: false,
  maxAttempts: 1,
};

export async function fetchExamSettings(): Promise<ExamSettings> {
  try {
    await ensureSettingsTable();
    const rows = await query<SettingsRow[]>(
      `SELECT * FROM exam_settings WHERE id = 'active' LIMIT 1`,
    );
    const row = rows[0];
    if (!row) return DEFAULT_SETTINGS;
    return {
      defaultDurationMinutes: row.default_duration_minutes ?? 30,
      negativeMarks: toNumber(row.negative_marks),
      allowReview: Boolean(row.allow_review),
      showAnswersAfterSubmit: Boolean(row.show_answers_after_submit),
      maxAttempts: row.max_attempts ?? 1,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveExamSettings(
  input: Record<string, unknown>,
  adminUid: string,
): Promise<ExamSettings> {
  await ensureSettingsTable();
  await exec(
    `UPDATE exam_settings SET
       default_duration_minutes = ?, negative_marks = ?, allow_review = ?,
       show_answers_after_submit = ?, max_attempts = ?, updated_by = ?
     WHERE id = 'active'`,
    [
      Math.max(1, Number(input.defaultDurationMinutes) || 30),
      Math.max(0, Number(input.negativeMarks) || 0),
      input.allowReview === false ? 0 : 1,
      input.showAnswersAfterSubmit ? 1 : 0,
      Math.max(1, Number(input.maxAttempts) || 1),
      adminUid,
    ],
  );
  return fetchExamSettings();
}

/** Quick publish/unpublish/close toggle from the admin exam list. */
export async function setExamStatus(
  id: string,
  status: ExamStatus,
): Promise<void> {
  await ensureTables();
  if (!["draft", "published", "closed"].includes(status)) {
    throw new Error("Invalid exam status.");
  }
  // Previous state for the automatic publish notifications.
  let previousStatus: string | null = null;
  let examTitle = "";
  let examKind = "";
  let examChapterId: string | null = null;
  try {
    const before = await query<
      { status: string; title: string; kind: string; chapter_id: string | null }[]
    >(
      `SELECT status, title, kind, chapter_id FROM exams WHERE id = ? LIMIT 1`,
      [id],
    );
    previousStatus = before[0]?.status ?? null;
    examTitle = before[0]?.title ?? "";
    examKind = before[0]?.kind ?? "";
    examChapterId = before[0]?.chapter_id ?? null;
  } catch {
    // Best effort — the status update below is authoritative.
  }
  const result = await exec(`UPDATE exams SET status = ? WHERE id = ?`, [status, id]);
  if (!result.affectedRows) throw new Error("Exam not found.");
  invalidateExamsCache();
  if (status === "published" && previousStatus !== "published") {
    const examIdSnapshot = id;
    const titleSnapshot = examTitle || id;
    const kindSnapshot = examKind;
    const chapterSnapshot = examChapterId;
    void import("@/lib/notification-events")
      .then((events) => {
        if (kindSnapshot === "enrolled") {
          return events
            .resolveCourseSlugsForExam(examIdSnapshot, chapterSnapshot)
            .then((slugs) =>
              events.notifyCourseExamAdded({
                examId: examIdSnapshot,
                examName: titleSnapshot,
                courseSlugs: slugs,
              }),
            );
        }
        return events.notifyPublicExamPublished(examIdSnapshot, titleSnapshot);
      })
      .catch(() => undefined);
  }
}

/**
 * Whether a student may take an enrolled exam — true when they have an
 * active (or completed) enrollment in at least one assigned course.
 * Primary check is exam_courses JOIN enrollments; fallback checks the
 * exam's chapter → subject → course_slug when exam_courses is empty
 * (chapter-scoped course exams).
 */
export async function hasEnrolledExamAccess(
  examId: string,
  uid: string,
): Promise<boolean> {
  try {
    await ensureTables();
    const rows = await query<{ ok: number }[]>(
      `SELECT 1 AS ok FROM exam_courses ec
       JOIN enrollments e ON e.course_id = ec.course_id AND e.student_uid = ?
       WHERE ec.exam_id = ? AND e.enrollment_status IN ('active','completed')
       LIMIT 1`,
      [uid, examId],
    );
    if (rows.length > 0) return true;
    // Fallback: chapter-scoped exam (exams.chapter_id → course_chapters → course_subject_assignments → enrollments)
    try {
      const fallback = await query<{ ok: number }[]>(
        `SELECT 1 AS ok FROM exams ex
         JOIN course_chapters ch ON ch.id = ex.chapter_id
         JOIN course_subject_assignments a ON a.subject_id = ch.subject_id
         JOIN enrollments e ON e.course_id = a.course_slug AND e.student_uid = ?
         WHERE ex.id = ? AND e.enrollment_status IN ('active','completed')
         LIMIT 1`,
        [uid, examId],
      );
      if (fallback.length > 0) return true;
      // Direct course exams (subject-less): exams.chapter_id with course_slug on chapter
      const direct = await query<{ ok: number }[]>(
        `SELECT 1 AS ok FROM exams ex
         JOIN course_chapters ch ON ch.id = ex.chapter_id
         JOIN enrollments e ON e.course_id = ch.course_slug AND e.student_uid = ?
         WHERE ex.id = ? AND e.enrollment_status IN ('active','completed')
         AND COALESCE(ch.subject_id,'') = ''
         LIMIT 1`,
        [uid, examId],
      );
      return direct.length > 0;
    } catch {
      return false;
    }
  } catch {
    // Fail closed — never leak gated exams on DB errors.
    return false;
  }
}

/**
 * Public exams highlighted as banner slides on the homepage. The exam itself
 * is the source of truth — toggling Featured in the Admin Panel makes the
 * slide appear/disappear automatically (no manual banner records).
 */
export async function fetchFeaturedPublicExams(): Promise<Exam[]> {
  try {
    await ensureTables();
    const rows = await query<ExamRow[]>(
      `SELECT ${EXAM_COLUMNS} FROM exams
       WHERE featured = 1 AND status = 'published' AND kind = 'public'
       ORDER BY sort_order ASC, created_at DESC`,
    );
    return await applyLiveTotals(rows.map(rowToExam));
  } catch {
    return [];
  }
}

/**
 * Published public exams for the Main Website, optionally scoped to ONE
 * Public Exam Control category (SQL-level WHERE category_id = ?). This is
 * the shared Admin Panel → Database → Main Website relationship: an exam
 * created under a category in Public Exam Control appears under that same
 * category on the website automatically.
 */
export async function fetchPublishedPublicExams(
  categoryId?: string,
): Promise<Exam[]> {
  try {
    await ensureTables();
    const params: unknown[] = [];
    // PUBLIC scope category listing — both public + practice kinds belong to
    // the Main Website (course/enrolled exams never leak here).
    let where = `kind IN ('public','practice') AND status = 'published'`; // closed/draft stay hidden
    if (categoryId && categoryId.trim()) {
      where += ` AND category_id = ?`;
      params.push(categoryId.trim());
    }
    const rows = await query<ExamRow[]>(
      `SELECT ${EXAM_COLUMNS} FROM exams
       WHERE ${where}
       ORDER BY sort_order ASC, created_at DESC`,
      params,
    );
    return await applyLiveTotals(rows.map(rowToExam));
  } catch {
    return [];
  }
}

/**
 * Published COURSE-scope exams for ONE course (Course Content → enrolled
 * students only). Same unified engine/rows as public exams — only the access
 * scope differs. Links via exam_courses (direct) OR the chapter → subject →
 * course chain (chapter-scoped course exams). Never leaks other courses'
 * exams or PUBLIC exams.
 */
export async function fetchPublishedCourseExams(
  courseId: string,
): Promise<Exam[]> {
  const course = courseId?.trim();
  if (!course) return [];
  try {
    await ensureTables();
    const rows = await query<ExamRow[]>(
      `SELECT ${EXAM_COLUMNS} FROM exams ex
        WHERE ex.kind = 'enrolled' AND ex.status = 'published'
          AND (
            EXISTS (SELECT 1 FROM exam_courses ec WHERE ec.exam_id = ex.id AND ec.course_id = ?)
            OR EXISTS (
              SELECT 1 FROM course_chapters ch
                JOIN course_subject_assignments a ON a.subject_id = ch.subject_id
               WHERE ch.id = ex.chapter_id AND a.course_slug = ?
            )
            OR EXISTS (
              SELECT 1 FROM course_chapters ch2
               WHERE ch2.id = ex.chapter_id AND ch2.course_slug = ?
            )
          )
        ORDER BY ex.sort_order ASC, ex.created_at DESC`,
      [course, course, course],
    );
    const exams = rows.map(rowToExam);
    const assignments = await fetchCourseAssignments();
    for (const exam of exams) exam.courseIds = assignments.get(exam.id) ?? [];
    return await applyLiveTotals(exams);
  } catch {
    return [];
  }
}
