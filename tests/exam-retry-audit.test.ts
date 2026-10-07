import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";
import * as parser from "../src/lib/paste-mcq-parser.ts";
import * as language from "../src/lib/exam-result-language.ts";

/* eslint-disable @typescript-eslint/no-explicit-any -- The VM and SQL mocks intentionally accept dynamically shaped module/driver values. */
// Run: node --experimental-strip-types --test tests/exam-retry-audit.test.ts
// TODO cases are executable desired invariants, NOT passing safety claims.
// They belong to other agents; remove TODO when their production fix lands.
// This is a SQL-boundary simulator, not an InnoDB integration test: no network,
// credentials, packages or migrations. Rollback snapshots are used only with
// serialized/failure scenarios. Race tests synchronize non-locking reads.
type Row = Record<string, any>;
type Call = { sql: string; params: any[]; channel: "pool" | "tx" };
const nativeRequire = createRequire(import.meta.url);
const now = Date.now();
class FixedDate extends Date { static now() { return now; } }
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const compiled = new Map<string, string>();
function compile(path: string) {
  const text = source(path);
  const key = `${path}\n${text}`;
  if (!compiled.has(key)) {
    const output = ts.transpileModule(text, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
      fileName: path, reportDiagnostics: true,
    });
    assert.deepEqual(output.diagnostics?.filter((d) => d.category === ts.DiagnosticCategory.Error), [], `Syntax errors in ${path}`);
    compiled.set(key, output.outputText);
  }
  return compiled.get(key)!;
}
function load<T = any>(path: string, dependencies: Record<string, unknown>, globals: Row = {}): T {
  const serverModule = { exports: {} };
  const require = (name: string) => {
    if (name in dependencies) return dependencies[name];
    if (name.startsWith("node:")) return nativeRequire(name);
    throw new Error(`Unmocked dependency ${name} in ${path}`);
  };
  const scope = { Date: FixedDate, console, setTimeout, process: { env: {} }, ...globals };
  runInThisContext(`(function(require,module,exports,${Object.keys(scope).join(",")}) {\n${compile(path)}\n})`, { filename: path })(require, serverModule, serverModule.exports, ...Object.values(scope));
  return serverModule.exports as T;
}
const dbError = (code = "ER_LOCK_WAIT_TIMEOUT") => Object.assign(new Error(`Injected ${code}`), { code });
const parseJsonColumn = (v: unknown) => typeof v === "string" ? JSON.parse(v) : v;
const question = (id: number, examId = "source-exam", order = id): Row => ({
  id, exam_id: examId, bank_subject: "Physics", question: `Question ${id}?`,
  question_image: null, options: '["A","B"]', correct_index: 0,
  explanation: null, marks: 1, sort_order: order, is_active: 1,
});
const exam = (id = "source-exam"): Row => ({
  id, title: "Source exam", kind: "practice", exam_mode: "practice", subject: "Physics",
  course_type: "Academic", duration_minutes: 30, marks_per_question: 1,
  total_marks: 2, question_count: 2, sort_order: 1, status: "published",
});
const variant = (id: number): Row => ({
  question_id: id, lang: "english", set_label: "A", question: `English ${id}?`,
  options: '["A","B"]', correct_index: 0, explanation: null, marks: 1, question_image: null,
});
const item = (order: number): Row => ({ id: null, order, question: `Question ${order}?`, options: ["A", "B"], correctIndex: 0, marks: 1 });

