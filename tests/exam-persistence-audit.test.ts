import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";
import * as parser from "../src/lib/paste-mcq-parser.ts";
import * as language from "../src/lib/exam-result-language.ts";
import type { BaseQuestionRow, VariantRow } from "../src/lib/exam-variants.ts";

type Taking = typeof import("../src/lib/exam-taking.ts");
type Recalculation = typeof import("../src/lib/exam-recalculation.ts");
type PublicResults = typeof import("../src/lib/public-exam-results.ts");
type MyResults = typeof import("../src/lib/my-exam-results.ts");
type Stored = Record<string, unknown>;
type State = { attempt: Stored | null; answers: Record<string, number>; results: Stored[] };

function load<T>(path: string, dependencies: Record<string, unknown>): T {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }, fileName: path,
  }).outputText;
  const module = { exports: {} };
  const nativeRequire = createRequire(import.meta.url);
  const require = (name: string) => {
    if (name in dependencies) return dependencies[name];
    if (name.startsWith("node:")) return nativeRequire(name);
    throw new Error(`Unexpected dependency: ${name}`);
  };
  runInThisContext(`(function(require,module,exports){\n${compiled}\n})`, { filename: path })(require, module, module.exports);
  return module.exports as T;
}

function paper(id = 19): BaseQuestionRow & { is_active: number } {
  return { id, question: `Base ${id}`, options: '["base A","base B","base C","base D"]', correct_index: 0, marks: 1, explanation: "Base explanation", is_active: 1 };
}
function cell(id = 19): VariantRow {
  return { question_id: id, lang: "english", set_label: "B", question: `English B ${id}`, options: '["first","second","third","fourth"]', correct_index: 2, marks: 2, explanation: "Original explanation", question_image: "/original.png" };
}

