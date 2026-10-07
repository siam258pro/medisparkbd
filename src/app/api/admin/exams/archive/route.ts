import { NextRequest, NextResponse } from "next/server";
import { requireAnyPermission } from "@/lib/admin";
import { logAdminAction } from "@/lib/administration";
import { archiveExam } from "@/lib/exams-admin";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const admin = await requireAnyPermission(request, ["manageExams", "managePublicExam"]);
  if (!admin) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { id?: unknown; archived?: unknown } | null;
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  if (!id) return NextResponse.json({ error: "Missing exam id." }, { status: 400 });
  if (typeof body?.archived !== "boolean") return NextResponse.json({ error: "archived must be a boolean." }, { status: 400 });
  const archived = body.archived;
  try {
    await archiveExam(id, archived);
    await logAdminAction(admin, "exam.archive", `id=${id} archived=${archived}`, request);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to archive exam.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
