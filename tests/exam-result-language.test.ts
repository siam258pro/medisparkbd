import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";
import type { BaseQuestionRow, QuestionVersion, VariantRow } from "../src/lib/exam-variants.ts";
import * as language from "../src/lib/exam-result-language.ts";
import * as parser from "../src/lib/paste-mcq-parser.ts";

// Execute the actual server modules with DB/auth boundaries mocked. TypeScript
// transpilation resolves their Next aliases without adding a test dependency.
function loadServer<T>(path: string, dependencies: Record<string, unknown>): T {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: path,
  }).outputText;
  const serverModule = { exports: {} };
  const nativeRequire = createRequire(import.meta.url);
  const require = (name: string) => {
    if (name in dependencies) return dependencies[name];
    if (name.startsWith("node:")) return nativeRequire(name);
    throw new Error(`Unexpected dependency: ${name}`);
  };
  runInThisContext(`(function(require, module, exports) {\n${compiled}\n})`, { filename: path })(require, serverModule, serverModule.exports);
  return serverModule.exports as T;
}

const base: BaseQuestionRow = {
  id: 19,
  question: "বাংলা প্রশ্ন",
  options: JSON.stringify(["বাংলা ক", "বাংলা খ", "বাংলা গ", "বাংলা ঘ"]),
  correct_index: 0,
  explanation: "বাংলা ব্যাখ্যা",
  marks: 1,
};

function variant(lang: QuestionVersion = "english", set = "A", overrides: Partial<VariantRow> = {}): VariantRow {
  return {
    question_id: 19, lang, set_label: set,
    question: lang === "english" ? `English question ${set}` : `বাংলা প্রশ্ন ${set}`,
    options: JSON.stringify(["English A", "English B", "English C", "English D"]),
    correct_index: 2, explanation: "English explanation", marks: 2, question_image: null,
    ...overrides,
  };
}

function variantMap(...rows: VariantRow[]) {
  return new Map(rows.map((row) => [`${row.question_id}:${row.lang}:${row.set_label}`, row]));
}

function harness(
  initialResult: Record<string, unknown> | null,
  variants = variantMap(variant(), variant("english", "B"), variant("bangla")),
  liveEnum = false,
) {
  let result = initialResult;
  const calls: { sql: string; params: unknown[] }[] = [];
  const attempt = {
    session_token: "locked-session", status: "active", timer_type: "first",
    question_version: "english", assigned_set: "B", question_order: "[19]",
    started_at: new Date(Date.now() - 60_000).toISOString(),
    expires_at: new Date(Date.now() + 1_740_000).toISOString(),
  };
  const mysql = {
    parseJsonColumn: (value: unknown) => typeof value === "string" ? JSON.parse(value) : value,
    ensureColumn: async () => {},
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("student_uid = ?") && params[1] !== "owner") return [];
      if (sql.includes("MAX(score)")) return [{ best: result?.score ?? null }];
      if (sql.includes("MAX(id)")) return [{ maxId: result ? 1 : 0 }];
      if (sql.includes("COUNT(*)")) return [{ n: result ? 1 : 0 }];
      if (sql.includes("FROM exam_results")) return result ? [result] : [];
      if (sql.includes("FROM exam_questions")) return [base];
      if (sql.includes("FROM exam_attempt_answers")) return [];
      if (sql.includes("FROM exam_attempts")) return [attempt];
      throw new Error(`Unexpected query: ${sql}`);
    },
    exec: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.startsWith("UPDATE exam_attempts SET status = ?")) attempt.status = String(params[0]);
      if (/INSERT INTO exam_results\s/.test(sql)) {
        const columns = sql.match(/exam_results\s*\(([^)]+)\)/)![1].split(",").map((value) => value.trim());
        if (liveEnum && params[columns.indexOf("attempt_type")] === "scheduled") {
          throw Object.assign(new Error("Data truncated for attempt_type: enum('live','practice')"), { code: "WARN_DATA_TRUNCATED" });
        }
        result = Object.fromEntries(columns.map((column, index) => [column, params[index]]));
        if (liveEnum && !columns.includes("attempt_type")) result.attempt_type = "live";
        result.submitted_at = new Date().toISOString();
      }
      return { affectedRows: 1 };
    },
    withTransaction: async (work: (connection: unknown) => Promise<unknown>) => work({
      query: async (sql: string, params: unknown[] = []) => [
        /^\s*SELECT/.test(sql) ? await mysql.query(sql, params) : await mysql.exec(sql, params),
      ],
    }),
  };
  const variantModule = loadServer<typeof import("../src/lib/exam-variants.ts")>("src/lib/exam-variants.ts", {
    "@/lib/mysql": mysql, "@/lib/paste-mcq-parser": parser,
  });
  const exam = { id: "exam-1", title: "Test exam", status: "published", kind: liveEnum ? "free" : "practice", examMode: liveEnum ? "live" : "practice", durationMinutes: 30, courseType: "Academic" };
  const taking = loadServer<typeof import("../src/lib/exam-taking.ts")>("src/lib/exam-taking.ts", {
    "@/lib/mysql": mysql,
    "@/lib/exams-admin": { fetchExams: async () => [exam], fetchExamById: async () => exam },
    "@/lib/exam-variants": { ...variantModule, ensureVariantTables: async () => {}, fetchVariantMap: async () => variants },
    "@/lib/paste-mcq-parser": parser,
    "@/lib/exam-result-language": language,
    "@/lib/exam-lifecycle": { isPublicPostLivePractice: () => false },
    "@/lib/enrolled-exam-lifecycle": { isEnrolledExam: async () => false },
  });
  return { taking, calls, attempt, getResult: () => result };
}

