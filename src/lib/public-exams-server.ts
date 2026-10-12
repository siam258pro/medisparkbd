import {
  fetchExams,
  fetchPublishedPublicExams,
  type Exam,
} from "@/lib/exams-admin";
import { DEFAULT_COURSE_CATEGORIES, fetchActiveCourseCategories } from "@/lib/course-categories-store";
import { query } from "@/lib/mysql";
import { cache } from "react";
import { unstable_cache } from "next/cache";
import type { Eligibility } from "@/lib/eligibility";
import {
  batchLabel,

  deriveStatus,
  examCategories,
  examCategorySlugs,
  formatExamTime,
  toDhakaDateKey,
  type ExamCategory,
  type PublicExam,
} from "@/lib/public-exams";
import { negativePerWrongFor } from "@/lib/exam-taking";

function toPublicExam(exam: Exam): PublicExam {
  const batch = batchLabel(exam.batchId);
  const scheduledIso =
    exam.scheduledAt && !Number.isNaN(new Date(exam.scheduledAt).getTime())
      ? exam.scheduledAt
      : null;
  const endsAtIso =
    exam.endsAt && !Number.isNaN(new Date(exam.endsAt).getTime()) ? exam.endsAt : null;
  const rules: Eligibility["rules"] = [];
  if (batch) rules.push({ target: "hscBatch", batch });
  rules.push({ target: exam.courseType === "Admission" ? "admission" : "academic" });

  return {
    id: exam.id,
    categoryId: exam.categoryId ?? null,
    name: exam.title,
    description: exam.description ?? null,
    bannerUrl: exam.bannerUrl ?? null,
    // Static Live vs Practice mode — legacy `kind = "practice"` rows count
    // as practice even when their exam_mode column kept the "live" default.
    examMode: exam.examMode === "practice" || exam.kind === "practice" ? "practice" : "live",
    batch,
    courseType: exam.courseType,
    subject: exam.subject,
    totalMarks: exam.totalMarks,
    // Question count as configured by the admin (0 = unknown/not set yet).
    totalQuestions: Math.max(0, Number(exam.questionCount) || 0),
    durationMinutes: exam.durationMinutes,
    // Same rule the grader applies — rules shown must match grading exactly.
    negativeMarks: negativePerWrongFor(exam),
    negativeEnabled: exam.negativeEnabled ?? false,
    negativePerWrong: exam.negativePerWrong ?? 0.25,
    scheduledAt: scheduledIso,
    endsAt: endsAtIso,
    secondTimerEnabled: exam.secondTimerEnabled ?? false,
    secondTimerDeduction: exam.secondTimerDeduction ?? 3,
    ruleTemplate: exam.ruleTemplate ?? null,
    examDate: toDhakaDateKey(scheduledIso),
    examTime: scheduledIso ? formatExamTime(scheduledIso) : "",
    status: deriveStatus(exam),
    published: true,
    eligibility: { mode: "all", rules },
  };
}

/**
 * Live exam catalog for the public site — reads published/closed exams
 * straight from MySQL so admin-panel edits show up immediately.
 * Strict PUBLIC scope (Public Exam Control only): kind plus the absence of
 * every course relationship (chapter, direct assignment, Flow-5 format).
 * Enrolled exams are excluded — they are gated by course enrollment.
 * Pass categoryId to get ONLY one Public Exam Control category's exams
 * (SQL-level WHERE category_id = ? — same records as the Admin Panel).
 */
export async function fetchFreshPublicExams(
  options: { categoryId?: string } = {},
): Promise<PublicExam[]> {
  const { isPublicLiveHidden } = await import("@/lib/exam-lifecycle");
  const exams = options.categoryId
    ? await fetchPublishedPublicExams(options.categoryId)
    : await fetchExams({ scope: "PUBLIC", archived: false }).then((all) =>
        all.filter((exam) => exam.status !== "draft"),
      );
  // Public Live Exams hidden 12h after End disappear from the Main Website
  // list (kept in DB + Admin Panel). Practice exams are never hidden by time.
  const visible = exams.filter((exam) => !isPublicLiveHidden(exam));
  return visible.map(toPublicExam);
}

export const fetchPublicExams = unstable_cache(fetchFreshPublicExams, ['publicExams'], { revalidate: 600, tags: ['exams'] });

/**
 * Resolve a website category URL key (ssc-academic …) to its real Public
 * Exam Control category id in Course Control. Returns null when Course
 * Control has no matching category.
 */
export async function resolveExamCategoryId(
  key: ExamCategory,
): Promise<string | null> {
  const slug = examCategorySlugs[key];
  if (!slug) return null;
  const categories = await fetchActiveCourseCategories();
  return (
    categories.find(
      (category) =>
        category.slug.toLowerCase() === slug ||
        category.slug.toLowerCase().startsWith(slug),
    )?.id ?? null
  );
}

export async function fetchPublicExamById(
  id: string,
): Promise<PublicExam | null> {
  const exams = await fetchPublicExams();
  return exams.find((exam) => exam.id === id) ?? null;
}

