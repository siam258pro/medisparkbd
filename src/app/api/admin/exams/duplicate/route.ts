import { NextRequest, NextResponse } from "next/server";
import { requireAnyPermission } from "@/lib/admin";
import { logAdminAction } from "@/lib/administration";
import { duplicateExam } from "@/lib/exams-admin";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const admin = await requireAnyPermission(request, ["manageExams", "managePublicExam"]);
  if (!admin) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { id?: unknown; requestId?: unknown } | null;
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  if (!id) return NextResponse.json({ error: "Missing exam id." }, { status: 400 });
  const requestId = typeof body?.requestId === "string" ? body.requestId.trim() : "";
  if (requestId && !/^[A-Za-z0-9._:-]{1,100}$/.test(requestId)) {
    return NextResponse.json({ error: "Invalid request id." }, { status: 400 });
  }
  try {
    const exam = await duplicateExam(id, admin.uid, requestId || undefined);
    let warning: string | undefined;
    try {
      await logAdminAction(admin, "exam.duplicate", `id=${id} -> ${exam.id}`, request);
    } catch (error) {
      // The copy is already committed. Reporting failure here invites a retry
      // that creates another exam; keep the successful mutation authoritative.
      console.error("Failed to audit committed exam duplicate", { sourceId: id, examId: exam.id, error });
      warning = "Exam duplicated, but the admin audit log could not be saved.";
    }
    return NextResponse.json({ exam, ...(warning ? { warning } : {}) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to duplicate exam.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