function storedResult(overrides: Record<string, unknown> = {}) {
  return {
    score: 2, total_marks: 2, answers: '{"19":2}', details: null,
    submitted_at: "2026-10-01T12:00:00Z", time_taken_seconds: 60,
    question_version: "english", assigned_set: "B", question_order: "[19]",
    ...overrides,
  };
}

describe("result language contract and fallback", () => {
  it("accepts only en/bn and builds the answer-sheet URL", () => {
    assert.equal(language.parseExamVersion("en"), "english");
    assert.equal(language.parseExamVersion("bn"), "bangla");
    for (const value of ["english", "bangla", "EN", " en", "", undefined, ["en"], "fr"]) {
      assert.equal(language.parseExamVersion(value), null);
    }
    assert.equal(language.examResultApiPath("exam/a", "english"), "/api/exams/exam%2Fa/result?exam_version=en");
    assert.equal(language.examResultApiPath("exam-1", "bangla"), "/api/exams/exam-1/result?exam_version=bn");
  });

  it("English variants win over Bengali base content even without a set snapshot", () => {
    const resolved = language.resolveResultQuestionContent(base, variantMap(variant()), "english", null);
    assert.equal(resolved.question, "English question A");
    assert.deepEqual(resolved.options, ["English A", "English B", "English C", "English D"]);
    assert.equal(resolved.correctIndex, 2);
    assert.equal(resolved.explanation, "English explanation");
    assert.equal(resolved.contentFallback, null);
  });

  it("legacy results may use the selected-language B cell when A is absent", () => {
    assert.equal(language.resolveResultQuestionContent(base, variantMap(variant("english", "B")), "english", null).question, "English question B");
  });

  it("missing or corrupt translations fall back as a whole, never mixed fields", () => {
    for (const options of ["invalid JSON", "{}", "[]", '["valid", " "]']) {
      const resolved = language.resolveResultQuestionContent(base, variantMap(variant("english", "A", { options })), "english", "A");
      assert.equal(resolved.question, base.question);
      assert.equal(resolved.explanation, base.explanation);
      assert.equal(resolved.correctIndex, 0);
      assert.equal(resolved.contentFallback, "base");
    }
  });

  it("does not substitute another language/set for an empty locked slot", () => {
    const resolved = language.resolveResultQuestionContent({ ...base, question: "", options: "[]" }, variantMap(variant("english", "B"), variant("bangla", "A")), "english", "A");
    assert.equal(resolved.contentFallback, "unavailable");
    assert.match(resolved.question, /unavailable in English/);
    assert.deepEqual(resolved.options, []);
    assert.equal(resolved.correctIndex, null);
  });

  it("missing English explanations and unknown answers do not leak Bengali values", () => {
    const resolved = language.resolveResultQuestionContent(base, variantMap(variant("english", "A", { explanation: null, correct_index: null })), "english", "A");
    assert.equal(resolved.explanation, null);
    assert.equal(resolved.correctIndex, null);
  });

  it("supports image-only English questions and native JSON option arrays", () => {
    const cell = variant("english", "A", { question: "", question_image: "/question.png" });
    Object.assign(cell, { options: ["one", "two"] });
    const resolved = language.resolveResultQuestionContent(base, variantMap(cell), "english", "A");
    assert.equal(resolved.questionImage, "/question.png");
    assert.deepEqual(resolved.options, ["one", "two"]);
    assert.equal(resolved.correctIndex, null); // Authored index is out of bounds.
  });
});