function database(options: { uniqueSlots?: boolean; refuseUnique?: boolean; cascade?: boolean; serialize?: boolean } = {}) {
  let tables: Record<string, Row[]> = {
    exams: [exam()], exam_questions: [], exam_question_variants: [], exam_rules: [], exam_courses: [],
    exam_attempts: [], exam_attempt_answers: [], exam_results: [], exam_enrollments: [],
  };
  let uniqueSlots = !!options.uniqueSlots;
  let nextId = 100;
  let queue = Promise.resolve();
  const calls: Call[] = [];
  let gate: ((call: Call, result: any) => Promise<void>) | null = null;
  let fault: { match: (call: Call) => boolean; after: boolean; persistent: boolean; hits: number; error: Error } | null = null;
  const rows = (table: string) => tables[table] ??= [];
  function perform(sql: string, p: any[]): any {
    if (/^(CREATE|ALTER) /.test(sql)) {
      if (sql.includes("ADD UNIQUE KEY uq_exam_slot")) {
        if (options.refuseUnique) throw dbError("ER_DUP_ENTRY");
        uniqueSlots = true;
      }
      return { affectedRows: 0 };
    }
    const table = sql.match(/(?:FROM|INTO|UPDATE) (\w+)/)?.[1];
    assert.ok(table, `Unsupported SQL ${sql}`);
    let selected = rows(table);
    if (sql.startsWith("SELECT")) {
      if (/WHERE (?:q\.)?exam_id = \?/.test(sql)) selected = selected.filter((r) => r.exam_id === p[0]);
      if (sql.includes("exam_id IS NULL")) selected = selected.filter((r) => r.exam_id == null);
      if (sql.includes("student_uid = ?")) selected = selected.filter((r) => r.student_uid === p[1]);
      if (/WHERE (?:q\.)?id = \?/.test(sql)) selected = selected.filter((r) => r.id === p[0]);
      if (sql.includes("sort_order = ?")) selected = selected.filter((r) => r.sort_order === p[1]);
      if (sql.includes("is_active = 1")) selected = selected.filter((r) => r.is_active === 1);
      if (sql.includes("FROM exam_question_variants") && sql.includes("JOIN exam_questions")) {
        selected = selected.filter((r) => rows("exam_questions").some((q) => q.id === r.question_id && q.exam_id === p[0]));
      }
      if (sql.includes("question_id = ?")) selected = selected.filter((r) => r.question_id === p[0]);
      if (sql.includes("MAX(sort_order)")) return [{ m: Math.max(0, ...selected.map((r) => r.sort_order ?? 0)) }];
      if (sql.includes("MAX(id)")) return [{ maxId: Math.max(0, ...selected.map((r) => r.id)) }];
      if (sql.includes("MAX(score)")) return [{ best: selected.length ? Math.max(...selected.map((r) => Number(r.score))) : null }];
      if (sql.includes("COUNT(*)")) return [{ count: selected.length, n: selected.length, marks: selected.reduce((s, r) => s + Number(r.marks ?? 0), 0) }];
      if (sql.includes("ORDER BY id DESC")) selected = [...selected].sort((a, b) => b.id - a.id);
      if (sql.includes("ORDER BY sort_order")) selected = [...selected].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
      if (sql.includes("LIMIT 1")) selected = selected.slice(0, 1);
      if (sql.includes("LIMIT 500")) selected = selected.slice(0, 500);
      return structuredClone(selected);
    }
    if (sql.startsWith("INSERT")) {
      if (sql.includes("INSERT INTO exam_question_variants") && sql.includes(" SELECT ?")) {
        const copied = rows(table).filter((r) => r.question_id === p[1]).map((r) => ({ ...r, question_id: p[0] }));
        rows(table).push(...copied);
        return { affectedRows: copied.length };
      }
      const columns = sql.match(/\(([^)]+)\)/)![1].split(",").map((s) => s.trim());
      let inserted = 0;
      let insertId = 0;
      for (let start = 0; start < p.length; start += columns.length) {
        const row = Object.fromEntries(columns.map((c, i) => [c, p[start + i]]));
        // attachBankQuestion uses a literal final is_active = 1.
        if (table === "exam_questions" && row.is_active === undefined) row.is_active = 1;
        let existing: Row | undefined;
        if (table === "exams") existing = rows(table).find((r) => r.id === row.id);
        if (table === "exam_questions" && uniqueSlots && row.exam_id != null) existing = rows(table).find((r) => r.exam_id === row.exam_id && r.sort_order === row.sort_order);
        if (table === "exam_question_variants") existing = rows(table).find((r) => r.question_id === row.question_id && r.lang === row.lang && r.set_label === row.set_label);
        if (table === "exam_enrollments" || table === "exam_courses") existing = rows(table).find((r) => r.exam_id === row.exam_id && r[table === "exam_courses" ? "course_id" : "student_uid"] === row[table === "exam_courses" ? "course_id" : "student_uid"]);
        if (existing) {
          if (sql.includes("ON DUPLICATE KEY UPDATE")) Object.assign(existing, row);
          else if (!sql.startsWith("INSERT IGNORE")) throw dbError("ER_DUP_ENTRY");
          continue;
        }
        if (!row.id && ["exam_questions", "exam_results"].includes(table)) row.id = nextId++;
        if (table === "exam_results") row.submitted_at = new Date(now).toISOString();
        rows(table).push(row);
        insertId ||= Number(row.id) || 0;
        inserted++;
      }
      return { affectedRows: inserted, insertId };
    }
    if (sql.startsWith("DELETE")) {
      const remove = (r: Row) => {
        if (sql.includes("question_id = ?")) return r.question_id === p[0];
        if (sql.includes("exam_id = ?")) return r.exam_id === p[0] && (!sql.includes("student_uid = ?") || r.student_uid === p[1]);
        if (sql.includes("id = ?")) return r.id === p[0];
        throw new Error(`Unsupported delete ${sql}`);
      };
      const removed = selected.filter(remove);
      tables[table] = selected.filter((r) => !remove(r));
      if (options.cascade && table === "exam_questions") tables.exam_question_variants = rows("exam_question_variants").filter((v) => !removed.some((r) => r.id === v.question_id));
      return { affectedRows: removed.length };
    }
    if (sql.startsWith("UPDATE")) {
      const set = sql.match(/ SET (.+?) WHERE /)?.[1];
      if (!set) throw new Error(`Unsupported update ${sql}`);
      const count = (set.match(/\?/g) ?? []).length;
      const where = sql.split(" WHERE ")[1];
      selected = selected.filter((r) => {
        if (/^id = \?/.test(where)) return r.id === p[count];
        if (/^exam_id = \?/.test(where)) return r.exam_id === p[count] && (!where.includes("student_uid = ?") || r.student_uid === p[count + 1]) && (!where.includes("status = 'active'") || r.status === "active");
        // ensureTables' legacy backfills are irrelevant to these fixtures.
        return false;
      });
      for (const row of selected) {
        let i = 0;
        for (const assignment of set.split(",")) {
          const [key, raw] = assignment.trim().split(/\s*=\s*/);
          if (raw === "?") row[key] = p[i++];
          else if (raw === "NULL") row[key] = null;
          else if (raw.startsWith("'")) row[key] = raw.slice(1, -1);
          else if (raw === "CURRENT_TIMESTAMP") row[key] = new Date(now).toISOString();
          else if (/^\d+$/.test(raw)) row[key] = Number(raw);
        }
      }
      return { affectedRows: selected.length };
    }
    throw new Error(`Unsupported SQL ${sql}`);
  }
  async function call(raw: string, params: any[] = [], channel: Call["channel"] = "pool") {
    const entry = { sql: raw.replace(/\s+/g, " ").trim(), params, channel };
    calls.push(entry);
    const failing = fault && (fault.persistent || fault.hits === 0) && fault.match(entry) ? fault : null;
    if (failing) {
      failing.hits++;
      if (!failing.after) throw failing.error;
    }
    const result = perform(entry.sql, params);
    if (gate) await gate(entry, result);
    if (failing) throw failing.error;
    return result;
  }
  const mysql = {
    query: (sql: string, p?: any[]) => call(sql, p),
    exec: (sql: string, p?: any[]) => call(sql, p),
    parseJsonColumn, ensureColumn: async () => {},
    withTransaction: async <T>(work: (connection: any) => Promise<T>): Promise<T> => {
      let release = () => {};
      if (options.serialize) {
        const previous = queue;
        queue = new Promise<void>((resolve) => { release = resolve; });
        await previous;
      }
      const before = structuredClone(tables);
      try { return await work({ query: async (sql: string, p?: any[]) => [await call(sql, p, "tx")] }); }
      catch (error) { tables = before; throw error; }
      finally { release(); }
    },
  };
  return {
    rows, mysql, calls, snapshot: () => structuredClone(tables),
    fail(match: (call: Call) => boolean, config: { after?: boolean; persistent?: boolean; error?: Error } = {}) {
      fault = { match, after: !!config.after, persistent: !!config.persistent, hits: 0, error: config.error ?? dbError() };
      return fault;
    },
    clearFault: () => { fault = null; }, setGate: (g: typeof gate) => { gate = g; },
  };
}
type DB = ReturnType<typeof database>;
function barrier(parties = 2) {
  let count = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  return async () => { if (++count === parties) release(); await ready; };
}
function adminLibrary(db: DB) {
  return load<typeof import("../src/lib/exams-admin.ts")>("src/lib/exams-admin.ts", {
    "@/lib/mysql": db.mysql, "@/lib/paste-mcq-parser": parser,
    "@/lib/exam-rules": { buildDefaultExamRules: () => [] },
    "next/cache": { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (fn: unknown) => fn },
  });
}
function variantLibrary(db: DB) {
  return load<typeof import("../src/lib/exam-variants.ts")>("src/lib/exam-variants.ts", { "@/lib/mysql": db.mysql, "@/lib/paste-mcq-parser": parser });
}
const next = { NextResponse: { json: (body: unknown, options: any = {}) => new Response(JSON.stringify(body), { status: options.status ?? 200 }) } };
function api(db: DB, path = "src/app/api/admin/exams/questions/route.ts", overrides: Row = {}) {
  return load(path, {
    "next/server": next,
    "@/lib/admin": { requireAnyPermission: async () => ({ uid: "admin" }) },
    "@/lib/administration": { logAdminAction: async () => {} },
    "@/lib/exams-admin": adminLibrary(db), "@/lib/mysql": db.mysql,
    "@/lib/exam-variants": variantLibrary(db),
    "@/lib/exam-recalculation": { snapshotAnswerKey: async () => null, recalculateIfAnswerKeyChanged: async () => ({ changed: false, recalculated: 0 }) },
    ...overrides,
  }, { console: { ...console, error: () => {} } });
}
const request = (body: any) => ({ json: async () => body, nextUrl: { searchParams: new URLSearchParams() } });
const upload = (items: Row[]) => request({ examId: "source-exam", version: "english", set: "A", questions: items });
const crossScope = { todo: "Cross-scope invariant: owning agent must integrate the fix" };
function seedCopy(db: DB) {
  db.rows("exam_questions").push(question(1), question(2));
  db.rows("exam_question_variants").push(variant(1), variant(2));
  db.rows("exam_rules").push({ exam_id: "source-exam", lang: "bangla", rule_title: "Rule", rule_text: "Text", sort_order: 1 });
  db.rows("exam_courses").push({ exam_id: "source-exam", course_id: "course-1" });
}
async function settled(work: () => Promise<any>) {
  try { return { value: await work(), error: null }; }
  catch (error) { return { value: null, error }; }
}