function harness(ids = [19]) {
  let state: State = {
    attempt: { session_token: "session-1", status: "active", question_version: "english", assigned_set: "B", question_order: JSON.stringify(ids), timer_type: "first", started_at: new Date(Date.now() - 60_000).toISOString(), expires_at: new Date(Date.now() + 1_000_000).toISOString() },
    answers: {}, results: [],
  };
  const questions = ids.map(paper);
  const variants = new Map(ids.map((id) => [`${id}:english:B`, cell(id)]));
  const calls: { sql: string; params: unknown[]; transaction: boolean }[] = [];
  let failInsert = false;
  let failVariantRead = false;
  let legacyColumns = false;
  let liveEnum = false;
  let practice = true;
  let commits = 0;
  let rollbacks = 0;
  let serial = Promise.resolve();
  const parseJsonColumn = <T>(raw: unknown): T | null => {
    try { return (typeof raw === "string" ? JSON.parse(raw) : raw ?? null) as T | null; } catch { return null; }
  };
  const db = async (s: State, sql: string, params: unknown[] = [], transaction = false): Promise<unknown> => {
    calls.push({ sql, params, transaction });
    const latest = s.results.at(-1);
    if (sql.includes("FROM exam_results")) {
      if (sql.includes("MAX(score)")) return [{ best: Math.max(0, ...s.results.filter((r) => !sql.includes("attempt_type") || r.attempt_type !== "practice").map((r) => Number(r.score))), exam_id: "exam-1" }];
      if (sql.includes("COUNT(*)")) return [{ n: s.results.length }];
      if (sql.includes("MAX(id)")) return [{ maxId: latest?.id ?? 0 }];
      if (sql.includes("r.student_uid = ?") && params[0] !== "owner") return [];
      if (sql.includes("student_uid = ?") && !sql.includes("r.student_uid = ?") && params[1] !== "owner") return [];
      let rows = s.results;
      if (sql.includes("AND id = ?")) rows = rows.filter((r) => r.id === params[2]);
      if (sql.includes("attempt_type IN")) rows = rows.filter((r) => r.attempt_type !== "practice");
      if (sql.includes("ORDER BY id DESC") || sql.includes("ORDER BY r.id DESC")) rows = [...rows].reverse();
      if (sql.includes("LIMIT 1") && !sql.includes("LIMIT 1000")) rows = rows.slice(0, 1);
      return rows.map((r) => ({ ...r, result_id: r.id, title: "Test exam", exam_id: "exam-1", course_type: "Admission", course_name: null }));
    }
    if (sql.includes("FROM exam_questions")) {
      return questions.filter((q) => (!sql.includes("is_active = 1") || q.is_active === 1) && (!sql.includes("AND id = ?") || q.id === params[1]));
    }
    if (!sql.startsWith("DELETE") && sql.includes("FROM exam_attempt_answers")) return Object.entries(s.answers).map(([question_id, option_index]) => ({ question_id: Number(question_id), option_index }));
    if (sql.includes("FROM exam_attempts")) return s.attempt ? [s.attempt] : [];
    if (sql.includes("FROM students")) return [];
    if (sql.includes("FROM exams")) return [{ id: "exam-1", title: "Test exam", total_marks: 2, duration_minutes: 30, course_type: "Admission", negative_enabled: 1, negative_per_wrong: 0.25, category_name: "Test" }];
    if (sql.includes("FROM exam_settings")) return [];
    if (sql.startsWith("UPDATE exam_attempts SET question_version")) {
      if (s.attempt) {
        s.attempt.question_version ??= params[0]; s.attempt.assigned_set ??= params[1]; s.attempt.question_order ??= params[2];
      }
      return { affectedRows: 1 };
    }
    if (sql.startsWith("UPDATE exam_attempts SET status")) {
      if (!s.attempt || s.attempt.status !== "active" || s.attempt.session_token !== params[3]) return { affectedRows: 0 };
      s.attempt.status = params[0]; return { affectedRows: 1 };
    }
    if (/INSERT INTO exam_results\s/.test(sql)) {
      if (failInsert) throw Object.assign(new Error("Storage unavailable"), { code: "ER_DISK_FULL" });
      const columns = sql.match(/exam_results\s*\(([^)]+)\)/)![1].split(",").map((c) => c.trim());
      if (legacyColumns && columns.includes("question_version")) throw Object.assign(new Error("Unknown snapshot column"), { code: "ER_BAD_FIELD_ERROR" });
      if (liveEnum && params[columns.indexOf("attempt_type")] === "scheduled") throw Object.assign(new Error("Legacy enum"), { code: "WARN_DATA_TRUNCATED" });
      const result: Stored = Object.fromEntries(columns.map((c, i) => [c, params[i]]));
      result.id = s.results.length + 1; result.submitted_at = new Date().toISOString();
      result.attempt_type ??= "live";
      s.results.push(result); return { affectedRows: 1, insertId: result.id };
    }
    if (sql.startsWith("INSERT INTO exam_attempt_answers")) {
      const key = String(params[2]);
      if (key in s.answers) throw Object.assign(new Error("Already answered"), { code: "ER_DUP_ENTRY" });
      s.answers[key] = Number(params[3]); return { affectedRows: 1 };
    }
    if (sql.startsWith("UPDATE exam_results") && sql.includes("SET score")) {
      const result = s.results.find((r) => r.id === params[4]);
      if (!result || (sql.includes("details <=>") && result.details !== params[5])) return { affectedRows: 0 };
      Object.assign(result, { score: params[0], total_marks: params[1], details: params[2], negative_deduction: params[3] });
      return { affectedRows: 1 };
    }
    if (sql.startsWith("UPDATE exam_results") && sql.includes("merit_position")) {
      for (const result of s.results) {
        if (sql.includes("WHERE id = ?") && result.id === params[1]) result.merit_position = params[0];
        else if (sql.includes("attempt_type = 'practice'") && result.attempt_type === "practice") result.merit_position = null;
      }
      return { affectedRows: 1 };
    }
    if (sql.startsWith("DELETE FROM exam_attempt_answers")) { s.answers = {}; return { affectedRows: 1 }; }
    if (sql.startsWith("CREATE") || sql.startsWith("ALTER") || sql.startsWith("INSERT INTO exam_enrollments") || sql.startsWith("UPDATE exam_attempts SET last_seen")) return { affectedRows: 1 };
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  const mysql = {
    parseJsonColumn, ensureColumn: async () => {},
    query: (sql: string, params: unknown[] = []) => db(state, sql, params),
    exec: (sql: string, params: unknown[] = []) => db(state, sql, params),
    withTransaction: async <T>(work: (connection: unknown) => Promise<T>): Promise<T> => {
      const previous = serial;
      let release: () => void = () => {};
      serial = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      const pending = structuredClone(state);
      try {
        const value = await work({ query: async (sql: string, params: unknown[] = []) => [await db(pending, sql, params, true)] });
        state = pending; commits += 1; return value;
      } catch (error) { rollbacks += 1; throw error; } finally { release(); }
    },
  };
  const variantModule = load<typeof import("../src/lib/exam-variants.ts")>("src/lib/exam-variants.ts", { "@/lib/mysql": mysql, "@/lib/paste-mcq-parser": parser });
  const variantDependencies = { ...variantModule, ensureVariantTables: async () => {}, assignSetForExam: async () => "A", fetchVariantMap: async () => { if (failVariantRead) throw new Error("Variant read failed"); return variants; } };
  const exam = () => ({ id: "exam-1", title: "Test exam", status: "published", kind: practice ? "practice" : "free", examMode: practice ? "practice" : "live", courseType: "Admission", durationMinutes: 30 });
  const admin = { fetchExams: async () => [exam()], fetchExamById: async () => exam() };
  const taking = load<Taking>("src/lib/exam-taking.ts", {
    "@/lib/mysql": mysql, "@/lib/exams-admin": admin, "@/lib/exam-variants": variantDependencies,
    "@/lib/paste-mcq-parser": parser, "@/lib/exam-result-language": language,
    "@/lib/exam-lifecycle": { isPublicPostLivePractice: () => false, isPublicPracticeExam: () => practice, getPublicLiveState: () => "live" },
    "@/lib/enrolled-exam-lifecycle": { isEnrolledExam: async () => false },
  });
  const recalc = load<Recalculation>("src/lib/exam-recalculation.ts", { "@/lib/mysql": mysql, "@/lib/exams-admin": admin, "@/lib/exam-variants": variantDependencies, "@/lib/paste-mcq-parser": parser, "@/lib/exam-taking": taking });
  const publicResults = load<PublicResults>("src/lib/public-exam-results.ts", { "@/lib/mysql": mysql, "@/lib/paste-mcq-parser": parser, "@/lib/exam-taking": taking });
  const myResults = load<MyResults>("src/lib/my-exam-results.ts", { "@/lib/mysql": mysql, "@/lib/exam-taking": taking });
  return { taking, recalc, publicResults, myResults, questions, variants, calls, mysql,
    state: () => state, commits: () => commits, rollbacks: () => rollbacks,
    failInsert: (value: boolean) => { failInsert = value; }, failVariantRead: () => { failVariantRead = true; },
    legacyColumns: () => { legacyColumns = true; }, official: () => { practice = false; }, liveEnum: () => { liveEnum = true; },
    submit: (answers: Record<string, number> = { "19": 2 }) => taking.submitExamAttempt("exam-1", "owner", "Student", answers, "session-1"),
  };
}