describe("session → submit → persisted result replay", () => {
  it("resumes locked English despite a Bengali URL, persists it, and replays it", async () => {
    const h = harness(null);
    const session = await h.taking.getExamForTaking("exam-1", "owner", "Student", false, "first", "bangla");
    assert.equal(session?.questionVersion, "english");
    assert.equal(session?.questions[0].question, "English question B");
    assert.equal("correctIndex" in session!.questions[0], false);
    const outcome = await h.taking.submitExamAttempt("exam-1", "owner", "Student", { "19": 2 });
    assert.equal(outcome?.questionVersion, "english");
    assert.equal(outcome?.score, 2);
    assert.equal(h.getResult()?.question_version, "english");
    assert.equal(h.getResult()?.assigned_set, "B");
    const script = await h.taking.getExamResultScript("exam-1", "owner", "bangla");
    assert.equal(script?.questionVersion, "english");
    assert.equal(script?.questions[0].question, "English question B");
    assert.equal(script?.questions[0].chosenIndex, 2);
    assert.equal(script?.questions[0].correctIndex, 2);
    assert.equal(script?.questions[0].explanation, "English explanation");
  });

  it("keeps English snapshots when the deployed live/practice enum rejects scheduled", async () => {
    const h = harness(null, variantMap(variant("english", "B")), true);
    const outcome = await h.taking.submitExamAttempt("exam-1", "owner", "Student", { "19": 2 });
    assert.equal(outcome?.questionVersion, "english");
    assert.equal(h.getResult()?.attempt_type, "live");
    assert.equal(h.getResult()?.question_version, "english");
    assert.equal(h.getResult()?.assigned_set, "B");
    assert.equal(h.getResult()?.question_order, "[19]");
    assert.equal(h.calls.filter((call) => /INSERT INTO exam_results\s/.test(call.sql)).length, 2);
    const script = await h.taking.getExamResultScript("exam-1", "owner");
    assert.equal(script?.questions[0].question, "English question B");
  });

  it("accepts the request medium only when the persisted medium is missing", async () => {
    const h = harness(storedResult({ question_version: null, assigned_set: null }));
    const script = await h.taking.getExamResultScript("exam-1", "owner", "english");
    assert.equal(script?.questionVersion, "english");
    assert.equal(script?.questions[0].question, "English question A");
    const legacy = await h.taking.getExamResultScript("exam-1", "owner");
    assert.equal(legacy?.questionVersion, "bangla");
    assert.equal(legacy?.questions[0].question, "বাংলা প্রশ্ন A");
  });

  it("retains a partial legacy language snapshot without set/order columns", async () => {
    const result: Record<string, unknown> = storedResult();
    delete result.assigned_set;
    delete result.question_order;
    const script = await harness(result).taking.getExamResultScript("exam-1", "owner", "bangla");
    assert.equal(script?.questionVersion, "english");
    assert.equal(script?.questions[0].question, "English question A");
  });

  it("persisted Bengali medium cannot be overridden by exam_version=en", async () => {
    const script = await harness(storedResult({ question_version: "bangla", assigned_set: "A" })).taking.getExamResultScript("exam-1", "owner", "english");
    assert.equal(script?.questionVersion, "bangla");
    assert.equal(script?.questions[0].question, "বাংলা প্রশ্ন A");
  });

  it("grading-time correct answers, marks and scores remain authoritative", async () => {
    const details = JSON.stringify([{ questionId: 19, chosenIndex: 3, correctIndex: 3, marks: 5, obtained: 5 }]);
    const script = await harness(storedResult({ score: 5, details })).taking.getExamResultScript("exam-1", "owner");
    assert.equal(script?.questions[0].correctIndex, 3);
    assert.equal(script?.questions[0].chosenIndex, 3);
    assert.equal(script?.questions[0].marks, 5);
    assert.equal(script?.score, 5);
  });

  it("preserves unknown grading answers instead of defaulting to A", async () => {
    const details = JSON.stringify([{ questionId: 19, chosenIndex: null, correctIndex: null, marks: 2, obtained: 0 }]);
    const script = await harness(storedResult({ details })).taking.getExamResultScript("exam-1", "owner");
    assert.equal(script?.questions[0].correctIndex, null);
    assert.equal(script?.questions[0].chosenIndex, null);
  });

  it("returns no script for another student or an unsubmitted first attempt", async () => {
    const h = harness(storedResult());
    assert.equal(await h.taking.getExamResultScript("exam-1", "other-student", "english"), null);
    assert.match(h.calls[0].sql, /WHERE exam_id = \? AND student_uid = \?/);
    assert.equal(await harness(null).taking.getExamResultScript("exam-1", "owner", "english"), null);
  });
});

