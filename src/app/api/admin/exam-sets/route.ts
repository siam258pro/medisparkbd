import { NextRequest, NextResponse } from "next/server";
import { requireAnyPermission } from "@/lib/admin";
import {
  SYNC_SETS,
  SYNC_TOPICS,
  checkSetDisjoint,
  difficultyWarning,
  ensureExamSets,
  fetchMasterSet,
  fetchTranslations,
  masterRowToOptions,
  correctIndexToLetter,
  validateSet,
} from "@/lib/exam-autosync";

export const dynamic = "force-dynamic";

/**
 * GET ?examId=...&set=A|B&lang=bn|en
 * bn → Bangla MASTER rows. en → auto translations projected onto the SAME
 * question IDs, order, topic, correct_option. Never independent records.
 */
export async function GET(request: NextRequest) {
  const admin = await requireAnyPermission(request, ["manageExams", "managePublicExam"]);
  if (!admin) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const examId = (request.nextUrl.searchParams.get("examId") ?? "").trim();
  const set = (request.nextUrl.searchParams.get("set") ?? "A").trim().toUpperCase() as "A" | "B";
  const lang = (request.nextUrl.searchParams.get("lang") ?? "bn").trim().toLowerCase();
  if (!examId) return NextResponse.json({ error: "Missing exam id." }, { status: 400 });
  if (set !== "A" && set !== "B") return NextResponse.json({ error: "Invalid set." }, { status: 400 });
  if (lang !== "bn" && lang !== "en") return NextResponse.json({ error: "Invalid language." }, { status: 400 });
  try {
    await ensureExamSets(examId);
    const masters = await fetchMasterSet(examId, set);
    if (lang === "bn") {
      return NextResponse.json({
        lang: "bn",
        set,
        master: true,
        topics: SYNC_TOPICS,
        questions: masters.map((m, i) => ({
          id: m.id,
          questionUid: m.question_uid,
          order: i + 1,
          sortOrder: m.sort_order,
          set,
          topic: m.topic,
          subject: m.bank_subject,
          question: m.question,
          options: masterRowToOptions(m),
          correctOption: correctIndexToLetter(m.correct_index),
          difficulty: m.difficulty,
          explanation: m.explanation,
          marks: Number(m.marks) || 1,
        })),
      }, { headers: { "Cache-Control": "no-store" } });
    }
    const translations = await fetchTranslations(examId, set);
    return NextResponse.json({
      lang: "en",
      set,
      master: false,
      notice: "Automatically translated from Bangla Master",
      questions: masters.map((m, i) => {
        const t = translations.get(Number(m.id));
        return {
          id: m.id,
          questionUid: m.question_uid,
          order: i + 1,
          sortOrder: m.sort_order,
          set,
          topic: m.topic,
          // Same identity/order/topic/answer — only language changes.
          question: t?.question_text ?? null,
          options: t ? [t.option_a, t.option_b, t.option_c, t.option_d] : [null, null, null, null],
          correctOption: correctIndexToLetter(m.correct_index),
          difficulty: m.difficulty,
          explanation: t?.explanation ?? null,
          translationStatus: t?.translation_status ?? "pending",
          autoTranslated: true,
        };
      }),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed." }, { status: 500 });
  }
}

/**
 * GET ?examId=...&view=validation — publish gate for both sets + disjoint +
 * difficulty balance. Used by the Admin UI before publishing English sets.
 */
export async function POST(request: NextRequest) {
  const admin = await requireAnyPermission(request, ["manageExams", "managePublicExam"]);
  if (!admin) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { examId?: string } | null;
  const examId = String(body?.examId ?? "").trim();
  if (!examId) return NextResponse.json({ error: "Missing exam id." }, { status: 400 });
  try {
    await ensureExamSets(examId);
    const [validA, validB, disjoint] = await Promise.all([
      validateSet(examId, "A"),
      validateSet(examId, "B"),
      checkSetDisjoint(examId),
    ]);
    const warn = difficultyWarning(validA.difficulty, validB.difficulty);
    const englishPublishable = validA.publishable && validB.publishable && disjoint.disjoint;
    return NextResponse.json({
      sets: SYNC_SETS,
      validation: { A: validA, B: validB },
      disjoint,
      difficultyWarning: warn,
      englishPublishable,
      message: englishPublishable
        ? "English sets match the Bangla master sets."
        : "English Set cannot be published because the question structure does not match the Bangla master set.",
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed." }, { status: 500 });
  }
}