describe("owned duplicate POST regression", () => {
  it("does not turn a committed copy into a retryable error when auditing fails", async () => {
    const db = database(); seedCopy(db);
    let logs = 0;
    const route = api(db, "src/app/api/admin/exams/duplicate/route.ts", {
      "@/lib/administration": { logAdminAction: async () => { logs++; throw dbError(); } },
    });
    const response = await route.POST(request({ id: " source-exam " }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.exam.id);
    assert.match(body.warning, /audit log/);
    assert.equal(logs, 1);
    assert.equal(db.rows("exams").length, 2);
    assert.equal(db.rows("exam_question_variants").length, 4);
  });
  it("returns the existing success shape when auditing succeeds", async () => {
    const db = database(); seedCopy(db);
    const response = await api(db, "src/app/api/admin/exams/duplicate/route.ts").POST(request({ id: "source-exam" }));
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(await response.json()), ["exam"]);
  });
  it("propagates an uncommitted duplicate failure without claiming success", async () => {
    const db = database(); seedCopy(db);
    const fault = db.fail((c) => c.channel === "tx" && c.sql.startsWith("INSERT INTO exams"));
    const response = await api(db, "src/app/api/admin/exams/duplicate/route.ts").POST(request({ id: "source-exam" }));
    assert.equal(response.status, 400); assert.equal(fault.hits, 1);
    assert.equal(db.rows("exams").length, 1);
  });
  it("preserves auth and malformed-body guards", async () => {
    const db = database();
    const route = api(db, "src/app/api/admin/exams/duplicate/route.ts");
    for (const body of [null, {}, { id: 3 }, { id: " " }]) assert.equal((await route.POST(request(body))).status, 400);
    const denied = api(db, "src/app/api/admin/exams/duplicate/route.ts", { "@/lib/admin": { requireAnyPermission: async () => null } });
    assert.equal((await denied.POST(request({ id: "source-exam" }))).status, 401);
    assert.equal(db.rows("exams").length, 1);
  });
});