describe("submitted paper persistence", () => {
  it("grades and snapshots the locked English/B paper, not the requested language or base key", async () => {
    const h = harness();
    const session = await h.taking.getExamForTaking("exam-1", "owner", "Student", false, "first", "bangla");
    assert.equal(session?.questionVersion, "english");
    assert.equal("correctIndex" in session!.questions[0], false);
    assert.equal((await h.submit())?.score, 2);
    const result = h.state().results[0];
    assert.equal(result.question_version, "english"); assert.equal(result.assigned_set, "B");
    const detail = JSON.parse(String(result.details))[0];
    assert.equal(detail.correctIndex, 2); assert.equal(detail.question, "English B 19");
    assert.deepEqual(detail.options, ["first", "second", "third", "fourth"]);
    assert.equal(detail.gradingSource, "variant");
  });
  it("uses real base options when a variant is absent instead of grading with placeholder []", async () => {
    const h = harness(); h.variants.clear();
    const outcome = await h.submit({ "19": 0 });
    assert.equal(outcome?.score, 1); assert.equal(outcome?.correctCount, 1);
    assert.equal(JSON.parse(String(h.state().results[0].details))[0].gradingSource, "base");
  });
  it("stored first selections override conflicting submit payloads by permanent question ID", async () => {
    const h = harness([27, 19]); h.state().answers = { "19": 2, "27": 0 };
    const result = await h.submit({ "19": 0, "27": 2 });
    assert.equal(result?.correctCount, 1); assert.equal(result?.wrongCount, 1);
    assert.deepEqual(JSON.parse(String(h.state().results[0].answers)), { "19": 2, "27": 0 });
    assert.deepEqual(JSON.parse(String(h.state().results[0].details)).map((d: { questionId: number }) => d.questionId), [27, 19]);
  });
  it("does not append newly-added questions on resume or submit and drops foreign/out-of-range selections", async () => {
    const h = harness(); h.questions.push(paper(99));
    const session = await h.taking.getExamForTaking("exam-1", "owner", "Student", false);
    assert.deepEqual(session?.questions.map((q) => q.id), [19]);
    assert.equal((await h.submit({ "19": 99, "99": 0, "1000": 0 }))?.skippedCount, 1);
    assert.deepEqual(JSON.parse(String(h.state().results[0].answers)), {});
  });
  it("replays original text/options/image/explanation/order and counts after live content is edited or deleted", async () => {
    const h = harness([27, 19]); await h.submit({ "19": 2 });
    const original = await h.taking.getExamResultScript("exam-1", "owner");
    h.questions.splice(0, h.questions.length, paper(99)); h.variants.clear();
    const before = h.calls.length;
    const replay = await h.taking.getExamResultScript("exam-1", "owner", "bangla");
    assert.deepEqual(replay?.questions, original?.questions);
    assert.equal(h.calls.slice(before).some((c) => c.sql.includes("FROM exam_questions")), false);
    const retry = await h.submit({ "99": 0 });
    assert.equal(retry?.correctCount, 1); assert.equal(retry?.skippedCount, 1); assert.equal(retry?.score, 2);
  });
  it("keeps medium/set/order inside details even when result snapshot columns are unavailable", async () => {
    const h = harness([27, 19]); h.legacyColumns(); await h.submit({ "19": 2 });
    const script = await h.taking.getExamResultScript("exam-1", "owner", "bangla");
    assert.equal(script?.questionVersion, "english");
    assert.deepEqual(script?.questions.map((q) => q.questionId), [27, 19]);
  });
  it("preserves valid partial attempt language and set when backfilling missing order", async () => {
    const h = harness(); h.state().attempt!.question_order = null;
    const session = await h.taking.getExamForTaking("exam-1", "owner", "Student", false, "first", "bangla");
    assert.equal(session?.questionVersion, "english"); assert.equal(h.state().attempt!.assigned_set, "B");
    assert.match(session!.questions[0].question, /English B/);
  });
  it("does not invent an attempt or silently grade missing assignments/read failures", async () => {
    const absent = harness(); absent.state().attempt = null; assert.equal(await absent.submit(), null);
    const partial = harness(); partial.state().attempt!.assigned_set = null;
    await assert.rejects(partial.submit(), /assignment is missing/); assert.equal(partial.state().attempt!.status, "active");
    const unavailable = harness(); unavailable.failVariantRead();
    await assert.rejects(unavailable.submit(), /Variant read failed/); assert.equal(unavailable.state().results.length, 0);
  });
});