/**
 * Exam detail page loader — includes enrolled-kind exams so their /exam/[id]
 * page renders. Actual access (course enrollment) is enforced server-side by
 * /api/exams/[id] when the student tries to participate.
 * Uses single-row fetch to avoid N+1 live-totals cost on rules page.
 *
 * Cached two ways for speed:
 * - React `cache()` dedups the generateMetadata + page-component calls that
 *   Next.js makes for the SAME request (was 2 heavy DB hits, now 1).
 * - `unstable_cache` (30s, same as the public list) shares the row across
 *   the back-to-back /rules + /prior-attempt API calls of one page load.
 */
async function fetchExamPageUncached(
  id: string,
): Promise<PublicExam | null> {
  const { fetchExamById } = await import("@/lib/exams-admin");
  const found = await fetchExamById(id);
  if (!found || found.status === "draft") return null;
  return toPublicExam(found);
}

const fetchExamPageCached = unstable_cache(fetchExamPageUncached, ["examPageById"], {
  revalidate: 600,
  tags: ["exams"],
});

export const fetchExamPageById = cache((id: string): Promise<PublicExam | null> =>
  fetchExamPageCached(id),
);

/**
 * Admin variant — same shape as the public catalog but includes drafts
 * (published=false) so the Admin Panel can manage exams before publishing.
 * Same MySQL data as the main website; nothing is hardcoded.
 */
export async function fetchAdminPublicExams(): Promise<PublicExam[]> {
  const exams = await fetchExams({ scope: "PUBLIC" });
  return exams.map((exam) => ({
    ...toPublicExam(exam),
    published: exam.status !== "draft",
  }));
}

type ExamCounts = Record<ExamCategory, number>;

type CountCategoryRow = {
  id: string;
  slug: string;
  is_active: number | boolean;
  sort_order: number;
};

type ExamCountRow = {
  category_id: string | null;
  live_count: number | string;
  practice_count: number | string;
};

/**
 * Fresh category-card inventory, using the same category relationship and
 * published PUBLIC scope as fetchPublishedPublicExams. Static practice (also
 * legacy kind=practice) is always available; published live exams become
 * practice at End Time, after Start Time, just like getPublicLiveState.
 * Course-linked exams (chapter, direct assignment, Flow-5 format) never
 * count here even when their kind is public — ownership is the module
 * relationship, not the kind label alone.
 * Bypass every persistent cache, including mysql.query's default SELECT cache.
 */
export async function fetchPublicExamCounts(): Promise<{
  counts: ExamCounts;
  practiceCounts: ExamCounts;
}> {
  const now = new Date().toISOString().slice(0, 23).replace("T", " ");
  const [categoryRows, rows] = await Promise.all([
    query<CountCategoryRow[]>(
      `SELECT id, slug, is_active, sort_order FROM course_categories
       ORDER BY sort_order ASC, created_at ASC`,
      [],
      { cache: false },
    ),
    query<ExamCountRow[]>(
      `SELECT category_id,
         SUM(CASE WHEN kind = 'public' AND COALESCE(exam_mode, 'live') <> 'practice'
           AND (scheduled_at IS NULL OR scheduled_at <= ?)
           AND (ends_at IS NULL OR ends_at > ?)
           THEN 1 ELSE 0 END) AS live_count,
         SUM(CASE WHEN exam_mode = 'practice' OR kind = 'practice'
           OR (kind = 'public' AND COALESCE(exam_mode, 'live') <> 'practice'
             AND (scheduled_at IS NULL OR scheduled_at <= ?)
             AND ends_at IS NOT NULL AND ends_at <= ?)
           THEN 1 ELSE 0 END) AS practice_count
       FROM exams
       WHERE kind IN ('public', 'practice') AND status = 'published'
         AND COALESCE(archived, 0) = 0
         AND chapter_id IS NULL AND exam_format IS NULL
         AND NOT EXISTS (SELECT 1 FROM exam_courses ec WHERE ec.exam_id = exams.id)
       GROUP BY category_id`,
      [now, now, now, now],
      { cache: false },
    ),
  ]);

  // Preserve fetchActiveCourseCategories' missing canonical-category fallback
  // and ordering, but read activation/slug changes directly from the database.
  const missingDefaults = DEFAULT_COURSE_CATEGORIES
    .filter((fallback) => !categoryRows.some((category) => category.slug === fallback.slug))
    .map((category) => ({
      id: category.id,
      slug: category.slug,
      is_active: category.isActive,
      sort_order: category.sortOrder,
    }));
  const categories = [...categoryRows, ...missingDefaults]
    .filter((category) => Boolean(category.is_active))
    .sort((a, b) => a.sort_order - b.sort_order);
  const byId = new Map(rows.map((row) => [row.category_id, row]));
  const counts = {} as ExamCounts;
  const practiceCounts = {} as ExamCounts;
  for (const { key } of examCategories) {
    const slug = examCategorySlugs[key];
    const category = categories.find((item) =>
      item.slug.toLowerCase() === slug || item.slug.toLowerCase().startsWith(slug),
    );
    // No heuristic fallback: category pages use WHERE category_id = ?, so
    // unassigned, unrelated and disabled-category exams must not inflate cards.
    const row = category ? byId.get(category.id) : undefined;
    counts[key] = Number(row?.live_count ?? 0);
    practiceCounts[key] = Number(row?.practice_count ?? 0);
  }
  return { counts, practiceCounts };
}