describe("exams-admin: transaction boundaries, identifiers and lost responses", () => {
  for (const step of ["INSERT INTO exams", "INSERT INTO exam_questions", "INSERT INTO exam_rules", "INSERT IGNORE INTO exam_courses"]) {
    it(`duplicateExam rolls back a hard failure at ${step}`, async () => {
      const db = database(); seedCopy(db);
      const before = db.snapshot();
      const fault = db.fail((c) => c.channel === "tx" && c.sql.startsWith(step));
      await assert.rejects(adminLibrary(db).duplicateExam("source-exam", "admin"));
      assert.equal(fault.hits, 1); assert.deepEqual(db.snapshot(), before);
    });
  }
  for (const [name, match] of [
    ["source rules read", (c: Call) => c.sql.startsWith("SELECT") && c.sql.includes("FROM exam_rules")],
    ["source course linkage read", (c: Call) => c.sql.startsWith("SELECT course_id")],
    ["variant copy", (c: Call) => c.sql.startsWith("INSERT INTO exam_question_variants")],
    ["scope mirror", (c: Call) => c.channel === "tx" && c.sql.startsWith("UPDATE exams SET type")],
    ["totals read", (c: Call) => c.channel === "tx" && c.sql.startsWith("SELECT COUNT(*)")],
    ["totals update", (c: Call) => c.channel === "tx" && c.sql.startsWith("UPDATE exams SET question_count")],
  ] as const) {
    it(`duplicateExam must not silently commit after ${name} failure`, async () => {
      const db = database(); seedCopy(db); const before = db.snapshot();
      const fault = db.fail(match);
      const result = await settled(() => adminLibrary(db).duplicateExam("source-exam", "admin"));
      assert.equal(fault.hits, 1);
      assert.deepEqual(db.snapshot(), before, `Committed incomplete copy after ${name}: ${JSON.stringify(result.value)}`);
      assert.ok(result.error);
    });
  }
  it("duplicateExam final read failure must roll back before a retry", async () => {
    const db = database(); seedCopy(db); const lib = adminLibrary(db);
    const fault = db.fail((c) => c.sql.includes("FROM exams WHERE id = ?") && c.params[0] !== "source-exam" && !c.sql.startsWith("SELECT id FROM"));
    const outcome = await settled(() => lib.duplicateExam("source-exam", "admin"));
    assert.equal(fault.hits, 1); assert.ok(outcome.error);
    assert.equal(db.rows("exams").length, 1);
    db.clearFault();
    await lib.duplicateExam("source-exam", "admin");
    assert.equal(db.rows("exams").length, 2, "Response loss + retry created two committed copies");
  });
  it("duplicate POST replay needs a durable operation key, not just a transaction", async () => {
    const db = database(); seedCopy(db); const route = api(db, "src/app/api/admin/exams/duplicate/route.ts");
    const body = { id: "source-exam", requestId: "same-upload-operation" };
    const a = await (await route.POST(request(body))).json();
    const b = await (await route.POST(request(body))).json();
    assert.equal(a.exam.id, b.exam.id);
    assert.equal(db.rows("exams").length, 2);
  });
  it("duplicateExam 64-character source ID must leave room for a unique suffix", async () => {
    const db = database(); const id = "x".repeat(64); db.rows("exams").push(exam(id));
    const copied = await adminLibrary(db).duplicateExam(id, "admin");
    assert.notEqual(copied.id, id); assert.ok(copied.id.length <= 64);
  });
  it("concurrent independent duplicates must not share a find-then-create candidate", async () => {
    const db = database({ serialize: true }); seedCopy(db); const lib = adminLibrary(db);
    await lib.fetchQuestions({ examId: "source-exam" }); // initialize before the race
    const wait = barrier();
    db.setGate(async (c) => { if (c.sql.startsWith("SELECT id FROM exams") && !c.sql.includes("FOR UPDATE")) await wait(); });
    const outcomes = await Promise.allSettled([lib.duplicateExam("source-exam", "admin"), lib.duplicateExam("source-exam", "admin")]);
    assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 2);
    assert.equal(db.rows("exams").length, 3);
  });
  for (const order of [1, 2]) {
    it(`base bulk rolls back when insert ${order} fails, then retries cleanly`, async () => {
      const db = database(); const lib = adminLibrary(db);
      const fault = db.fail((c) => c.channel === "tx" && c.sql.startsWith("INSERT INTO exam_questions") && c.params[8] === order);
      await assert.rejects(lib.saveQuestionsBulk("source-exam", [item(1), item(2)]));
      assert.equal(fault.hits, 1); assert.equal(db.rows("exam_questions").length, 0);
      db.clearFault(); await lib.saveQuestionsBulk("source-exam", [item(1), item(2)]);
      assert.equal(db.rows("exam_questions").length, 2);
    });
  }
  for (const step of ["SELECT id, exam_id, sort_order", "SELECT COUNT(*)", "UPDATE exams SET question_count"]) {
    it(`base bulk must propagate operational failure at ${step}`, async () => {
      const db = database(); const before = db.snapshot();
      const fault = db.fail((c) => c.channel === "tx" && c.sql.startsWith(step));
      const result = await settled(() => adminLibrary(db).saveQuestionsBulk("source-exam", [item(1), item(2)]));
      assert.equal(fault.hits, 1); assert.deepEqual(db.snapshot(), before); assert.ok(result.error);
    });
  }
  it("base bulk retry with null IDs and stable orders must not append duplicate slots", async () => {
    const db = database(); const lib = adminLibrary(db);
    await lib.saveQuestionsBulk("source-exam", [item(1), item(2)]);
    await lib.saveQuestionsBulk("source-exam", [item(1), item(2)]);
    assert.equal(db.rows("exam_questions").length, 2);
  });
  it("concurrent base creates must not both allocate MAX(sort_order)+1", async () => {
    const db = database({ serialize: true }); const lib = adminLibrary(db);
    await lib.fetchQuestions({ examId: "source-exam" });
    const wait = barrier(); db.setGate(async (c) => { if (c.sql.startsWith("SELECT MAX(sort_order)")) await wait(); });
    await Promise.all([1, 2].map((n) => lib.saveQuestion({ ...item(n), order: undefined, examId: "source-exam" })));
    const orders = db.rows("exam_questions").map((r) => r.sort_order);
    assert.equal(orders.length, 2); assert.equal(new Set(orders).size, orders.length);
    assert.ok(db.calls.some((c) => c.channel === "tx" && c.sql.includes("FROM exams") && c.sql.includes("FOR UPDATE")));
  });
});