describe("GET result API", () => {
  function route(user: { uid: string } | null, taking: Pick<typeof import("../src/lib/exam-taking.ts"), "getExamResultScript">) {
    return loadServer<typeof import("../src/app/api/exams/[id]/result/route.ts")>("src/app/api/exams/[id]/result/route.ts", {
      "next/server": { NextResponse: { json: (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { ...init, headers: { "Content-Type": "application/json", ...init.headers } }) } },
      "@/lib/auth-api": { getFirebaseUser: async () => user },
      "@/lib/exam-taking": taking,
      "@/lib/exam-result-language": language,
    });
  }
  const request = (query = "") => ({ nextUrl: new URL(`https://example.test/api/exams/exam-1/result${query}`) }) as Parameters<ReturnType<typeof route>["GET"]>[0];
  const context = { params: Promise.resolve({ id: "exam-1" }) };

  it("requires authentication before revealing any result", async () => {
    const response = await route(null, { getExamResultScript: async () => { throw new Error("Must not query results"); } }).GET(request("?exam_version=en"), context);
    assert.equal(response.status, 401);
  });

  it("rejects invalid, empty, long-form and duplicate versions", async () => {
    const api = route({ uid: "owner" }, { getExamResultScript: async () => { throw new Error("Must not query results"); } });
    for (const query of ["?exam_version=fr", "?exam_version=", "?exam_version=english", "?exam_version=EN", "?exam_version=en&exam_version=bn"]) {
      assert.equal((await api.GET(request(query), context)).status, 400);
    }
  });

  it("accepts en/bn or an omitted version, remains owner-scoped and uncached", async () => {
    const h = harness(storedResult());
    const api = route({ uid: "owner" }, h.taking);
    for (const query of ["?exam_version=en", "?exam_version=bn", ""]) {
      const response = await api.GET(request(query), context);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      const body = await response.json();
      assert.equal(body.questionVersion, "english");
      assert.equal(body.questions[0].question, "English question B");
      assert.equal("student_uid" in body, false);
      assert.equal("assigned_set" in body, false);
    }
    assert.equal((await route({ uid: "other-student" }, h.taking).GET(request("?exam_version=en"), context)).status, 404);
  });

  it("passes validated English through to legacy result mapping", async () => {
    const h = harness(storedResult({ question_version: null, assigned_set: null }));
    const response = await route({ uid: "owner" }, h.taking).GET(request("?exam_version=en"), context);
    assert.equal((await response.json()).questions[0].question, "English question A");
  });
});
