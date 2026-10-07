import { NextRequest, NextResponse } from "next/server";
import { requireAnyPermission } from "@/lib/admin";
import { exec, query, withTransaction } from "@/lib/mysql";
import type { PoolConnection } from "mysql2/promise";
import {
  allocateQuestionUid,
  correctLetterToIndex,
  ensureAutoSyncTables,
  ensureExamSets,

  normalizeDifficulty,
  normalizeSyncSet,
  normalizeTopic,
  syncTranslationFor,
} from "@/lib/exam-autosync";

export const dynamic = "force-dynamic";

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

async function renumberSet(connection: PoolConnection, examId: string, set: string) {
  const [raw] = await connection.query(
    `SELECT id FROM exam_questions WHERE exam_id = ? AND set_label = ? AND is_active = 1
      ORDER BY sort_order ASC, id ASC FOR UPDATE`, [examId, set],
  );
  const rows = raw as { id: number }[];
  // Clear old positions first to avoid transient unique-slot collisions.
  await connection.query(`UPDATE exam_questions SET sort_order = NULL WHERE exam_id = ? AND set_label = ? AND is_active = 1`, [examId, set]);
  for (let i = 0; i < rows.length; i += 1) {
    await connection.query(`UPDATE exam_questions SET sort_order = ? WHERE id = ?`, [i + 1, rows[i].id]);
  }
}

/**
 * Bangla MASTER write API. Every mutation auto-syncs the English translation
 * (queued, non-blocking) and can never change English independently.
 * Actions: create | update | delete | reorder | move-set
 */
