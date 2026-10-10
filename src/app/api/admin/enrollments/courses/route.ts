import { NextRequest, NextResponse } from "next/server";
import { requireAnyPermission } from "@/lib/admin";
import { fetchCatalogCourses } from "@/lib/courses-admin";
import { isCoursePublished } from "@/lib/course-catalog";

export const dynamic = "force-dynamic";

/**
 * Published + available catalog courses (slug, name, fee) for the
 * Admin → Students → Enrollments manual-assign dropdown. DB is the only
 * source — no static placeholder courses.
 */
export async function GET(request: NextRequest) {
  const admin = await requireAnyPermission(request, ["manageStudents", "manageCourses"]);
  if (!admin) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  try {
    const rows = await fetchCatalogCourses();
    const courses = rows
      .filter(isCoursePublished)
      .map((row) => ({
        slug: row.slug,
        name: row.name,
        fee: row.fee,
        discountFee: row.discountFee,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return NextResponse.json(
      { courses },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { courses: [] },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