describe("transactional answers and submission", () => {
  it("rolls back result insert failures, retains saved answers, and successfully retries once", async () => {
    const h = harness(); h.state().answers["19"] = 2; h.failInsert(true);
    await assert.rejects(h.submit(), /Storage unavailable/);
    assert.equal(h.state().attempt!.status, "active"); assert.deepEqual(h.state().answers, { "19": 2 });
    assert.equal(h.state().results.length, 0); assert.equal(h.rollbacks(), 1);
    assert.equal(h.calls.filter((c) => /INSERT INTO exam_results\s/.test(c.sql)).length, 1);
    h.failInsert(false); assert.equal((await h.submit({ "19": 0 }))?.score, 2);
    assert.equal(h.state().results.length, 1); assert.deepEqual(h.state().answers, {});
    for (const call of h.calls.filter((c) => /INSERT INTO exam_results\s|UPDATE exam_attempts SET status|DELETE FROM exam_attempt_answers/.test(c.sql))) assert.equal(call.transaction, true);
  });
  it("concurrent submits return the same immutable result with one insert", async () => {
    const h = harness(); h.state().answers["19"] = 2;
    const outcomes = await Promise.all([h.submit({ "19": 0 }), h.submit({ "19": 3 }), h.submit()]);
    assert.deepEqual(outcomes.map((o) => [o?.score, o?.correctCount]), [[2, 1], [2, 1], [2, 1]]);
    assert.equal(h.state().results.length, 1);
    assert.equal(h.calls.filter((c) => /INSERT INTO exam_results\s/.test(c.sql)).length, 1);
    assert.ok(h.calls.some((c) => c.sql.includes("FOR UPDATE")));
  });
  it("first answer wins concurrent saves and no answer can be added after finalization", async () => {
    const h = harness();
    const saves = await Promise.all([h.taking.saveExamAnswer("exam-1", "owner", "Student", "session-1", 19, 2), h.taking.saveExamAnswer("exam-1", "owner", "Student", "session-1", 19, 0)]);
    assert.deepEqual(saves.map((s) => s.accepted), [true, false]);
    assert.equal((await h.submit({ "19": 0 }))?.score, 2);
    assert.equal((await h.taking.saveExamAnswer("exam-1", "owner", "Student", "session-1", 19, 0)).accepted, false);
    assert.deepEqual(h.state().answers, {});
  });
  it("rejects stale tokens, foreign question IDs, and option indexes outside the locked cell", async () => {
    const h = harness();
    for (const [token, qid, index] of [["old-session", 19, 2], ["session-1", 999, 0], ["session-1", 19, 4]] as const) {
      assert.equal((await h.taking.saveExamAnswer("exam-1", "owner", "Student", token, qid, index)).accepted, false);
    }
    assert.equal(await h.taking.submitExamAttempt("exam-1", "owner", "Student", { "19": 0 }, "old-session"), null);
    assert.equal(h.state().attempt!.status, "active"); assert.deepEqual(h.state().answers, {});
  });
  it("supports the deployed live enum without losing snapshots or ranking practice attempts", async () => {
    const h = harness(); h.official(); h.liveEnum(); await h.submit();
    assert.equal(h.state().results[0].attempt_type, "live"); assert.equal(h.state().results[0].question_version, "english");
    assert.equal(h.state().results[0].merit_position, 1);
    const practice = harness(); await practice.submit(); assert.equal(practice.state().results[0].merit_position, null);
  });
});