describe("variant bulk API: partial writes, retries, ambiguous IDs and validation", () => {
  for (const id of [1, 2]) {
    it(`variant failure on slot ${id} must roll back the whole upload`, async () => {
      const db = database(); db.rows("exam_questions").push(question(1), question(2)); const route = api(db);
      const fault = db.fail((c) => c.sql.startsWith("INSERT INTO exam_question_variants") && c.params[0] === id);
      const response = await route.POST(upload([item(1), item(2)]));
      assert.equal(fault.hits, 1); assert.equal(response.status, 400);
      assert.equal(db.rows("exam_question_variants").length, 0, "Earlier slots survived the failed batch");
    });
  }
  it("retry against existing canonical slots overwrites cells, rather than duplicating them", async () => {
    const db = database(); db.rows("exam_questions").push(question(1), question(2)); const route = api(db);
    const fault = db.fail((c) => c.sql.startsWith("INSERT INTO exam_question_variants") && c.params[0] === 2);
    await route.POST(upload([item(1), item(2)])); assert.equal(fault.hits, 1);
    db.clearFault(); assert.equal((await route.POST(upload([item(1), item(2)]))).status, 200);
    assert.equal(db.rows("exam_questions").length, 2); assert.equal(db.rows("exam_question_variants").length, 2);
  });
  it("invalid content must be rejected before creating any empty permanent slot", async () => {
    const db = database(); const response = await api(db).POST(upload([{ ...item(1), options: [] }]));
    assert.equal(response.status, 400); assert.equal(db.rows("exam_questions").length, 0);
  });
  for (const fields of [{ id: 1 }, { order: 1 }]) {
    it(`repeated ${Object.keys(fields)[0]} must not silently overwrite while reporting saved=2`, async () => {
      const db = database(); db.rows("exam_questions").push(question(1));
      const response = await api(db).POST(upload([{ ...item(1), ...fields }, { ...item(2), ...fields }]));
      assert.equal(response.status, 400); assert.equal(db.rows("exam_question_variants").length, 0);
    });
  }
  it("concurrent missing-slot uploads must fail closed when the unique key cannot be installed", async () => {
    const db = database({ refuseUnique: true, serialize: true }); const route = api(db); const wait = barrier();
    db.setGate(async (c) => { if (c.sql.includes("WHERE exam_id = ? AND sort_order = ?") && !c.sql.includes("FOR UPDATE")) await wait(); });
    const responses = await Promise.all([route.POST(upload([item(1)])), route.POST(upload([item(1)]))]);
    assert.equal(db.rows("exam_questions").length, 1, `Created duplicate slots; statuses ${responses.map((r) => r.status)}`);
  });
  it("a successful mixed-validity response must not hide rejected items", async () => {
    const db = database(); db.rows("exam_questions").push(question(1), question(2));
    const response = await api(db).POST(upload([item(1), { ...item(2), correctIndex: -1 }]));
    assert.equal(response.status, 400); assert.equal(db.rows("exam_question_variants").length, 0);
  });
  it("question read failure must not masquerade as a successful empty editor", async () => {
    const db = database(); const route = api(db); const fault = db.fail((c) => c.sql.startsWith("SELECT * FROM exam_questions"));
    const response = await route.GET(request(null)); assert.equal(fault.hits, 1);
    assert.ok(response.status >= 500, `Read failed, but API returned ${response.status}: ${await response.text()}`);
  });
});

