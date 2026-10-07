import { NextRequest, NextResponse } from "next/server";
import { requirePermission, requireAnyPermission } from "@/lib/admin";
import { logAdminAction } from "@/lib/administration";
import {
  attachBankQuestion,
  deleteQuestion,
  duplicateQuestion,
  fetchQuestions,
  reorderQuestions,
  saveQuestion,
  saveQuestionsBulk,
} from "@/lib/exams-admin";

export const dynamic = "force-dynamic";

/** ?examId=... (or examId=bank for bank-only) & ?subject=... & ?version=bangla|english & ?set=A|B */
export async function GET(request: NextRequest) {
  const admin = await requireAnyPermission(request, ["manageExams", "managePublicExam"]);
  if (!admin) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const { normalizeSet, normalizeVersion } = await import("@/lib/exam-variants");
  const version = normalizeVersion(params.get("version"));
  const set = normalizeSet(params.get("set"));
  let questions: Awaited<ReturnType<typeof fetchQuestions>>;
  try {
    // A failed read must surface as an error, not an empty "successful" editor.
    questions = await fetchQuestions({
      examId: params.get("examId") ?? undefined,
      subject: params.get("subject") ?? undefined,
    }, { throwOnError: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load questions.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
  // Version/Set view: overlay the authored variant content on the permanent
  // slots so each language/set is managed separately (same IDs, same order).
  if (version && set && (params.get("examId") ?? "") !== "bank") {
    try {
      const { fetchVariantMap, overlayVariantOntoBase } = await import("@/lib/exam-variants");
      const examId = String(params.get("examId") ?? "");
      const variants = await fetchVariantMap(examId, false, { lang: version, setLabel: set });
      const merged = questions.map((q, index) => {
        if (q.id === null) return { ...q, order: index + 1, hasVariant: false };
        // Corrupt variant options → pure base + hasVariant:false (never mixed).
        // Marks resolved via resolveMarks inside the overlay helper.
        const overlaid = overlayVariantOntoBase(
          q as unknown as Record<string, unknown>,
          variants.get(`${Number(q.id)}:${version}:${set}`),
        );
        return { ...overlaid, order: index + 1 };
      });
      return NextResponse.json(
        { questions: merged },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch {
      // Fall through to base questions on error.
    }
  }
  return NextResponse.json(
    { questions },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: NextRequest) {
  const admin = await requireAnyPermission(request, ["manageExams", "managePublicExam"]);
  if (!admin) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  // Variant save (Language Version + Set A/B): { examId, version, set, ...question fields }
  // The permanent slot (exam_questions.id) stays the same — only the
  // version/set cell content is written. No auto-translation is performed.
  const { normalizeSet, normalizeVersion } = await import("@/lib/exam-variants");
  const bodyVersion = normalizeVersion((body as Record<string, unknown>).version);
  const bodySet = normalizeSet((body as Record<string, unknown>).set);
  // Invalid version/set must never fall through to the base save.
  const hasVariantIntent = "version" in body || "set" in body;
  if (hasVariantIntent && !(bodyVersion && bodySet)) {
    return NextResponse.json({ error: "Invalid version or set. Expected version=bangla|english and set=A|B." }, { status: 400 });
  }
  if (bodyVersion && bodySet) {
    try {
      const { query } = await import("@/lib/mysql");
      const { saveVariant } = await import("@/lib/exam-variants");
      const { exec } = await import("@/lib/mysql");
      const asString = (v: unknown): string => (typeof v === "string" ? v : "");
      const str = (v: unknown, fb = ""): string => (typeof v === "string" ? v : fb);
      const num = (v: unknown, fb = 0): number => {
        // Empty strings must fall back — Number("") is 0, which would
        // silently store answer A for a missing correctIndex.
        if (typeof v === "string" && v.trim() === "") return fb;
        const n = Number(v);
        return Number.isFinite(n) ? n : fb;
      };
      // Resolve the permanent slot id for (examId, 1-based order), creating
      // the base placeholder slot when the admin increased Total Questions
      // but the slot row does not exist yet. Variants never create new IDs.
      const resolveOrCreateSlot = async (examId: string, order: number): Promise<number> => {
        const found = await query<{ id: number }[]>(
          `SELECT id FROM exam_questions WHERE exam_id = ? AND sort_order = ? LIMIT 1`,
          [examId, order],
        );
        if (found[0]) return Number(found[0].id);
        let marksPerSlot = 1;
        let maxOrder = 0;
        try {
          const examRows = await query<{ marks_per_question: string | number | null; question_count: string | number | null }[]>(
            `SELECT marks_per_question, question_count FROM exams WHERE id = ? LIMIT 1`,
            [examId],
          );
          const raw = Number(examRows[0]?.marks_per_question ?? 1);
          if (Number.isFinite(raw) && raw > 0) marksPerSlot = raw;
          // Never grow beyond the configured Total Questions.
          const rawCount = Number(examRows[0]?.question_count ?? 0);
          if (Number.isFinite(rawCount) && rawCount > 0) maxOrder = Math.floor(rawCount);
        } catch {}
        if (maxOrder > 0 && order > maxOrder) {
          throw new Error(`Exceeds configured total of ${maxOrder} questions — remove extras or increase Total Questions.`);
        }
        // Race-safe: concurrent creators may insert the same slot. With a
        // unique key on (exam_id, sort_order) INSERT IGNORE turns the loser
        // into a no-op; without it the catch + re-SELECT still recovers.
        try {
          await exec(`ALTER TABLE exam_questions ADD UNIQUE KEY uq_exam_slot (exam_id, sort_order)`, []).catch(() => {});
        } catch {}
        try {
          const inserted = await exec(
            `INSERT IGNORE INTO exam_questions (exam_id, bank_subject, question, question_image, options, correct_index, explanation, marks, sort_order, is_active)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [examId, "", "", null, JSON.stringify(["", "", "", ""]), null, null, marksPerSlot, order, 1],
          );
          const insertId = (inserted as unknown as { insertId?: number })?.insertId;
          if (insertId) return Number(insertId);
        } catch {}
        const retry = await query<{ id: number }[]>(
          `SELECT id FROM exam_questions WHERE exam_id = ? AND sort_order = ? LIMIT 1`,
          [examId, order],
        );
        return Number(retry[0]?.id ?? 0);
      };
      // Bulk variant save: { examId, version, set, questions: [...] }
      // All-or-nothing: the whole batch is validated before any write, and
      // slot creation plus every variant cell commit (or roll back) together.
      if (Array.isArray((body as Record<string, unknown>).questions)) {
        const examId = String((body as Record<string, unknown>).examId ?? "").trim();
        const items = (body as Record<string, unknown>).questions as Record<string, unknown>[];
        if (!examId) return NextResponse.json({ error: "Missing exam id." }, { status: 400 });
        if (items.length === 0) return NextResponse.json({ error: "No questions to save." }, { status: 400 });
        if (items.length > 200) return NextResponse.json({ error: "Too many questions in one batch (max 200)." }, { status: 400 });
        type Prepared = {
          idx: number; explicitId: number; order: number; text: string; options: string[];
          correctIndex: number; explanation: string | null; marks: number; questionImage: string | null;
        };
        const errors: { index: number; error: string }[] = [];
        const prepared: Prepared[] = [];
        const seenIds = new Set<number>();
        const seenOrders = new Set<number>();
        for (let idx = 0; idx < items.length; idx += 1) {
          const item = items[idx] as Record<string, unknown>;
          const explicitId = num(item?.id, 0);
          const hasExplicitId = Number.isInteger(explicitId) && explicitId > 0;
          const order = num(item?.order, idx + 1);
          if (hasExplicitId) {
            if (seenIds.has(explicitId)) {
              errors.push({ index: idx, error: "Duplicate question id in this batch." });
              continue;
            }
            seenIds.add(explicitId);
          } else {
            if (!Number.isInteger(order) || order <= 0) {
              errors.push({ index: idx, error: "Missing question slot." });
              continue;
            }
            if (seenOrders.has(order)) {
              errors.push({ index: idx, error: "Duplicate slot order in this batch." });
              continue;
            }
            seenOrders.add(order);
          }
          const qImage = str(item?.questionImage) || str(item?.question_image) || null;
          const text = str(item?.question);
          if (text.trim().length < 3 && !qImage) {
            errors.push({ index: idx, error: "Question text too short." });
            continue;
          }
          const options = Array.isArray(item?.options) ? (item.options as unknown[]).map((o) => String(o)) : [];
          if (options.length < 2 || options.some((o) => o.length === 0)) {
            errors.push({ index: idx, error: "At least 2 non-empty options required." });
            continue;
          }
          const correctIndex = num(item?.correctIndex, -1);
          if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= options.length) {
            errors.push({ index: idx, error: "Invalid correctIndex." });
            continue;
          }
          prepared.push({
            idx, explicitId: hasExplicitId ? explicitId : 0, order, text, options, correctIndex,
            explanation: str(item?.explanation) || null, marks: num(item?.marks, 1) || 1, questionImage: qImage,
          });
        }
        if (errors.length > 0) {
          return NextResponse.json({ error: "Some questions are invalid. Nothing was saved.", errors }, { status: 400 });
        }
        // Snapshot the answer key BEFORE writing — a changed key triggers
        // automatic result recalculation after the save (single source of truth).
        let keyBefore: import("@/lib/exam-recalculation").AnswerKeySnapshot | null = null;
        try {
          const { snapshotAnswerKey } = await import("@/lib/exam-recalculation");
          keyBefore = await snapshotAnswerKey(examId);
        } catch {}
        const { withTransaction } = await import("@/lib/mysql");
        const { saveVariantInTransaction, ensureVariantTables } = await import("@/lib/exam-variants");
        class BatchRejected extends Error {
          details: { index: number; error: string }[];
          constructor(message: string, details: { index: number; error: string }[]) {
            super(message);
            this.details = details;
          }
        }
        let savedIds: number[] = [];
        try {
          await ensureVariantTables();
          savedIds = await withTransaction(async (connection) => {
            const run = async <T,>(sql: string, params: unknown[] = []): Promise<T> => {
              const [rows] = await connection.query(sql, params);
              return rows as T;
            };
            // The exam row lock serializes concurrent uploads, so a missing
            // slot is created exactly once without relying on a unique key.
            const examRows = await run<{ id: string; marks_per_question: string | number | null; question_count: string | number | null }[]>(
              `SELECT id, marks_per_question, question_count FROM exams WHERE id = ? FOR UPDATE`, [examId],
            );
            if (!examRows[0]) throw new BatchRejected("Exam not found.", []);
            const rawMarks = Number(examRows[0].marks_per_question ?? 1);
            const marksPerSlot = Number.isFinite(rawMarks) && rawMarks > 0 ? rawMarks : 1;
            // Slots must never grow beyond the configured Total Questions —
            // extra detected rows are rejected instead of auto-created.
            const rawCount = Number(examRows[0].question_count ?? 0);
            const maxOrder = Number.isFinite(rawCount) && rawCount > 0 ? Math.floor(rawCount) : 0;
            const slotRows = await run<{ id: number; sort_order: number }[]>(
              `SELECT id, sort_order FROM exam_questions WHERE exam_id = ? ORDER BY sort_order ASC, id ASC FOR UPDATE`, [examId],
            );
            const byOrder = new Map(slotRows.map((r) => [Number(r.sort_order), Number(r.id)]));
            const examSlotIds = new Set(slotRows.map((r) => Number(r.id)));
            const slotErrors: { index: number; error: string }[] = [];
            const resolved = new Set<number>();
            const targets: { entry: Prepared; questionId: number }[] = [];
            for (const entry of prepared) {
              let questionId = entry.explicitId;
              if (questionId && !examSlotIds.has(questionId)) {
                slotErrors.push({ index: entry.idx, error: "Question does not belong to this exam." });
                continue;
              }
              if (!questionId) questionId = byOrder.get(entry.order) ?? 0;
              if (!questionId && maxOrder > 0 && entry.order > maxOrder) {
                slotErrors.push({ index: entry.idx, error: `Exceeds configured total of ${maxOrder} questions — remove extras or increase Total Questions.` });
                continue;
              }
              if (questionId && resolved.has(questionId)) {
                slotErrors.push({ index: entry.idx, error: "Two questions resolve to the same slot." });
                continue;
              }
              if (questionId) resolved.add(questionId);
              targets.push({ entry, questionId });
            }
            if (slotErrors.length > 0) throw new BatchRejected("Some questions are invalid. Nothing was saved.", slotErrors);
            for (const target of targets) {
              if (target.questionId) continue;
              const [inserted] = await connection.query(
                `INSERT INTO exam_questions (exam_id, bank_subject, question, question_image, options, correct_index, explanation, marks, sort_order, is_active)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [examId, "", "", null, JSON.stringify(["", "", "", ""]), null, null, marksPerSlot, target.entry.order, 1],
              );
              const insertId = Number((inserted as unknown as { insertId?: number })?.insertId);
              if (!Number.isSafeInteger(insertId) || insertId <= 0) throw new Error("Database did not return the new question slot id.");
              target.questionId = insertId;
            }
            for (const { entry, questionId } of targets) {
              await saveVariantInTransaction(connection, {
                questionId,
                version: bodyVersion,
                set: bodySet,
                question: entry.text,
                options: entry.options,
                correctIndex: entry.correctIndex,
                explanation: entry.explanation,
                marks: entry.marks,
                questionImage: entry.questionImage,
              });
            }
            return targets.map((target) => target.questionId);
          });
        } catch (error) {
          if (error instanceof BatchRejected) {
            return NextResponse.json({ error: error.message, ...(error.details.length > 0 ? { errors: error.details } : {}) }, { status: 400 });
          }
          const message = error instanceof Error ? error.message : "Failed to save questions.";
          return NextResponse.json({ error: message }, { status: 400 });
        }
        const saved = savedIds.length;
        await logAdminAction(admin, "question.variant_bulk_save", `exam=${examId} ${bodyVersion}/${bodySet} count=${saved}`, request);
        // Answer-key correction → recalculate affected results from answers + latest key.
        let recalculated = 0;
        try {
          const { recalculateIfAnswerKeyChanged } = await import("@/lib/exam-recalculation");
          const recalc = await recalculateIfAnswerKeyChanged(examId, keyBefore);
          recalculated = recalc.recalculated;
          if (recalc.changed) {
            await logAdminAction(admin, "question.recalculate", `exam=${examId} results=${recalculated}`, request);
          }
        } catch {}
        return NextResponse.json({ ok: true, saved, savedIds, ...(recalculated > 0 ? { recalculated } : {}) });
      }
      // Single variant save.
      const examId = asString((body as Record<string, unknown>).examId).trim();
      let questionId = num((body as Record<string, unknown>).id, 0);
      if ((!Number.isInteger(questionId) || questionId <= 0) && examId) {
        const order = num((body as Record<string, unknown>).order, 0);
        if (Number.isInteger(order) && order > 0) {
          questionId = await resolveOrCreateSlot(examId, order);
        }
      }
      if (!Number.isInteger(questionId) || questionId <= 0) {
        return NextResponse.json({ error: "Missing question id (save the slot first)." }, { status: 400 });
      }
      // The slot must belong to this exam (permanent ID guard).
      if (examId) {
        const owner = await query<{ exam_id: string | null }[]>(
          `SELECT exam_id FROM exam_questions WHERE id = ? LIMIT 1`,
          [questionId],
        );
        if (!owner[0] || owner[0].exam_id !== examId) {
          return NextResponse.json({ error: "Question does not belong to this exam." }, { status: 400 });
        }
      }
      // Snapshot the answer key BEFORE writing — a changed key triggers
      // automatic result recalculation after the save.
      let keyBefore: import("@/lib/exam-recalculation").AnswerKeySnapshot | null = null;
      try {
        if (examId) {
          const { snapshotAnswerKey } = await import("@/lib/exam-recalculation");
          keyBefore = await snapshotAnswerKey(examId);
        }
      } catch {}
      const qImage = str((body as Record<string, unknown>).questionImage) || str((body as Record<string, unknown>).question_image) || null;
      const text = str((body as Record<string, unknown>).question);
      const options = Array.isArray((body as Record<string, unknown>).options)
        ? ((body as Record<string, unknown>).options as unknown[]).map((o) => String(o))
        : [];
      await saveVariant({
        questionId,
        version: bodyVersion,
        set: bodySet,
        question: text,
        options,
        correctIndex: num((body as Record<string, unknown>).correctIndex, -1),
        explanation: str((body as Record<string, unknown>).explanation) || null,
        marks: num((body as Record<string, unknown>).marks, 1) || 1,
        questionImage: qImage,
      });
      await logAdminAction(admin, "question.variant_save", `q=${questionId} ${bodyVersion}/${bodySet}`, request);
      // Answer-key correction → recalculate affected results from answers + latest key.
      let recalculated = 0;
      try {
        if (examId) {
          const { recalculateIfAnswerKeyChanged } = await import("@/lib/exam-recalculation");
          const recalc = await recalculateIfAnswerKeyChanged(examId, keyBefore);
          recalculated = recalc.recalculated;
          if (recalc.changed) {
            await logAdminAction(admin, "question.recalculate", `exam=${examId} results=${recalculated}`, request);
          }
        }
      } catch {}
      return NextResponse.json({ ok: true, hasVariant: true, id: questionId, ...(recalculated > 0 ? { recalculated } : {}) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save the version/set content.";
      return NextResponse.json({ error: message }, { status: 400 });
    }
  }
  // Duplicate a question within same exam: { duplicateId: number }
  if (body.duplicateId !== undefined) {
    const dupId = Number(body.duplicateId);
    if (!Number.isInteger(dupId) || dupId <= 0) {
      return NextResponse.json({ error: "Invalid duplicateId." }, { status: 400 });
    }
    try {
      const questions = await duplicateQuestion(dupId);
      await logAdminAction(admin, "question.duplicate", `id=${dupId}`, request);
      return NextResponse.json({ questions });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to duplicate question.";
      return NextResponse.json({ error: message }, { status: 400 });
    }
  }
  // Bulk save: { examId, questions: [...] } — saves only changed questions in one request (fast, 1 roundtrip)
  if (Array.isArray((body as Record<string, unknown>).questions)) {
    const examId = String((body as Record<string, unknown>).examId ?? "").trim();
    const items = (body as Record<string, unknown>).questions as Record<string, unknown>[];
    // Snapshot the answer key BEFORE writing — a changed key triggers
    // automatic result recalculation after the save.
    let keyBefore: import("@/lib/exam-recalculation").AnswerKeySnapshot | null = null;
    try {
      if (examId) {
        const { snapshotAnswerKey } = await import("@/lib/exam-recalculation");
        keyBefore = await snapshotAnswerKey(examId);
      }
    } catch {}
    try {
      const result = await saveQuestionsBulk(examId, items);
      await logAdminAction(admin, "question.bulk_save", `exam=${examId} count=${items.length}`, request);
      // Answer-key correction → recalculate affected results from answers + latest key.
      let recalculated = 0;
      try {
        if (examId) {
          const { recalculateIfAnswerKeyChanged } = await import("@/lib/exam-recalculation");
          const recalc = await recalculateIfAnswerKeyChanged(examId, keyBefore);
          recalculated = recalc.recalculated;
          if (recalc.changed) {
            await logAdminAction(admin, "question.recalculate", `exam=${examId} results=${recalculated}`, request);
          }
        }
      } catch {}
      return NextResponse.json({ ok: true, questions: result.questions, savedIds: result.savedIds, ...(recalculated > 0 ? { recalculated } : {}) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save questions.";
      return NextResponse.json({ error: message }, { status: 400 });
    }
  }
  // Single base save — may also MOVE a question between exams, so snapshot
  // both the current and the target exam.
  let singleBefore = new Map<string, import("@/lib/exam-recalculation").AnswerKeySnapshot>();
  try {
    const targetExam = typeof body.examId === "string" ? body.examId.trim() : "";
    const movingId = Number((body as Record<string, unknown>).id);
    const examsToWatch = new Set<string>();
    if (targetExam) examsToWatch.add(targetExam);
    if (Number.isInteger(movingId) && movingId > 0) {
      try {
        const { query: watchQuery } = await import("@/lib/mysql");
        const owner = await watchQuery<{ exam_id: string | null }[]>(
          `SELECT exam_id FROM exam_questions WHERE id = ? LIMIT 1`,
          [movingId],
        );
        if (owner[0]?.exam_id) examsToWatch.add(owner[0].exam_id);
      } catch {}
    }
    if (examsToWatch.size > 0) {
      const { snapshotAnswerKey } = await import("@/lib/exam-recalculation");
      for (const watchId of examsToWatch) {
        try {
          const snap = await snapshotAnswerKey(watchId);
          if (snap) singleBefore.set(watchId, snap);
        } catch {}
      }
    }
  } catch {}
  try {
    const result = await saveQuestion(body);
    await logAdminAction(admin, "question.save", String(body.subject ?? ""), request);
    // Answer-key correction → recalculate affected results from answers + latest key.
    let recalculated = 0;
    try {
      const { recalculateIfAnswerKeyChanged } = await import("@/lib/exam-recalculation");
      for (const [watchId, snap] of singleBefore) {
        try {
          const recalc = await recalculateIfAnswerKeyChanged(watchId, snap);
          recalculated += recalc.recalculated;
          if (recalc.changed) {
            await logAdminAction(admin, "question.recalculate", `exam=${watchId} results=${recalc.recalculated}`, request);
          }
        } catch {}
      }
    } catch {}
    // Return fresh exam questions so client can sync without a second fetch when possible
    return NextResponse.json({ ok: true, questions: result, ...(recalculated > 0 ? { recalculated } : {}) });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to save the question.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function PUT(request: NextRequest) {
  const admin = await requireAnyPermission(request, ["manageExams", "managePublicExam"]);
  if (!admin) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { examId?: unknown; order?: unknown } | null;
  const examIdRaw = typeof body?.examId === "string" ? body.examId.trim() : "";
  const examId = examIdRaw === "bank" ? null : examIdRaw || null;
  // Allow null for bank reorder as well (examId may be null or omitted)
  if (!Array.isArray(body?.order)) {
    return NextResponse.json({ error: "Invalid order payload." }, { status: 400 });
  }
  const ids = (body.order as unknown[]).map(Number);
  if (ids.length === 0 || ids.some((id) => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length) {
    return NextResponse.json({ error: "Invalid or duplicate question ids." }, { status: 400 });
  }
  try {
    const questions = await reorderQuestions(examId, ids);
    await logAdminAction(admin, "question.reorder", `exam=${examId ?? "bank"} count=${ids.length}`, request);
    return NextResponse.json({ questions });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to reorder.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/** PATCH — attach a copy of a bank question to an exam: { id, examId }. */
export async function PATCH(request: NextRequest) {
  const admin = await requireAnyPermission(request, ["manageExams", "managePublicExam"]);
  if (!admin) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as { id?: unknown; examId?: unknown } | null;
  const id = Number(body?.id);
  const examId = typeof body?.examId === "string" ? body.examId : "";
  if (!Number.isSafeInteger(id) || id <= 0 || !examId) {
    return NextResponse.json({ error: "Missing question id or exam id." }, { status: 400 });
  }
  try {
    const questions = await attachBankQuestion(id, examId);
    await logAdminAction(admin, "question.attach", `question=${id} exam=${examId}`, request);
    return NextResponse.json({ questions });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to attach the question.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest) {
  const admin = await requireAnyPermission(request, ["manageExams", "managePublicExam"]);
  if (!admin) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as {
    id?: unknown;
    examId?: unknown;
    version?: unknown;
    set?: unknown;
    clearAll?: unknown;
  } | null;
  const { normalizeSet, normalizeVersion } = await import("@/lib/exam-variants");
  const version = normalizeVersion(body?.version);
  const set = normalizeSet(body?.set);
  // Bulk clear: delete every variant cell for (examId, version, set). Base slots stay.
  if (body?.clearAll === true) {
    const examId = typeof body?.examId === "string" ? body.examId.trim() : "";
    if (!examId || !version || !set) {
      return NextResponse.json({ error: "Missing exam id, version or set." }, { status: 400 });
    }
    try {
      const { clearVariantsForExam } = await import("@/lib/exam-variants");
      const cleared = await clearVariantsForExam(examId, version, set);
      await logAdminAction(admin, "question.variant_clear", `exam=${examId} ${version}/${set} cleared=${cleared}`, request);
      try {
        const { snapshotAnswerKey } = await import("@/lib/exam-recalculation");
        const before = await snapshotAnswerKey(examId);
        const { recalculateIfAnswerKeyChanged } = await import("@/lib/exam-recalculation");
        await recalculateIfAnswerKeyChanged(examId, before);
      } catch {}
      return NextResponse.json({ ok: true, cleared });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to clear questions.";
      return NextResponse.json({ error: message }, { status: 400 });
    }
  }
  const id = Number(body?.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Missing question id." }, { status: 400 });
  }
  // Single variant-cell delete: { id, version, set } clears only that workspace cell.
  if (version && set) {
    try {
      const { deleteVariant } = await import("@/lib/exam-variants");
      await deleteVariant(id, version, set);
      await logAdminAction(admin, "question.variant_delete", `id=${id} ${version}/${set}`, request);
      return NextResponse.json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to delete the question.";
      return NextResponse.json({ error: message }, { status: 400 });
    }
  }
  try {
    await deleteQuestion(id);
    await logAdminAction(admin, "question.delete", `id=${id}`, request);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to delete the question.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
