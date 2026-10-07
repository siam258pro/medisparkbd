import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { strictAnswerIndex } from "../src/lib/paste-mcq-parser.ts";
import type * as Storage from "../src/lib/exams-admin.ts";

// Mock the MySQL/auth adapters; execute transaction SQL against SQLite in
// memory so rollback assertions exercise persisted state, not just call order.
const nativeRequire = createRequire(import.meta.url);
type Row = Record<string, unknown>;
type Database = {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): Row[];
    run(...params: unknown[]): { lastInsertRowid: number | bigint; changes: number };
  };
};
const { DatabaseSync } = nativeRequire("node:sqlite") as { DatabaseSync: new (path: string) => Database };

function load<T>(path: string, dependencies: Record<string, unknown>): T {
  const source = readFileSync(new URL("../" + path, import.meta.url), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: path,
  }).outputText;
  const module = { exports: {} };
  runInNewContext(code, {
    module, exports: module.exports, Error, console,
    require(name: string) {
      assert.ok(Object.hasOwn(dependencies, name), "Unexpected dependency: " + name);
      return dependencies[name];
    },
  }, { filename: path });
  return module.exports as T;
}

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE exams (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, banner_url TEXT,
      kind TEXT DEFAULT 'public', exam_mode TEXT DEFAULT 'live', batch_id TEXT DEFAULT '',
      subject TEXT DEFAULT '', chapter_id TEXT, sort_order INTEGER DEFAULT 0,
      course_type TEXT DEFAULT 'Academic', exam_format TEXT, topic_subject TEXT,
      duration_minutes INTEGER DEFAULT 30, total_marks REAL DEFAULT 0,
      marks_per_question REAL DEFAULT 1, negative_marks REAL DEFAULT 0,
      negative_enabled INTEGER DEFAULT 0, negative_per_wrong REAL DEFAULT 0.25,
      second_timer_enabled INTEGER DEFAULT 0, second_timer_deduction REAL DEFAULT 3,
      question_count INTEGER DEFAULT 0, status TEXT DEFAULT 'draft', featured INTEGER DEFAULT 0,
      scheduled_at TEXT, ends_at TEXT, answer_key TEXT, category_id TEXT, rule_template TEXT,
      created_by TEXT, archived INTEGER DEFAULT 0, type TEXT DEFAULT 'public'
    );
    CREATE TABLE exam_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, exam_id TEXT, bank_subject TEXT DEFAULT '',
      question TEXT NOT NULL DEFAULT '', question_image TEXT, options TEXT DEFAULT '["","","",""]',
      correct_index INTEGER DEFAULT 0, explanation TEXT, marks REAL DEFAULT 1,
      sort_order INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1
    );
    CREATE TABLE exam_question_variants (
      id INTEGER PRIMARY KEY AUTOINCREMENT, question_id INTEGER, lang TEXT, set_label TEXT,
      question TEXT, options TEXT, correct_index INTEGER, explanation TEXT, marks REAL, question_image TEXT
    );
    CREATE TABLE exam_question_options (question_id INTEGER, option_text TEXT);
    CREATE TABLE question_translations (question_id INTEGER, question_text TEXT);
    CREATE TABLE exam_courses (exam_id TEXT, course_id TEXT, PRIMARY KEY (exam_id, course_id));
    CREATE TABLE exam_rules (id INTEGER PRIMARY KEY AUTOINCREMENT, exam_id TEXT, lang TEXT DEFAULT 'bangla', rule_title TEXT, rule_text TEXT, sort_order INTEGER);
    CREATE TABLE exam_rule_template_items (template TEXT, lang TEXT, rule_title TEXT, rule_text TEXT, sort_order INTEGER);
    CREATE TABLE exam_results (id INTEGER PRIMARY KEY, exam_id TEXT, details TEXT);
    CREATE TABLE exam_attempts (exam_id TEXT, question_order TEXT);
    CREATE TABLE exam_attempt_answers (exam_id TEXT, question_id INTEGER);
    CREATE TABLE exam_sessions (exam_id TEXT);
    CREATE TABLE exam_rankings (exam_id TEXT);
    CREATE TABLE exam_sets (exam_id TEXT);
    CREATE TABLE exam_enrollments (exam_id TEXT);
    CREATE TABLE course_categories (id TEXT, name TEXT, slug TEXT);
  `);
  const trace: { sql: string; params: unknown[]; transaction: boolean }[] = [];
  const stats = { committed: 0, rolledBack: 0 };
  let transaction = false;
  let fail: ((sql: string, params: unknown[]) => Error | null) | null = null;
  let omitInsertId = false;
  const execute = async (sql: string, params: unknown[] = []) => {
    trace.push({ sql, params: [...params], transaction });
    const failure = fail?.(sql, params);
    if (failure) throw failure;
    let adapted = sql.replace(/\s+FOR UPDATE\b/gi, "").replace(/INSERT IGNORE/gi, "INSERT OR IGNORE");
    adapted = adapted.replace(/ON DUPLICATE KEY UPDATE/i, "ON CONFLICT(id) DO UPDATE SET")
      .replace(/VALUES\((\w+)\)/g, "excluded.$1");
    adapted = adapted.replace(/DELETE child FROM (\w+) child INNER JOIN exam_questions q ON q\.id = child\.question_id WHERE q\.exam_id = \?/,
      "DELETE FROM $1 WHERE question_id IN (SELECT id FROM exam_questions WHERE exam_id = ?)");
    try {
      const statement = db.prepare(adapted);
      if (/^\s*SELECT/i.test(adapted)) return statement.all(...params);
      const result = statement.run(...params);
      return { affectedRows: result.changes, insertId: omitInsertId ? undefined : Number(result.lastInsertRowid) };
    } catch (error) {
      if (error instanceof Error && /no such table/.test(error.message)) {
        throw Object.assign(error, { code: "ER_NO_SUCH_TABLE" });
      }
      throw error;
    }
  };
  const mysql = {
    query: execute,
    exec: async (sql: string) => { trace.push({ sql, params: [], transaction }); return { affectedRows: 1 }; },
    ensureColumn: async () => undefined,
    parseJsonColumn: (value: unknown) => typeof value === "string" ? JSON.parse(value) : value,
    withTransaction: async <T>(work: (connection: { query: (sql: string, params?: unknown[]) => Promise<unknown[]> }) => Promise<T>): Promise<T> => {
      assert.equal(transaction, false, "No nested transaction/pool writes");
      transaction = true;
      db.exec("BEGIN");
      try {
        const result = await work({ query: async (sql, params) => [await execute(sql, params), []] });
        db.exec("COMMIT");
        stats.committed += 1;
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        stats.rolledBack += 1;
        throw error;
      } finally { transaction = false; }
    },
  };
  const storage = load<typeof Storage>("src/lib/exams-admin.ts", {
    "@/lib/mysql": mysql,
    "@/lib/paste-mcq-parser": { strictAnswerIndex },
    "@/lib/exam-rules": { buildDefaultExamRules: (_id: string, _template: string, lang: string) => [{ title: lang, text: lang + " default", sortOrder: 1 }] },
    "@/lib/exam-rule-templates": { normalizeTemplate: (value: unknown) => value ?? "academic", normalizeLang: (value: unknown) => value },
    "next/cache": { revalidateTag: () => undefined, revalidatePath: () => undefined, unstable_cache: (fn: unknown) => fn },
    "node:crypto": nativeRequire("node:crypto"),
    "@/lib/notification-events": { notifyPublicExamPublished: async () => undefined },
  });
  const exam = (id = "exam-one", count = 2) => {
    db.prepare("INSERT INTO exams (id, title, question_count, total_marks) VALUES (?, ?, ?, ?)").run(id, "Exam title", count, count);
  };
  const question = (id: number, examId: string | null = "exam-one", order = id, active = 1, text = "Question text") => {
    db.prepare("INSERT INTO exam_questions (id, exam_id, sort_order, is_active, question, options) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, examId, order, active, text, text ? '["One","Two","Three","Four"]' : '["","","",""]');
  };
  const variant = (id: number, lang = "english", set = "B") => {
    db.prepare("INSERT INTO exam_question_variants (question_id, lang, set_label, question, options, correct_index, marks) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, lang, set, "Variant text", '["One","Two","Three","Four"]', 2, 1);
  };
  const rows = (table: string) => db.prepare("SELECT * FROM " + table).all();
  return { storage, db, trace, stats, exam, question, variant, rows,
    setFailure: (fn: typeof fail) => { fail = fn; },
    omitInsertId: () => { omitInsertId = true; },
  };
}

const valid = (extra: Record<string, unknown> = {}) => ({ question: "Updated question", options: ["One", "Two", "Three", "Four"], correctIndex: 2, marks: 1, ...extra });
const dbError = (code = "ER_LOCK_DEADLOCK") => Object.assign(new Error("Injected database failure"), { code });

function route(path: string, storage: Partial<typeof Storage>, authorized = true) {
  return load<{ POST: (request: unknown) => Promise<{ status: number; data: Row }>; DELETE: (request: unknown) => Promise<{ status: number; data: Row }> }>(path, {
    "next/server": { NextResponse: { json: (data: Row, options?: { status?: number }) => ({ data, status: options?.status ?? 200 }) } },
    "@/lib/admin": { requireAnyPermission: async () => authorized ? { uid: "admin" } : null },
    "@/lib/administration": { logAdminAction: async () => undefined },
    "@/lib/exams-admin": storage,
  });
}
const request = (body: unknown) => ({ json: async () => body });

describe("admin exam storage audit", () => {
  it("bulk edits reuse permanent slot IDs when uploaded by order", async () => {
    const f = fixture(); f.exam(); f.question(11, "exam-one", 1, 1, ""); f.question(12, "exam-one", 2, 1, ""); f.variant(11);
    const result = await f.storage.saveQuestionsBulk("exam-one", [valid({ order: 1 }), valid({ order: 2 })]);
    assert.deepEqual(Array.from(result.savedIds), [11, 12]);
    assert.equal(f.rows("exam_questions").length, 2);
    assert.equal(f.rows("exam_question_variants")[0].question_id, 11);
    assert.equal(f.rows("exams")[0].question_count, 2);
  });

  it("rejects a foreign permanent question ID instead of moving it", async () => {
    const f = fixture(); f.exam(); f.exam("exam-two"); f.question(1, "exam-two");
    await assert.rejects(f.storage.saveQuestionsBulk("exam-one", [valid({ id: 1 })]), /does not belong/);
    assert.equal(f.rows("exam_questions")[0].exam_id, "exam-two");
    assert.equal(f.stats.rolledBack, 1);
  });

  it("rejects single-question moves out of an exam into the bank", async () => {
    const f = fixture(); f.exam(); f.question(1);
    await assert.rejects(f.storage.saveQuestion(valid({ id: 1 })), /does not belong/);
    assert.equal(f.rows("exam_questions")[0].exam_id, "exam-one");
  });

  it("rejects nonexistent target exams before question insertion", async () => {
    const f = fixture();
    await assert.rejects(f.storage.saveQuestionsBulk("missing-exam", [valid()]), /Exam not found/);
    assert.equal(f.rows("exam_questions").length, 0);
  });

  it("rejects duplicate IDs, duplicate orders, and aliased slot IDs", async () => {
    const f = fixture(); f.exam(); f.question(7, "exam-one", 1);
    for (const items of [[valid({ id: 7 }), valid({ id: 7 })], [valid({ order: 1 }), valid({ order: 1 })], [valid({ id: 7 }), valid({ order: 1 })]]) {
      await assert.rejects(f.storage.saveQuestionsBulk("exam-one", items), /Duplicate|more than once/);
    }
    assert.equal(f.rows("exam_questions")[0].question, "Question text");
  });

  it("rejects malformed IDs/orders, empty options and out-of-range marks", async () => {
    const f = fixture(); f.exam();
    for (const extra of [{ id: "bad" }, { id: 0 }, { order: 1.5 }, { order: 501 }, { marks: -1 }, { marks: 101 }, { marks: "bad" }, { options: ["One", " "] }, { correctIndex: "" }]) {
      await assert.rejects(f.storage.saveQuestionsBulk("exam-one", [valid(extra)]));
    }
    assert.equal(f.rows("exam_questions").length, 0);
  });

  it("keeps normalized answers and returned IDs aligned with input order", async () => {
    const f = fixture(); f.exam(); f.question(8, "exam-one", 1); f.question(9, "exam-one", 2);
    const result = await f.storage.saveQuestionsBulk("exam-one", [valid({ id: 9, correctIndex: "2" }), valid({ id: 8, correctIndex: "1" })]);
    assert.deepEqual(Array.from(result.savedIds), [9, 8]);
    assert.equal(f.rows("exam_questions")[0].correct_index, 1);
  });

  it("rolls back every bulk edit when totals fail", async () => {
    const f = fixture(); f.exam(); f.question(1);
    f.setFailure((sql) => sql.startsWith("UPDATE exams SET question_count") ? dbError() : null);
    await assert.rejects(f.storage.saveQuestionsBulk("exam-one", [valid({ id: 1 }), valid()]));
    assert.equal(f.rows("exam_questions").length, 1);
    assert.equal(f.rows("exam_questions")[0].question, "Question text");
    assert.equal(f.stats.committed, 0);
  });

  it("rolls back a single save when totals fail", async () => {
    const f = fixture(); f.exam(); f.question(1);
    f.setFailure((sql) => sql.startsWith("UPDATE exams SET question_count") ? dbError() : null);
    await assert.rejects(f.storage.saveQuestion(valid({ id: 1, examId: "exam-one" })));
    assert.equal(f.rows("exam_questions")[0].question, "Question text");
    assert.equal(f.stats.rolledBack, 1);
  });

  it("does not fabricate saved IDs when the driver omits insertId", async () => {
    const f = fixture(); f.exam(); f.omitInsertId();
    await assert.rejects(f.storage.saveQuestionsBulk("exam-one", [valid()]), /saved question id/);
    assert.equal(f.rows("exam_questions").length, 0);
  });

  it("rejects an occupied slot reorder during save", async () => {
    const f = fixture(); f.exam(); f.question(1); f.question(2);
    await assert.rejects(f.storage.saveQuestionsBulk("exam-one", [valid({ id: 1, order: 2 })]), /occupied/);
    assert.deepEqual(f.rows("exam_questions").map((row) => row.sort_order), [1, 2]);
  });

  it("creates an exam, slots, language rules and totals in one transaction", async () => {
    const f = fixture();
    const result = await f.storage.saveExam({ id: "new-exam", title: "New exam", questionCount: 3, marksPerQuestion: 2 }, "admin");
    assert.equal(result.questionCount, 3); assert.equal(result.totalMarks, 6);
    assert.equal(f.rows("exam_questions").length, 3);
    assert.deepEqual(f.rows("exam_rules").map((row) => row.lang), ["bangla", "english"]);
    assert.equal(f.stats.committed, 1);
    assert.ok(f.trace.filter((entry) => /INSERT INTO exam_questions|INSERT INTO exam_rules|INSERT INTO exams/.test(entry.sql)).every((entry) => entry.transaction));
  });

  it("fresh question schema includes image and sort columns before use", async () => {
    const f = fixture(); await f.storage.saveQuestion(valid());
    const ddl = f.trace.find((entry) => entry.sql.startsWith("CREATE TABLE IF NOT EXISTS exam_questions"))?.sql ?? "";
    assert.match(ddl, /question_image/); assert.match(ddl, /sort_order/);
  });

  it("rolls back exam creation when slot insertion fails", async () => {
    const f = fixture(); f.setFailure((sql) => sql.startsWith("INSERT INTO exam_questions") ? dbError() : null);
    await assert.rejects(f.storage.saveExam({ id: "new-exam", title: "New exam", questionCount: 3 }, "admin"));
    assert.equal(f.rows("exams").length, 0); assert.equal(f.rows("exam_rules").length, 0);
  });

  it("does not retry default rule seeding over partially inserted rules", async () => {
    const f = fixture(); f.setFailure((sql, params) => sql.startsWith("INSERT INTO exam_rules") && params[1] === "english" ? dbError() : null);
    await assert.rejects(f.storage.saveExam({ id: "new-exam", title: "New exam", questionCount: 1 }, "admin"));
    assert.equal(f.rows("exams").length, 0); assert.equal(f.rows("exam_rules").length, 0);
  });

  it("partial config edits preserve keys, mode, linkage, grading and order", async () => {
    const f = fixture(); f.exam(); f.question(1); f.question(2);
    f.db.exec(`UPDATE exams SET kind = 'enrolled', exam_mode = 'practice', status = 'closed', sort_order = 9,
      answer_key = '{"1":2}', negative_enabled = 1, second_timer_enabled = 1, second_timer_deduction = 7,
      description = 'Keep description', featured = 1 WHERE id = 'exam-one';
      INSERT INTO exam_courses VALUES ('exam-one', 'biology');`);
    const result = await f.storage.saveExam({ id: "exam-one", title: "Renamed exam" }, "admin");
    assert.equal(result.kind, "enrolled"); assert.equal(result.examMode, "practice"); assert.equal(result.sortOrder, 9);
    assert.equal(result.answerKey?.["1"], 2); assert.equal(result.secondTimerDeduction, 7);
    assert.equal(result.description, "Keep description"); assert.equal(result.featured, true);
    assert.deepEqual(Array.from(result.courseIds), ["biology"]);
  });

  it("legacy count aliases override stored camelCase defaults", async () => {
    const f = fixture(); f.exam(); f.question(1); f.question(2);
    await f.storage.saveExam({ id: "exam-one", question_count: 1 }, "admin");
    assert.equal(f.rows("exams")[0].question_count, 1);
    assert.equal(f.rows("exam_questions")[1].is_active, 0);
  });

  it("zero questions deactivates slots without deleting history or variants", async () => {
    const f = fixture(); f.exam(); f.question(1); f.question(2); f.variant(1);
    f.db.exec(`INSERT INTO exam_results VALUES (1, 'exam-one', '[{"questionId":1}]')`);
    const result = await f.storage.saveExam({ id: "exam-one", questionCount: 0 }, "admin");
    assert.equal(result.questionCount, 0); assert.equal(result.totalMarks, 0);
    assert.equal(f.rows("exam_questions").length, 2); assert.ok(f.rows("exam_questions").every((row) => row.is_active === 0));
    assert.equal(f.rows("exam_question_variants").length, 1); assert.equal(f.rows("exam_results").length, 1);
  });

  it("rejects fractional, negative and unbounded configured totals", async () => {
    for (const count of [1.5, -1, 501, "bad", Infinity]) {
      const f = fixture(); await assert.rejects(f.storage.saveExam({ id: "new-exam", title: "New exam", questionCount: count }, "admin"));
      assert.equal(f.rows("exams").length, 0);
    }
  });

  it("slot creation rejects duplicate orders and nonexistent parents", async () => {
    const f = fixture(); f.exam(); f.question(1, "exam-one", 1); f.question(2, "exam-one", 1);
    await assert.rejects(f.storage.ensureQuestionSlots("exam-one", 2), /Duplicate/);
    await assert.rejects(f.storage.ensureQuestionSlots("missing-exam", 1), /not found/);
    assert.equal(f.rows("exam_questions").length, 2);
  });

  it("slot creation failure is visible and rolls back", async () => {
    const f = fixture(); f.exam(); f.setFailure((sql) => sql.startsWith("INSERT INTO exam_questions") ? dbError() : null);
    await assert.rejects(f.storage.ensureQuestionSlots("exam-one", 2));
    assert.equal(f.rows("exam_questions").length, 0);
  });

  it("duplicate exams reserve a unique suffix for 64-character IDs", async () => {
    const f = fixture(); const source = "x".repeat(64); f.exam(source); f.question(1, source); f.variant(1);
    f.db.exec("INSERT INTO exam_rules (exam_id, lang, rule_title, rule_text, sort_order) VALUES ('" + source + "', 'english', 'English', 'Keep language', 1)");
    const copy = await f.storage.duplicateExam(source, "admin");
    assert.notEqual(copy.id, source); assert.equal(copy.id.length, 64); assert.match(copy.id, /-copy-/);
    assert.equal(copy.status, "draft"); assert.equal(copy.featured, false); assert.equal(copy.scheduledAt, null); assert.equal(copy.answerKey, null);
    const newQuestion = f.rows("exam_questions").find((row) => row.exam_id === copy.id)!;
    assert.notEqual(newQuestion.id, 1);
    assert.ok(f.rows("exam_question_variants").some((row) => row.question_id === newQuestion.id));
    assert.equal(f.rows("exam_rules").find((row) => row.exam_id === copy.id)?.lang, "english");
  });

  it("variant copy failure rolls back the whole exam duplicate", async () => {
    const f = fixture(); f.exam(); f.question(1); f.variant(1);
    f.setFailure((sql) => sql.startsWith("INSERT INTO exam_question_variants") ? dbError() : null);
    await assert.rejects(f.storage.duplicateExam("exam-one", "admin"));
    assert.equal(f.rows("exams").length, 1); assert.equal(f.rows("exam_questions").length, 1);
  });

  it("bank attachment copies variant cells and totals atomically", async () => {
    const f = fixture(); f.exam(); f.question(1, null); f.variant(1);
    await f.storage.attachBankQuestion(1, "exam-one");
    assert.equal(f.rows("exam_questions")[0].exam_id, null);
    const attached = f.rows("exam_questions").find((row) => row.exam_id === "exam-one")!;
    assert.ok(f.rows("exam_question_variants").some((row) => row.question_id === attached.id));
    assert.equal(f.rows("exams")[0].question_count, 1);
  });

  it("question duplicate variant failure does not leave a base-only copy", async () => {
    const f = fixture(); f.exam(); f.question(1); f.variant(1);
    f.setFailure((sql) => sql.startsWith("INSERT INTO exam_question_variants") ? dbError() : null);
    await assert.rejects(f.storage.duplicateQuestion(1));
    assert.equal(f.rows("exam_questions").length, 1);
  });

  it("reordering a subset preserves untouched slots and rejects foreign IDs", async () => {
    const f = fixture(); f.exam(); f.question(1); f.question(2); f.question(3);
    await f.storage.reorderQuestions("exam-one", [3, 1]);
    assert.deepEqual(f.rows("exam_questions").map((row) => row.sort_order), [3, 2, 1]);
    await assert.rejects(f.storage.reorderQuestions("exam-one", [999]), /does not belong/);
    await assert.rejects(f.storage.reorderQuestions("exam-one", [1, 1]), /duplicate/);
  });

  it("deletion preserves permanent IDs needed by result details", async () => {
    const f = fixture(); f.exam(); f.question(1); f.variant(1);
    f.db.exec(`INSERT INTO exam_results VALUES (1, 'exam-one', '[{"questionId":1}]')`);
    await f.storage.deleteQuestion(1);
    assert.equal(f.rows("exam_questions")[0].is_active, 0); assert.equal(f.rows("exam_question_variants").length, 1);
    assert.equal(f.rows("exams")[0].total_marks, 0); assert.equal(f.rows("exam_results").length, 1);
  });

  it("deletion preserves locked attempt question IDs", async () => {
    const f = fixture(); f.exam(); f.question(1); f.db.exec(`INSERT INTO exam_attempts VALUES ('exam-one', '[1]')`);
    await f.storage.deleteQuestion(1);
    assert.equal(f.rows("exam_questions")[0].is_active, 0); assert.equal(f.rows("exam_attempts").length, 1);
  });

  it("unreferenced question deletion cleans legacy children and rolls back on failure", async () => {
    const f = fixture(); f.exam(); f.question(1); f.variant(1);
    f.db.exec("INSERT INTO question_translations VALUES (1, 'Translation'); INSERT INTO exam_question_options VALUES (1, 'Option')");
    f.setFailure((sql) => sql.startsWith("DELETE FROM exam_questions") ? dbError() : null);
    await assert.rejects(f.storage.deleteQuestion(1));
    assert.equal(f.rows("exam_question_variants").length, 1);
    f.setFailure(null); await f.storage.deleteQuestion(1);
    for (const table of ["exam_questions", "exam_question_variants", "question_translations", "exam_question_options"]) assert.equal(f.rows(table).length, 0);
    assert.equal(f.rows("exams")[0].question_count, 0);
  });

  it("hard-delete removes every dependent record, without relying on FKs", async () => {
    const f = fixture(); f.exam(); f.question(1); f.variant(1);
    f.db.exec(`INSERT INTO question_translations VALUES (1, 'Translation'); INSERT INTO exam_question_options VALUES (1, 'Option');
      INSERT INTO exam_results VALUES (1, 'exam-one', '[{"questionId":1}]');
      INSERT INTO exam_attempts VALUES ('exam-one', '[1]'); INSERT INTO exam_attempt_answers VALUES ('exam-one', 1);
      INSERT INTO exam_sessions VALUES ('exam-one'); INSERT INTO exam_rankings VALUES ('exam-one');
      INSERT INTO exam_sets VALUES ('exam-one'); INSERT INTO exam_enrollments VALUES ('exam-one');
      INSERT INTO exam_courses VALUES ('exam-one', 'biology'); INSERT INTO exam_rules (exam_id) VALUES ('exam-one');`);
    await f.storage.deleteExam("exam-one");
    for (const table of ["exams", "exam_questions", "exam_question_variants", "question_translations", "exam_question_options", "exam_results", "exam_attempts", "exam_attempt_answers", "exam_sessions", "exam_rankings", "exam_sets", "exam_enrollments", "exam_courses", "exam_rules"]) {
      assert.equal(f.rows(table).length, 0, table);
    }
  });

  it("hard-delete rolls back all child cleanup on a real database failure", async () => {
    const f = fixture(); f.exam(); f.question(1); f.variant(1);
    f.setFailure((sql) => sql.startsWith("DELETE FROM exam_courses") ? dbError() : null);
    await assert.rejects(f.storage.deleteExam("exam-one"));
    assert.equal(f.rows("exams").length, 1); assert.equal(f.rows("exam_questions").length, 1); assert.equal(f.rows("exam_question_variants").length, 1);
  });

  it("missing optional legacy tables are tolerated, not arbitrary DB errors", async () => {
    const f = fixture(); f.exam(); f.question(1); f.db.exec("DROP TABLE exam_question_variants; DROP TABLE exam_rules; DROP TABLE exam_attempts");
    await f.storage.deleteExam("exam-one"); assert.equal(f.rows("exams").length, 0);
  });

  it("archive updates flag/status together and preserves all question/history rows", async () => {
    const f = fixture(); f.exam(); f.question(1); f.variant(1); f.db.exec("INSERT INTO exam_results VALUES (1, 'exam-one', '[]')");
    await f.storage.archiveExam("exam-one", true);
    assert.equal(f.rows("exams")[0].archived, 1); assert.equal(f.rows("exams")[0].status, "closed");
    await f.storage.archiveExam("exam-one", false);
    assert.equal(f.rows("exams")[0].archived, 0); assert.equal(f.rows("exams")[0].status, "draft");
    assert.equal(f.rows("exam_questions").length, 1); assert.equal(f.rows("exam_question_variants").length, 1); assert.equal(f.rows("exam_results").length, 1);
  });

  it("archive does not mask connection failure as a successful legacy fallback", async () => {
    const f = fixture(); f.exam(); f.setFailure((sql) => sql.startsWith("UPDATE exams SET archived") ? dbError("ECONNRESET") : null);
    await assert.rejects(f.storage.archiveExam("exam-one", true));
    assert.equal(f.rows("exams")[0].archived, 0); assert.equal(f.rows("exams")[0].status, "draft");
  });
});

describe("admin storage routes with mocked authorization", () => {
  it("unauthorized deletes never call storage", async () => {
    let called = false;
    const api = route("src/app/api/admin/exams/questions/route.ts", { deleteQuestion: async () => { called = true; } }, false);
    assert.equal((await api.DELETE(request({ id: 1 }))).status, 401); assert.equal(called, false);
  });

  it("question DELETE rejects non-positive IDs and reports storage failures", async () => {
    const api = route("src/app/api/admin/exams/questions/route.ts", { deleteQuestion: async () => { throw new Error("Rollback required"); } });
    assert.equal((await api.DELETE(request({ id: 0 }))).status, 400);
    const response = await api.DELETE(request({ id: 1 })); assert.equal(response.status, 400); assert.equal(response.data.error, "Rollback required");
  });

  it("archive route rejects truthy strings and does not retry failed writes", async () => {
    let calls = 0;
    const api = route("src/app/api/admin/exams/archive/route.ts", { archiveExam: async () => { calls += 1; throw new Error("Storage failure"); } });
    assert.equal((await api.POST(request({ id: "exam-one", archived: "false" }))).status, 400); assert.equal(calls, 0);
    const response = await api.POST(request({ id: "exam-one", archived: true })); assert.equal(response.status, 400); assert.equal(calls, 1);
  });

  it("exam DELETE reports transactional failure as a failed request", async () => {
    const api = route("src/app/api/admin/exams/route.ts", { deleteExam: async () => { throw new Error("Cleanup failed"); } });
    const response = await api.DELETE(request({ id: "exam-one" })); assert.equal(response.status, 400); assert.equal(response.data.error, "Cleanup failed");
  });
});