// Bind the actual editor handler without mounting React or changing user work.
function editorHarness(count: number, fetch: (body: any) => Promise<Response>) {
  const path = "src/components/admin/ExamPaperEditor.tsx";
  const text = source(path); const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let handler: ts.FunctionDeclaration | undefined;
  function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === "handleSaveAll") handler = node; ts.forEachChild(node, visit); }
  visit(ast); assert.ok(handler, "Editor save handler moved; update the harness");
  let questions: Row[] = []; let error: unknown; let notice: unknown;
  const scope: Row = {
    setError: (v: unknown) => { error = v; }, setNotice: (v: unknown) => { notice = v; },
    langVersion: "english", setLabel: "A", exam: { id: "source-exam", marksPerQuestion: 1 },
    drafts: Object.fromEntries(Array.from({ length: count }, (_, i) => [i, { ...item(i + 1), explanation: "", questionImage: null }])),
    displaySlots: [], authHeaders: {}, workspaceRef: { current: { v: "english", s: "A" } },
    setSaveAllBusy: () => {}, setSavingSlot: () => {}, setDrafts: () => {},
    draftGenerationRef: { current: 0 }, saveOperationRef: { current: 0 }, EMPTY_OPTIONS: ["", "", "", ""], pad: (n: number) => String(n).padStart(2, "0"),
    setQuestions: (update: (prev: Row[]) => Row[]) => { questions = update(questions); },
    loadCoverage: async () => {}, onChanged: () => {}, setTimeout: () => {}, scrollContainerRef: { current: null },
    fetch: async (_url: string, init: any) => fetch(JSON.parse(init.body)),
  };
  const js = ts.transpileModule(handler.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  const save = runInThisContext(`(function(${Object.keys(scope).join(",")}) {${js}; return handleSaveAll;})`, { filename: path })(...Object.values(scope));
  return { save, questions: () => questions, error: () => error, notice: () => notice };
}
describe("ExamPaperEditor acknowledgements (read-only handler harness)", () => {
  it("chunk 2 failure must retain chunk 1 acknowledgements and IDs", async () => {
    let chunks = 0;
    const editor = editorHarness(201, async (body) => ++chunks === 1
      ? next.NextResponse.json({ saved: 200, savedIds: body.questions.map((_: unknown, i: number) => i + 1) })
      : next.NextResponse.json({ error: "Injected second chunk failure" }, { status: 400 }));
    await editor.save(); assert.equal(chunks, 2); assert.match(String(editor.error()), /second chunk/);
    assert.equal(editor.questions().filter((q) => q?.id).length, 200);
  });
  it("partial HTTP 200 must not mark rejected drafts as saved", async () => {
    const editor = editorHarness(2, async () => next.NextResponse.json({ saved: 1, errors: [{ index: 1, error: "Rejected slot" }] }));
    await editor.save();
    assert.equal(editor.questions().filter((q) => q?.hasVariant).length, 1);
    assert.match(String(editor.error()), /Rejected slot/);
  });
});

