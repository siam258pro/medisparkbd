import { query } from "@/lib/mysql";
import { getEnrolledExamPhase, type EnrolledExamPhase } from "@/lib/enrolled-exam-lifecycle";
import {
  batchLabel,
  formatExamTime,
  negativePerWrongFor,
  toDhakaDateKey,
  type PublicExam,
} from "@/lib/public-exams";

export type CourseExamShortcut = PublicExam & { scope: "COURSE"; phase: EnrolledExamPhase };

type CourseExamRow = {
  id: string;
  title: string;
  description: string | null;
  banner_url: string | null;
  exam_mode: string;
  batch_id: string;
  subject: string;
  course_type: string;
  duration_minutes: number;
  total_marks: number | string;
  question_count: number;
  negative_enabled: number | boolean | undefined;
  negative_per_wrong: number | string | null;
  second_timer_enabled: number | boolean;
  second_timer_deduction: number | string | null;
  scheduled_at: Date | string | null;
  ends_at: Date | string | null;
  rule_template: string | null;
};

function toIso(value: Date | string | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Course selector based on fetchPublishedCourseExams, with strict hierarchy
 * isolation and fresh reads. That existing selector's shared-subject join does
 * not constrain chapter.course_slug and can include another course's chapter.
 * Deliberately select metadata only — no answers, attempts or full catalog.
 * Pass { liveOnly: true } for the Main Website Courses Exams section, which
 * shows only the currently Live exam (no Upcoming / Practice / ended rows).
 * The course-specific exam interface uses the default (all phases). */
export async function fetchFreshCourseExamShortcuts(
  courseId: string,
  options: { liveOnly?: boolean } = {},
): Promise<CourseExamShortcut[]> {
  const rows = await query<CourseExamRow[]>(
    `SELECT ex.id, ex.title, ex.description, ex.banner_url, ex.exam_mode,
            ex.batch_id, ex.subject, ex.course_type, ex.duration_minutes,
            ex.total_marks, ex.question_count, ex.negative_enabled,
            ex.negative_per_wrong, ex.second_timer_enabled,
            ex.second_timer_deduction, ex.scheduled_at, ex.ends_at, ex.rule_template
       FROM exams ex
      WHERE ex.kind = 'enrolled' AND ex.status = 'published'
        AND (
          EXISTS (SELECT 1 FROM exam_courses ec WHERE ec.exam_id = ex.id AND ec.course_id = ?)
          OR EXISTS (
            SELECT 1 FROM course_chapters ch
             WHERE ch.id = ex.chapter_id AND ch.is_active = 1
               AND (
                 (ch.course_slug = ? AND COALESCE(ch.subject_id, '') = ''
                   AND COALESCE(ch.paper_id, '') = '')
                 OR (
                   (COALESCE(ch.course_slug, '') = '' OR ch.course_slug = ?)
                   AND EXISTS (
                     SELECT 1 FROM course_subjects s
                       JOIN course_subject_assignments a ON a.subject_id = s.id
                      WHERE s.id = ch.subject_id AND s.is_active = 1 AND a.course_slug = ?
                   )
                   AND (COALESCE(ch.paper_id, '') = '' OR EXISTS (
                     SELECT 1 FROM course_papers p
                      WHERE p.id = ch.paper_id AND p.subject_id = ch.subject_id AND p.is_active = 1
                   ))
                 )
               )
          )
        )
      ORDER BY ex.sort_order ASC, ex.created_at DESC, ex.id ASC`,
    [courseId, courseId, courseId, courseId],
    { cache: false },
  );
  if (rows.length === 0) return [];

  // Same live totals as exams-admin's applyLiveTotals: active question rows
  // win when present; a newly configured exam retains its stored totals.
  const ids = rows.map((row) => row.id);
  const totals = await query<{ exam_id: string; total: number | string | null; cnt: number }[]>(
    `SELECT exam_id, SUM(marks) AS total, COUNT(*) AS cnt FROM exam_questions
      WHERE exam_id IN (${ids.map(() => "?").join(",")}) AND is_active = 1 GROUP BY exam_id`,
    ids,
    { cache: false },
  );
  const totalsById = new Map(totals.map((row) => [row.exam_id, row]));
  const now = Date.now();
  const shortcuts: CourseExamShortcut[] = rows.map((row) => {
    const scheduledAt = toIso(row.scheduled_at);
    const endsAt = toIso(row.ends_at);
    const phase = getEnrolledExamPhase({ status: "published", scheduledAt, endsAt }, now);
    const courseType = row.course_type === "Admission" ? "Admission" : "Academic";
    const negativeEnabled = row.negative_enabled === undefined ? courseType === "Admission" : Boolean(row.negative_enabled);
    const negativePerWrong = row.negative_per_wrong == null ? 0.25 : Number(row.negative_per_wrong) || 0;
    const live = totalsById.get(row.id);
    return {
      id: row.id,
      name: row.title,
      description: row.description,
      bannerUrl: row.banner_url,
      scope: "COURSE",
      phase,
      examMode: row.exam_mode === "practice" ? "practice" : "live",
      batch: batchLabel(row.batch_id ?? ""),
      courseType,
      subject: row.subject ?? "",
      totalMarks: live && live.cnt > 0 ? Math.round(Number(live.total ?? 0) * 100) / 100 : Number(row.total_marks) || 0,
      totalQuestions: live && live.cnt > 0 ? Number(live.cnt) : Number(row.question_count) || 0,
      durationMinutes: Number(row.duration_minutes ?? 30),
      negativeMarks: negativePerWrongFor({ courseType, negativeEnabled, negativePerWrong, ruleTemplate: row.rule_template }),
      negativeEnabled,
      negativePerWrong,
      scheduledAt,
      endsAt,
      examDate: toDhakaDateKey(scheduledAt),
      examTime: scheduledAt ? formatExamTime(scheduledAt) : "",
      status: phase === "upcoming" ? "Upcoming" : phase === "archived" || phase === "practice" ? "Archived" : "Live",
      published: true,
      secondTimerEnabled: Boolean(row.second_timer_enabled),
      secondTimerDeduction: row.second_timer_deduction == null ? 5 : Number(row.second_timer_deduction) || 0,
      ruleTemplate: row.rule_template,
      eligibility: { mode: "all", rules: [] },
    };
  });
  // Main Website Courses Exams: only the currently Live exam. Live means the
  // enrolled lifecycle phase is live (unscheduled no-window rows count as
  // Live, matching the course interface) and the exam is not a static
  // Practice-mode exam. Upcoming, Practice/archived and ended rows are
  // excluded here; the course-specific exam interface keeps all phases.
  if (options.liveOnly) {
    return shortcuts.filter((exam) => exam.status === "Live" && exam.examMode !== "practice");
  }
  return shortcuts;
}
