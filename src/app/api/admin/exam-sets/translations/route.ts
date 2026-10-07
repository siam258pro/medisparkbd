import { NextRequest, NextResponse } from "next/server";
import { requireAnyPermission } from "@/lib/admin";
import { exec } from "@/lib/mysql";
import { ensureAutoSyncTables, syncTranslationFor } from "@/lib/exam-autosync";

export const dynamic = "force-dynamic";

/**
 * English translation maintenance.
 * - GET ?questionId=.. → cached translation (read-only projection).
 * - POST { questionId } → regenerate from Bangla master (Regenerate button).
 * - PATCH { questionId, fields } → manual wording improvement. Never touches
 *   the Bangla master; marks status MANUALLY EDITED (manually_edited).
 */
export async function GET(request: NextRequest) {
  const admin = await requireAnyPermission(request, ["manageExams", "managePublicExam"]);
  if (!admin) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const questionId = Number(request.nextUrl.searchParams.get("questionId"));
  if (!Number.isSafeInteger(questionId) || questionId <= 0) return NextResponse.json({ error: "Missing questionId." }, { status: 400 });
  try {
    await ensureAutoSyncTables();
    const { query } = await import("@/lib/mysql");
    const rows = await query<Record<string, unknown>[]>(
      `SELECT question_id, question_text, option_a, option_b, option_c, option_d, explanation, translation_status, translated_at, updated_at
         FROM question_translations WHERE question_id = ? AND language = 'en' LIMIT 1`,
      [questionId],
    );
    return NextResponse.json({ translation: rows[0] ?? null }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const admin = await requireAnyPermission(request, ["manageExams", "managePublicExam"]);
  if (!admin) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { questionId?: number } | null;
  const questionId = Number(body?.questionId);
  if (!Number.isSafeInteger(questionId) || questionId <= 0) return NextResponse.json({ error: "Missing questionId." }, { status: 400 });
  try {
    await ensureAutoSyncTables();
    const status = await syncTranslationFor(questionId, true);
    if (status === "failed") return NextResponse.json({ error: "Translation regeneration failed.", status }, { status: 500 });
    return NextResponse.json({ ok: true, status });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed." }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const admin = await requireAnyPermission(request, ["manageExams", "managePublicExam"]);
  if (!admin) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const questionId = Number(body?.questionId);
  if (!Number.isSafeInteger(questionId) || questionId <= 0) return NextResponse.json({ error: "Missing questionId." }, { status: 400 });
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const key of ["question_text", "option_a", "option_b", "option_c", "option_d", "explanation"] as const) {
    if (body?.[key] !== undefined) {
      const v = body[key] === null ? null : String(body[key]);
      if (key !== "explanation" && (v === null || !v.trim())) {
        return NextResponse.json({ error: `${key} cannot be empty.` }, { status: 400 });
      }
      sets.push(`t.${key} = ?`);
      params.push(v);
    }
  }
  if (sets.length === 0) return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  try {
    await ensureAutoSyncTables();
    // Manual wording edit only — Bangla master is never touched here, and the
    // structural fields (order/answer/set/topic/ID) are not editable via this
    // route at all.
    params.push(questionId);
    const result = await exec(
      `UPDATE question_translations t JOIN exam_questions q ON q.id = t.question_id
          SET ${sets.join(", ")}, t.translation_status = 'manually_edited', t.translated_at = CURRENT_TIMESTAMP
        WHERE t.question_id = ? AND t.language = 'en' AND q.is_active = 1`,
      params,
    );
    if (!result.affectedRows) return NextResponse.json({ error: "Active translation not found; regenerate it first." }, { status: 404 });
    return NextResponse.json({ ok: true, translationStatus: "MANUALLY EDITED" });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed." }, { status: 500 });
  }
}
