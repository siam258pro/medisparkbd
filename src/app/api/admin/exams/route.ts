import { NextRequest, NextResponse } from "next/server";
import { requirePermission, requireAnyPermission } from "@/lib/admin";
import { logAdminAction } from "@/lib/administration";
import {
  fetchExams,
  fetchExamById,
  saveExam,
  deleteExam,
  setExamStatus,
  reorderExams,
  normalizeExamScope,
  EXAM_KINDS,
  type ExamKind,
  type ExamStatus,
} from "@/lib/exams-admin";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const admin = await requireAnyPermission(request, ["manageExams", "managePublicExam"]);
  if (!admin) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  // ?kind=enrolled or ?kind=public,practice (comma-separated).
  const kindParam = request.nextUrl.searchParams.get("kind");
  const kinds = kindParam
    ? kindParam
        .split(",")
        .map((value) => value.trim())
        .filter((value): value is ExamKind =>
          EXAM_KINDS.includes(value as ExamKind),
        )
    : [];
  // Single-exam fetch for the management page (?id=<examId>) — one row
  // instead of the whole table.
  const idParam = request.nextUrl.searchParams.get("id")?.trim() ?? "";
  if (idParam) {
    const exam = await fetchExamById(idParam);
    return NextResponse.json(
      { exams: exam ? [exam] : [] },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  // Backend-enforced category isolation (category_id synced from Course
  // Control categories). Exams without a category never leak into a list.
  // Filters are pushed into SQL — no full-table transfer.
  const categoryId = request.nextUrl.searchParams.get("categoryId")?.trim() || undefined;
  const chapterId = request.nextUrl.searchParams.get("chapterId")?.trim() || undefined;
  const courseId = request.nextUrl.searchParams.get("courseId")?.trim() || undefined;
  // Unified scope filter (?scope=PUBLIC|COURSE) — same engine, access differs.
  const scope = normalizeExamScope(request.nextUrl.searchParams.get("scope")) ?? undefined;
  const archivedParam = request.nextUrl.searchParams.get("archived");
  if (archivedParam === "0" || archivedParam === "false") {
    // Hide archived (closed) when explicitly requested, otherwise show all.
  }
  const exams = await fetchExams({
    kinds,
    scope,
    categoryId,
    chapterId,
    courseId,
  });
  return NextResponse.json(
    { exams },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** Create or update an exam (including its answer key). */
export async function POST(request: NextRequest) {
  const admin = await requireAnyPermission(request, ["manageExams", "managePublicExam"]);
  if (!admin) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.id !== "string") {
    return NextResponse.json(
      { error: "Exam id and title are required." },
      { status: 400 },
    );
  }
  try {
    const exam = await saveExam(body, admin.uid);
    await logAdminAction(admin, "exam.save", `id=${exam.id}`, request);
    return NextResponse.json({ exam });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to save the exam.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/** Change display order: { order: [id, …] }. */
export async function PUT(request: NextRequest) {
  const admin = await requireAnyPermission(request, ["manageExams", "managePublicExam"]);
  if (!admin) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as
    | { order?: unknown }
    | null;
  if (
    !body ||
    !Array.isArray(body.order) ||
    !body.order.every((item) => typeof item === "string" && item.length > 0)
  ) {
    return NextResponse.json(
      { error: "Invalid request body — expected { order: [id, …] }." },
      { status: 400 },
    );
  }
  await reorderExams(body.order as string[]);
  await logAdminAction(admin, "exam.update", "reorder", request);
  const exams = await fetchExams();
  return NextResponse.json({ exams });
}

/** Quick publish/unpublish/close: { id, status }. */
export async function PATCH(request: NextRequest) {
  const admin = await requireAnyPermission(request, ["manageExams", "managePublicExam"]);
  if (!admin) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.id !== "string" || !body.id) {
    return NextResponse.json({ error: "Missing exam id." }, { status: 400 });
  }
  const status = String(body.status);
  if (!["draft", "published", "closed"].includes(status)) {
    return NextResponse.json({ error: "Invalid status." }, { status: 400 });
  }
  try {
    await setExamStatus(body.id, status as ExamStatus);
    await logAdminAction(admin, "exam.status", `id=${body.id} status=${status}`, request);
    const exams = await fetchExams();
    return NextResponse.json({ exams });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to update the exam.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest) {
  const admin = await requireAnyPermission(request, ["manageExams", "managePublicExam"]);
  if (!admin) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as { id?: unknown } | null;
  if (typeof body?.id !== "string" || !body.id) {
    return NextResponse.json({ error: "Missing exam id." }, { status: 400 });
  }
  try {
    await deleteExam(body.id);
    await logAdminAction(admin, "exam.delete", `id=${body.id}`, request);
    const exams = await fetchExams();
    return NextResponse.json({ exams });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to delete the exam.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