// Deduplicate the two initial-count props within an RSC request only, never
// across requests. The API calls the fresh combined loader directly.
const fetchRequestExamCounts = cache(fetchPublicExamCounts);

export async function fetchPracticeExamCounts(): Promise<ExamCounts> {
  return (await fetchRequestExamCounts()).practiceCounts;
}

export async function fetchLiveExamCounts(): Promise<ExamCounts> {
  return (await fetchRequestExamCounts()).counts;
}

export type PublicExamCategoryCard = {
  id: string;
  slug: string;
  name: string;
  label: string;
  liveCount: number;
  practiceCount: number;
};

/**
 * Temporary display-only gate for the main website Free Exams section.
 * The Medical Admission and HSC Academic category cards stay visible, but
 * their exam listings render empty until the section is configured.
 * No database records are affected — callers simply serve [] instead of
 * the fetched rows. Public Exam Control and all other categories are
 * untouched.
 */
export function isEmptiedFreeExamCategory(row: {
  id: string;
  slug: string;
}): boolean {
  if (row.id === "category-medical" || row.id === "category-hsc") return true;
  const slug = row.slug.trim().toLowerCase();
  return (
    slug === "medical" ||
    slug === "hsc" ||
    slug.startsWith("medical") ||
    slug.startsWith("hsc")
  );
}

/**
 * Dynamic Free Exams inventory — one entry per ACTIVE Course Category.
 * Same strict published PUBLIC scope as fetchPublicExamCounts (no
 * course-linked exams). No hardcoded list: disabling a category hides it,
 * re-enabling shows it again.
 */
export async function fetchPublicExamCategoryCards(): Promise<PublicExamCategoryCard[]> {
  const { examCategoryLabel } = await import("@/lib/public-exams");
  const now = new Date().toISOString().slice(0, 23).replace("T", " ");
  const [categoryRows, rows] = await Promise.all([
    query<{ id: string; slug: string; name: string; sort_order: number }[]>(
      `SELECT id, slug, name, sort_order FROM course_categories
       WHERE is_active = 1
       ORDER BY sort_order ASC, created_at ASC`,
      [],
      { cache: false },
    ),
    query<ExamCountRow[]>(
      `SELECT category_id,
          SUM(CASE WHEN kind = 'public' AND COALESCE(exam_mode, 'live') <> 'practice'
            AND (scheduled_at IS NULL OR scheduled_at <= ?)
            AND (ends_at IS NULL OR ends_at > ?)
            THEN 1 ELSE 0 END) AS live_count,
          SUM(CASE WHEN exam_mode = 'practice' OR kind = 'practice'
            OR (kind = 'public' AND COALESCE(exam_mode, 'live') <> 'practice'
              AND (scheduled_at IS NULL OR scheduled_at <= ?)
              AND ends_at IS NOT NULL AND ends_at <= ?)
            THEN 1 ELSE 0 END) AS practice_count
        FROM exams
        WHERE kind IN ('public', 'practice') AND status = 'published'
          AND COALESCE(archived, 0) = 0
          AND chapter_id IS NULL AND exam_format IS NULL
          AND NOT EXISTS (SELECT 1 FROM exam_courses ec WHERE ec.exam_id = exams.id)
        GROUP BY category_id`,
      [now, now, now, now],
      { cache: false },
    ),
  ]);
  const byId = new Map(rows.map((row) => [row.category_id, row]));
  return categoryRows.map((category) => {
    const row = byId.get(category.id);
    return {
      id: category.id,
      slug: category.slug,
      name: category.name,
      label: examCategoryLabel({ name: category.name, slug: category.slug }),
      liveCount: Number(row?.live_count ?? 0),
      practiceCount: Number(row?.practice_count ?? 0),
    };
  });
}

/**
 * Resolve any exam-category URL segment — legacy keys (ssc-academic, …)
 * plus raw active-category slugs (including custom categories) — to its
 * real Course Control category row. Returns null when there is no match.
 */
export async function resolveExamCategoryRow(
  segment: string,
): Promise<{ id: string; slug: string; name: string; label: string } | null> {
  const { examCategoryLabel } = await import("@/lib/public-exams");
  const key = segment.trim().toLowerCase();
  const legacy = (examCategorySlugs as Record<string, string>)[key];
  const categories = await fetchActiveCourseCategories();
  const match = legacy
    ? (categories.find(
        (category) =>
          category.slug.toLowerCase() === legacy ||
          category.slug.toLowerCase().startsWith(legacy),
      ) ?? null)
    : (categories.find((category) => category.slug.toLowerCase() === key) ?? null);
  if (!match) return null;
  return {
    id: match.id,
    slug: match.slug,
    name: match.name,
    label: examCategoryLabel({ name: match.name, slug: match.slug }),
  };
}
