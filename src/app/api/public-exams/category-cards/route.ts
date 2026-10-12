import { query } from "@/lib/mysql";
import { examCategoryLabel } from "@/lib/public-exams";
import { cachedJson } from "@/lib/api-cache";

export const dynamic = "force-dynamic";

type CategoryRow = {
  id: string;
  slug: string;
  name: string;
  sort_order: number;
};

type ExamCountRow = {
  category_id: string | null;
  live_count: number | string;
  practice_count: number | string;
};

/**
 * Dynamic Free Exams inventory — one entry per currently ACTIVE Course
 * Category (is_active = 1), with live/practice counts from the same
 * published PUBLIC scope as fetchPublicExamCounts. Turning a category
 * OFF hides it here immediately; turning it ON shows it again. No
 * hardcoded category list.
 */
export async function GET() {
  try {
    const now = new Date().toISOString().slice(0, 23).replace("T", " ");
    const [categoryRows, rows] = await Promise.all([
      query<CategoryRow[]>(
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
        GROUP BY category_id`,
        [now, now, now, now],
        { cache: false },
      ),
    ]);
    const byId = new Map(rows.map((row) => [row.category_id, row]));
    const categories = categoryRows.map((category) => {
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
    return cachedJson({ categories }, "NO_CACHE");
  } catch {
    return cachedJson({ error: "Failed to load exam categories." }, "NO_CACHE", { status: 503 });
  }
}
