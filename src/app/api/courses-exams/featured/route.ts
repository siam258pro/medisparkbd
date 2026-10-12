import { NextResponse } from "next/server";
import { fetchFeaturedCoursesLiveExam } from "@/lib/enrolled-exams-course-server";

export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store" };

/**
 * GET /api/courses-exams/featured — all currently Live course exams for the
 * Main Website Courses Exams section (display-only listing).
 * Intentionally NOT gated on course enrollment: students see the live exam
 * cards without selecting a course filter. Each card reuses the existing exam
 * id, so starting the exam still goes through the unchanged exam-start flow
 * (/exam/[id]/rules → /api/exams/[id]), which enforces authentication,
 * enrollment, schedule, timer and attempt limits server-side.
 */
export async function GET() {
  try {
    const exams = await fetchFeaturedCoursesLiveExam();
    return NextResponse.json({ exams }, { headers });
  } catch (error) {
    console.error("[api/courses-exams/featured] failed:", error);
    return NextResponse.json(
      { error: "Could not load courses exams." },
      { status: 500, headers },
    );
  }
}
