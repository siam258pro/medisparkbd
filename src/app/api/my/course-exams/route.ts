import { NextRequest, NextResponse } from "next/server";
import { getFirebaseUser } from "@/lib/auth-api";
import { isMysqlConfigured } from "@/lib/mysql";
import { getMyEnrolledExamCourse } from "@/lib/enrolled-exams-server";
import { fetchFreshCourseExamShortcuts } from "@/lib/enrolled-exams-course-server";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

export async function GET(request: NextRequest) {
  try {
    const user = await getFirebaseUser(request);
    if (!user || !isMysqlConfigured) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401, headers });
    }
    const slug = request.nextUrl.searchParams.get("course") ?? "";
    if (!slug) return NextResponse.json({ error: "Missing course." }, { status: 400, headers });
    const course = await getMyEnrolledExamCourse(user.uid, slug);
    if (!course) {
      return NextResponse.json(
        { error: "This course is unavailable or you are not actively enrolled." },
        { status: 403, headers },
      );
    }
    // Courses Exams serves EVERY course layout (flow-1/2 legacy, flow-4,
    // flow-5 and any future layout): the selector below is layout-agnostic —
    // it returns this course's exams-table exams (kind = enrolled + this
    // course's exam_courses / chapter-chain linkage) and nothing else.
    // Flow-specific dashboard pages (flow4-exams, exam-flow) keep their own
    // content models; this endpoint is the per-course exam shortcut list.
    const exams = await fetchFreshCourseExamShortcuts(slug);
    return NextResponse.json({ course, exams }, { headers });
  } catch (error) {
    console.error("[api/my/course-exams] failed:", error);
    return NextResponse.json({ error: "Could not load your course exams." }, { status: 500, headers });
  }
}
