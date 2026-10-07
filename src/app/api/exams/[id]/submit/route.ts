import { NextRequest, NextResponse } from "next/server";
import { getFirebaseUser } from "@/lib/auth-api";
import { submitExamAttempt } from "@/lib/exam-taking";

export const dynamic = "force-dynamic";

type SubmitBody = { answers?: Record<string, unknown>; token?: unknown };

/** POST /api/exams/[id]/submit — grade answers and store the result. */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const user = await getFirebaseUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as SubmitBody | null;
  if (!body || typeof body.answers !== "object" || body.answers === null || Array.isArray(body.answers)) {
    return NextResponse.json({ error: "Missing answers." }, { status: 400 });
  }

  if (typeof body.token !== "string" || !body.token) {
    return NextResponse.json({ error: "Missing attempt token. Resume the exam and retry." }, { status: 400 });
  }

  // Keep only valid selections: question IDs as numeric-string keys, and
  // non-negative integer option indexes. Values may arrive as numbers,
  // numeric strings or A/B/C/D letters — all are normalized; malformed
  // entries are dropped (never defaulted to 0/"A").
  const { normalizeStoredAnswerIndex } = await import("@/lib/paste-mcq-parser");
  const answers: Record<string, number> = {};
  for (const [key, value] of Object.entries(body.answers)) {
    if (!/^\d+$/.test(key)) continue;
    const normalized = normalizeStoredAnswerIndex(value);
    if (normalized !== null) answers[key] = normalized;
  }

  const { id } = await context.params;
  let outcome;
  try {
    outcome = await submitExamAttempt(
      id,
      user.uid,
      user.name || user.email || "Student",
      answers,
      body.token,
    );
  } catch {
    return NextResponse.json(
      { error: "Could not save your result. Please retry; your attempt and saved answers are retained.", transient: true },
      { status: 503 },
    );
  }
  if (!outcome) {
    return NextResponse.json(
      { error: "Exam not found or not available." },
      { status: 404 },
    );
  }

  return NextResponse.json(outcome);
}