describe("safe answer-key recalculation", () => {
  it("corrects only the locked key and preserves original paper/marks/order/answers/timer penalty on repeated runs", async () => {
    const h = harness([27, 19]); h.state().attempt!.timer_type = "second";
    await h.submit({ "19": 3, "27": 2 });
    const result = h.state().results[0]; result.timer_penalty = 1;
    const before = JSON.parse(String(result.details)); const answers = result.answers;
    h.variants.get("19:english:B")!.correct_index = 3; h.variants.get("19:english:B")!.marks = 99;
    h.questions.push(paper(99));
    assert.deepEqual(await h.recalc.recalculateExamResults("exam-1"), { recalculated: 1, skipped: 0 });
    const corrected = h.state().results[0]; const details = JSON.parse(String(corrected.details));
    assert.equal(corrected.score, 3); assert.equal(corrected.total_marks, 4); assert.equal(corrected.timer_penalty, 1);
    assert.equal(corrected.answers, answers); assert.deepEqual(details.map((d: { questionId: number }) => d.questionId), [27, 19]);
    for (let i = 0; i < details.length; i++) {
      for (const field of ["question", "options", "explanation", "questionImage", "chosenIndex", "marks", "gradingSource"]) assert.deepEqual(details[i][field], before[i][field]);
    }
    const snapshot = corrected.details; await h.recalc.recalculateExamResults("exam-1");
    assert.equal(h.state().results[0].score, 3); assert.equal(h.state().results[0].details, snapshot);
  });
  it("skips changed options, replaced stems, removed cells/questions and legacy details rather than guessing", async () => {
    for (const mutation of ["options", "stem", "cell", "question", "legacy"]) {
      const h = harness(); await h.submit(); const original = structuredClone(h.state().results[0]);
      if (mutation === "options") h.variants.get("19:english:B")!.options = '["third","second","first","fourth"]';
      if (mutation === "stem") h.variants.get("19:english:B")!.question = "Replacement";
      if (mutation === "cell") h.variants.clear();
      if (mutation === "question") h.questions[0].is_active = 0;
      if (mutation === "legacy") h.state().results[0].details = '[{"questionId":19,"chosenIndex":2,"correctIndex":2,"marks":2,"obtained":2}]';
      const outcome = await h.recalc.recalculateExamResults("exam-1");
      assert.equal(outcome.recalculated, 0, mutation);
      assert.equal(h.state().results[0].score, original.score, mutation);
      if (mutation !== "legacy") assert.equal(h.state().results[0].details, original.details, mutation);
    }
  });
  it("retains a base fallback key family even if a variant is authored after submission", async () => {
    const h = harness(); h.variants.clear(); await h.submit({ "19": 0 });
    h.variants.set("19:english:B", cell()); h.questions[0].correct_index = 1;
    assert.equal((await h.recalc.recalculateExamResults("exam-1")).recalculated, 1);
    assert.equal(JSON.parse(String(h.state().results[0].details))[0].correctIndex, 1);
    assert.equal(h.state().results[0].score, 0);
  });
});