function takingHarness(db: DB) {
  const variants = variantLibrary(db);
  const publicExam = { id: "source-exam", title: "Test", kind: "practice", examMode: "practice", status: "published", durationMinutes: 30, courseType: "Academic" };
  return load<typeof import("../src/lib/exam-taking.ts")>("src/lib/exam-taking.ts", {
    "@/lib/mysql": db.mysql, "@/lib/exam-variants": variants,
    "@/lib/paste-mcq-parser": parser, "@/lib/exam-result-language": language,
    "@/lib/exams-admin": { fetchExams: async () => [publicExam], fetchExamById: async () => publicExam },
    "@/lib/exam-lifecycle": { isPublicPostLivePractice: () => false },
    "@/lib/enrolled-exam-lifecycle": { isEnrolledExam: async () => false },
  });
}
function seedAttempt(db: DB) {
  seedCopy(db);
  db.rows("exam_attempts").push({ exam_id: "source-exam", student_uid: "student", session_token: "session-1", status: "active", timer_type: "first", question_version: "english", assigned_set: "A", question_order: "[1,2]", started_at: new Date(now - 60_000).toISOString(), expires_at: new Date(now + 60_000).toISOString() });
  db.rows("exam_attempt_answers").push({ exam_id: "source-exam", student_uid: "student", question_id: 1, option_index: 0 });
}
describe("attempt result atomicity and historical detail integrity", () => {
  for (const step of ["INSERT INTO exam_enrollments", "UPDATE exam_attempts SET status", "INSERT INTO exam_results", "DELETE FROM exam_attempt_answers"]) {
    it(`submit failure at ${step} must remain safely retryable`, async () => {
      const db = database({ serialize: true }); seedAttempt(db); const taking = takingHarness(db);
      const fault = db.fail((c) => c.sql.startsWith(step), { persistent: true });
      const outcome = await settled(() => taking.submitExamAttempt("source-exam", "student", "Student", { 2: 0 }));
      assert.ok(fault.hits > 0); assert.ok(outcome.error);
      assert.equal(db.rows("exam_results").length, 0);
      assert.equal(db.rows("exam_attempts")[0].status, "active");
      assert.equal(db.rows("exam_attempt_answers").length, 1);
      db.clearFault(); assert.ok(await taking.submitExamAttempt("source-exam", "student", "Student", { 2: 0 }));
      assert.equal(db.rows("exam_results").length, 1);
      assert.equal(db.rows("exam_attempts")[0].status, "submitted");
    });
  }
  it("concurrent submitters persist exactly one result and replay it", async () => {
    const db = database({ serialize: true }); seedAttempt(db); const taking = takingHarness(db);
    const outcomes = await Promise.all([taking.submitExamAttempt("source-exam", "student", "Student", { 2: 0 }), taking.submitExamAttempt("source-exam", "student", "Student", { 2: 0 })]);
    assert.equal(db.rows("exam_results").length, 1); assert.ok(outcomes.every(Boolean));
    assert.equal(outcomes[0]?.score, outcomes[1]?.score);
  });
  it("operational insert failure must not invoke a lossy schema fallback", async () => {
    const db = database({ serialize: true }); seedAttempt(db); const taking = takingHarness(db);
    const fault = db.fail((c) => c.sql.startsWith("INSERT INTO exam_results"));
    const outcome = await settled(() => taking.submitExamAttempt("source-exam", "student", "Student", { 2: 0 }));
    assert.equal(fault.hits, 1); assert.ok(outcome.error);
    assert.equal(db.calls.filter((c) => c.sql.startsWith("INSERT INTO exam_results")).length, 1);
    assert.equal(db.rows("exam_results").length, 0);
  });
  it("deleting a question must retain its grading-time detail in the result script", async () => {
    const db = database({ serialize: true, cascade: true }); seedAttempt(db); const taking = takingHarness(db);
    await taking.submitExamAttempt("source-exam", "student", "Student", { 2: 0 });
    await adminLibrary(db).deleteQuestion(1);
    const script = await taking.getExamResultScript("source-exam", "student");
    assert.ok(script); assert.equal(script.questions.length, 2);
    assert.equal(script.questions.find((q) => q.questionId === 1)?.obtained, 1);
  });
  it("legacy deletion must roll back when explicit variant cleanup fails", async () => {
    const db = database(); seedCopy(db); const before = db.snapshot();
    const fault = db.fail((c) => c.sql.startsWith("DELETE FROM exam_question_variants"));
    const outcome = await settled(() => adminLibrary(db).deleteQuestion(1));
    assert.equal(fault.hits, 1); assert.deepEqual(db.snapshot(), before); assert.ok(outcome.error);
  });
});

describe("mysql exec: ambiguous write acknowledgement", () => {
  it("must not blindly repeat a non-idempotent insert after a lost ACK", async () => {
    let writes = 0;
    const mysql = load("src/lib/mysql.ts", {
      "mysql2/promise": { default: { createPool: () => ({ on: () => {}, query: async () => {
        writes++;
        if (writes === 1) throw dbError("PROTOCOL_CONNECTION_LOST"); // server committed, ACK lost
        return [{ affectedRows: 1, insertId: writes }];
      } }) } },
    }, {
      process: { env: { MYSQL_HOST: "mock.invalid", MYSQL_DATABASE: "mock", MYSQL_USER: "mock", MYSQL_SSL: "false" } },
      setTimeout: (fn: () => void) => { fn(); },
    });
    const outcome = await settled(() => mysql.exec("INSERT INTO exam_questions (question) VALUES (?)", ["Question"]));
    assert.ok(writes > 0, `Mock was not reached: ${outcome.error}`);
    assert.equal(writes, 1, "The same insert was executed twice after an ambiguous connection failure");
  });
});