export async function POST(request: NextRequest) {
  const admin = await requireAnyPermission(request, ["manageExams", "managePublicExam"]);
  if (!admin) return bad("Unauthorized.", 401);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return bad("Invalid body.");
  const action = String(body.action ?? "create").toLowerCase();
  if (!["create", "update", "delete", "reorder", "move-set"].includes(action)) return bad("Invalid action.");
  const requestExamId = String(body.examId ?? "").trim();
  if (!requestExamId) return bad("examId is required.");
  try {
    await ensureAutoSyncTables();
    if (action === "reorder") {
      const examId = String(body.examId ?? "").trim();
      const set = normalizeSyncSet(body.set);
      const order = Array.isArray(body.order) ? body.order.map(Number) : [];
      if (!examId || !set || order.length === 0 || order.some((id) => !Number.isSafeInteger(id) || id <= 0)
        || new Set(order).size !== order.length) return bad("A complete, unique order of positive question IDs is required.");
      const reordered = await withTransaction(async (connection) => {
        const [raw] = await connection.query(
          `SELECT id FROM exam_questions WHERE exam_id = ? AND set_label = ? AND is_active = 1 FOR UPDATE`, [examId, set],
        );
        const rows = raw as { id: number }[];
        const ids = new Set(rows.map((row) => Number(row.id)));
        if (rows.length !== order.length || order.some((id) => !ids.has(id))) return false;
        await connection.query(`UPDATE exam_questions SET sort_order = NULL WHERE exam_id = ? AND set_label = ? AND is_active = 1`, [examId, set]);
        for (let i = 0; i < order.length; i += 1) {
          await connection.query(`UPDATE exam_questions SET sort_order = ? WHERE id = ? AND exam_id = ? AND set_label = ? AND is_active = 1`, [i + 1, order[i], examId, set]);
        }
        return true;
      });
      if (!reordered) return bad("order[] must contain every active question in this exam/set exactly once.");
      return NextResponse.json({ ok: true });
    }
    if (action === "delete") {
      const id = Number(body.id);
      const set = normalizeSyncSet(body.set);
      if (!Number.isSafeInteger(id) || id <= 0 || !set) return bad("id and set are required.");
      const deleted = await withTransaction(async (connection) => {
        const [result] = await connection.query(
          `UPDATE exam_questions SET is_active = 0, sort_order = NULL WHERE id = ? AND exam_id = ? AND set_label = ? AND is_active = 1`,
          [id, requestExamId, set],
        );
        if (!(result as { affectedRows: number }).affectedRows) return false;
        await renumberSet(connection, requestExamId, set);
        return true;
      });
      if (!deleted) return bad("Active question not found in this exam/set.", 404);
      return NextResponse.json({ ok: true });
    }
    if (action === "move-set") {
      const id = Number(body.id);
      const set = normalizeSyncSet(body.set);
      if (!Number.isSafeInteger(id) || id <= 0 || !set) return bad("id and set are required.");
      const moved = await withTransaction(async (connection) => {
        const [raw] = await connection.query(
          `SELECT set_label, sort_order FROM exam_questions WHERE id = ? AND exam_id = ? AND is_active = 1 FOR UPDATE`, [id, requestExamId],
        );
        const row = (raw as { set_label: string | null; sort_order: number }[])[0];
        if (!row || !row.set_label) return null;
        if (row.set_label === set) return row.sort_order;
        const [maxRows] = await connection.query(
          `SELECT MAX(sort_order) AS m FROM exam_questions WHERE exam_id = ? AND set_label = ? AND is_active = 1`, [requestExamId, set],
        );
        const nextOrder = (Number((maxRows as { m: number | null }[])[0]?.m) || 0) + 1;
        await connection.query(`UPDATE exam_questions SET set_label = ?, sort_order = ? WHERE id = ? AND exam_id = ? AND is_active = 1`, [set, nextOrder, id, requestExamId]);
        await renumberSet(connection, requestExamId, row.set_label);
        return nextOrder;
      });
      if (moved === null) return bad("Active question not found in this exam.", 404);
      return NextResponse.json({ ok: true, set, sortOrder: moved });
    }
    if (action === "update") {
      const id = Number(body.id);
      const set = normalizeSyncSet(body.set);
      if (!Number.isSafeInteger(id) || id <= 0 || !set) return bad("id and set are required.");
      const topic = body.topic !== undefined ? normalizeTopic(body.topic) : undefined;
      if (body.topic !== undefined && !topic) return bad("Invalid topic.");
      const difficulty = body.difficulty !== undefined
        ? (body.difficulty === null ? null : normalizeDifficulty(body.difficulty))
        : undefined;
      if (body.difficulty !== undefined && body.difficulty !== null && !difficulty) return bad("Invalid difficulty.");
      const correctLetter = body.correctOption !== undefined
        ? correctLetterToIndex(body.correctOption)
        : undefined;
      if (body.correctOption !== undefined && correctLetter === null) return bad("correctOption must be A/B/C/D.");
      const sets: string[] = [];
      const params: unknown[] = [];
      if (body.question !== undefined) {
        if (typeof body.question !== "string" || body.question.trim().length < 3) return bad("Question text is required (at least 3 characters).");
        sets.push(`question = ?`); params.push(body.question.trim());
      }
      if (body.options !== undefined) {
        const opts = Array.isArray(body.options) ? body.options : null;
        if (!opts || opts.length !== 4 || opts.some((o) => typeof o !== "string" || !o.trim())) return bad("Four non-empty options are required.");
        sets.push(`options = ?`); params.push(JSON.stringify(opts.slice(0, 4)));
      }
      if (correctLetter !== undefined) { sets.push(`correct_index = ?`); params.push(correctLetter); }
      if (topic !== undefined) { sets.push(`topic = ?`); params.push(topic); }
      if (difficulty !== undefined) { sets.push(`difficulty = ?`); params.push(difficulty); }
      if (body.explanation !== undefined) { sets.push(`explanation = ?`); params.push(body.explanation ? String(body.explanation) : null); }
      if (body.marks !== undefined) { sets.push(`marks = ?`); params.push(Number(body.marks) || 1); }
      if (body.subject !== undefined) { sets.push(`bank_subject = ?`); params.push(String(body.subject)); }
      if (sets.length === 0) return bad("Nothing to update.");
      params.push(id, requestExamId, set);
      const updated = await withTransaction(async (connection) => {
        const [result] = await connection.query(
          `UPDATE exam_questions SET ${sets.join(", ")} WHERE id = ? AND exam_id = ? AND set_label = ? AND is_active = 1`, params,
        );
        if (!(result as { affectedRows: number }).affectedRows) return false;
        await connection.query(`UPDATE question_translations SET translation_status = 'needs_update' WHERE question_id = ? AND language = 'en' AND translation_status != 'manually_edited'`, [id]);
        return true;
      });
      if (!updated) return bad("Active question not found in this exam/set.", 404);
      // Queue only after the master edit and stale marker commit together.
      void syncTranslationFor(id).catch(() => {});
      return NextResponse.json({ ok: true, translation: "queued" });
    }
    // create (default)
    const examId = String(body.examId ?? "").trim();
    const set = normalizeSyncSet(body.set);
    const topic = normalizeTopic(body.topic);
    if (!examId) return bad("examId is required.");
    if (!set) return bad("set must be A or B.");
    if (!topic) return bad("topic must be one of Cell Structure, Cell Division, Cell Chemistry, Microorganisms.");
    const qText = String(body.question ?? "").trim();
    if (qText.length < 3) return bad("Question text is required (at least 3 characters).");
    const opts = Array.isArray(body.options) ? body.options : [];
    if (opts.length !== 4 || opts.some((o) => typeof o !== "string" || !o.trim())) return bad("Four non-empty options are required.");
    const correct = correctLetterToIndex(body.correctOption);
    if (correct === null) return bad("correctOption must be A/B/C/D.");
    const difficulty = body.difficulty === undefined || body.difficulty === null
      ? null : normalizeDifficulty(body.difficulty);
    if (body.difficulty !== undefined && body.difficulty !== null && !difficulty) return bad("Invalid difficulty.");
    await ensureExamSets(examId);
    // Duplicate guard: same Bangla text must not already live in the other set.
    const dupRows = await query<{ id: number; set_label: string }[]>(
      `SELECT id, set_label FROM exam_questions WHERE exam_id = ? AND is_active = 1 AND question = ? LIMIT 1`, [examId, qText],
    );
    if (dupRows[0] && dupRows[0].set_label !== set) {
      return NextResponse.json(
        { error: "Duplicate Question Detected — This question is already assigned to another set." },
        { status: 409 },
      );
    }
    const uid = await allocateQuestionUid();
    const countRows = await query<{ m: number | null }[]>(
      `SELECT MAX(sort_order) AS m FROM exam_questions WHERE exam_id = ? AND set_label = ? AND is_active = 1`, [examId, set],
    );
    const sortOrder = (Number(countRows[0]?.m) || 0) + 1;
    const marks = Number(body.marks) > 0 ? Number(body.marks) : 1;
    const res = (await exec(
      `INSERT INTO exam_questions
         (exam_id, set_label, question_uid, bank_subject, topic, question, options, correct_index, explanation, difficulty, marks, sort_order, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [examId, set, uid, String(body.subject ?? ""), topic, qText, JSON.stringify(opts.slice(0, 4)),
        correct, body.explanation ? String(body.explanation) : null, difficulty, marks, sortOrder],
    )) as unknown as { insertId?: number };
    const newId = Number((res as { insertId?: number })?.insertId) || 0;
    if (newId) void syncTranslationFor(newId).catch(() => {});
    return NextResponse.json({ ok: true, id: newId, questionUid: uid, sortOrder, translation: "queued" });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed." }, { status: 500 });
  }
}