describe("student and admin result readers", () => {
  it("student cards/detail retain snapshot counts after the questions are removed", async () => {
    const h = harness([27, 19]); await h.submit({ "19": 2 }); h.questions.length = 0;
    const cards = await h.myResults.getStudentResultCards("owner", "public");
    assert.equal(cards[0].correctCount, 1); assert.equal(cards[0].unansweredCount, 1); assert.equal(cards[0].correctMarks, 2);
    const detail = await h.myResults.getStudentExamResultDetail("owner", "exam-1");
    assert.equal(detail?.correctCount, 1); assert.equal(detail?.totalQuestions, 2); assert.equal(detail?.questions.length, 2);
  });
  it("admin leaderboard uses stored grading details rather than the base language key", async () => {
    const h = harness(); h.official(); await h.submit();
    const page = await h.publicResults.fetchPublicExamRankedResultsPage("exam-1");
    assert.equal(page.rows[0].correctCount, 1); assert.equal(page.rows[0].wrongCount, 0);
  });
  it("admin answer sheet pins the official result instead of a later practice paper", async () => {
    const h = harness(); h.official(); await h.submit();
    const official = structuredClone(h.state().results[0]);
    h.state().results.push({ ...official, id: 2, attempt_type: "practice", score: 0, details: '[{"questionId":99,"chosenIndex":0,"correctIndex":1,"marks":1,"obtained":0,"question":"Later practice","options":["x","y"]}]' });
    h.questions.length = 0; h.variants.clear();
    const result = await h.publicResults.fetchPublicExamStudentResult("exam-1", "owner");
    assert.equal(result?.finalMarks, 2); assert.equal(result?.correctCount, 1);
    assert.equal(result?.questions[0].question, "English B 19"); assert.equal(result?.questions[0].correctAnswer, 2);
    assert.ok(h.calls.some((c) => c.sql.includes("AND id = ?") && c.params[2] === 1));
  });
  it("result ID lookup stays owner-scoped", async () => {
    const h = harness(); await h.submit();
    assert.equal(await h.taking.getExamResultScript("exam-1", "other", null, 1), null);
  });
});

describe("submit API persistence boundary", () => {
  function api(h: ReturnType<typeof harness>) {
    return load<{ POST: (request: unknown, context: unknown) => Promise<Response> }>("src/app/api/exams/[id]/submit/route.ts", {
      "next/server": { NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) } },
      "@/lib/auth-api": { getFirebaseUser: async () => ({ uid: "owner", name: "Student" }) },
      "@/lib/exam-taking": h.taking, "@/lib/paste-mcq-parser": parser,
    });
  }
  it("requires an attempt token and rejects array-shaped answers", async () => {
    const h = harness(); const route = api(h); const context = { params: Promise.resolve({ id: "exam-1" }) };
    for (const body of [{ answers: { "19": 2 } }, { token: "session-1", answers: [2] }]) {
      assert.equal((await route.POST({ json: async () => body }, context)).status, 400);
    }
    assert.equal(h.state().results.length, 0);
  });
  it("returns a retryable 503 without closing the attempt when persistence fails", async () => {
    const h = harness(); h.failInsert(true);
    const response = await api(h).POST({ json: async () => ({ token: "session-1", answers: { "19": 2 } }) }, { params: Promise.resolve({ id: "exam-1" }) });
    assert.equal(response.status, 503); assert.equal((await response.json()).transient, true);
    assert.equal(h.state().attempt!.status, "active"); assert.equal(h.state().results.length, 0);
  });
});
