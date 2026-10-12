import { NextResponse } from "next/server";
import {
  fetchFreshPublicExams,
  resolveExamCategoryRow,
} from "@/lib/public-exams-server";
import { withCache } from "@/lib/api-cache";

export const dynamic = "force-dynamic";

/**
 * Fresh (DB-direct, never Data-Cached) exam list for one category.
 * Powers the "এখনই রিফ্রেশ" button — bypasses the 10-min page cache.
 * Accepts legacy keys (ssc-academic …) and raw active-category slugs.
 */
export async function GET(request: Request) {
  const key = new URL(request.url).searchParams.get("category") ?? "";
  if (!key.trim()) {
    return NextResponse.json({ error: "Invalid category." }, { status: 400 });
  }
  try {
    const row = await resolveExamCategoryRow(key);
    if (!row) {
      return NextResponse.json({ error: "Category not found." }, { status: 404 });
    }
    const exams = await fetchFreshPublicExams({ categoryId: row.id });
    return withCache(NextResponse.json({ exams }), "NO_CACHE");
  } catch {
    return NextResponse.json({ error: "Failed to load exams." }, { status: 500 });
  }
}
