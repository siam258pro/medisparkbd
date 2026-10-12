import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
type Value = string | number | null;
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { all(...params: Value[]): Record<string, unknown>[]; run(...params: Value[]): unknown };
    close(): void;
  };
};
const NOW = Date.parse("2026-10-12T08:00:00.000Z");
const PAST = "2026-10-11T10:00:00.000Z";
const FUTURE = "2026-10-13T10:00:00.000Z";
const ENDED = "2026-10-10T10:00:00.000Z";
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

function loadModule<T>(path: string, imports: Record<string, unknown>): T {
  const code = ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  runInNewContext(code, {
    module: loaded, exports: loaded.exports, Date,
    console: { error: () => undefined },
    require: (name: string) => {
      assert.ok(Object.hasOwn(imports, name), `Unexpected dependency: ${name}`);
      return imports[name];
    },
  }, { filename: path });
  return loaded.exports as T;
}

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE course_subjects (id TEXT PRIMARY KEY, name TEXT, is_active INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0);
    CREATE TABLE course_subject_assignments (subject_id TEXT, course_slug TEXT, sort_order INTEGER DEFAULT 0,
      PRIMARY KEY(subject_id, course_slug));
    CREATE TABLE course_papers (id TEXT PRIMARY KEY, subject_id TEXT, is_active INTEGER DEFAULT 1);
    CREATE TABLE course_chapters (id TEXT PRIMARY KEY, subject_id TEXT, paper_id TEXT, course_slug TEXT,
      name TEXT DEFAULT 'Chapter', content_type TEXT DEFAULT 'exam', is_active INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0);
    CREATE TABLE exam_courses (exam_id TEXT, course_id TEXT, PRIMARY KEY(exam_id, course_id));
    CREATE TABLE exams (id TEXT PRIMARY KEY, title TEXT, description TEXT DEFAULT 'Description', banner_url TEXT DEFAULT '/exam.png',
      kind TEXT DEFAULT 'enrolled', status TEXT DEFAULT 'published', chapter_id TEXT, exam_mode TEXT DEFAULT 'live',
      batch_id TEXT DEFAULT 'hsc-28', subject TEXT DEFAULT 'Biology', course_type TEXT DEFAULT 'Academic',
      duration_minutes INTEGER DEFAULT 30, total_marks REAL DEFAULT 100, question_count INTEGER DEFAULT 50,
      negative_enabled INTEGER DEFAULT 0, negative_per_wrong REAL DEFAULT 0.25,
      second_timer_enabled INTEGER DEFAULT 0, second_timer_deduction REAL DEFAULT 5,
      scheduled_at TEXT, ends_at TEXT, rule_template TEXT, marks_per_question REAL DEFAULT 2,
      exam_format TEXT, topic_subject TEXT, sort_order INTEGER DEFAULT 0, created_at TEXT DEFAULT '2026-10-12');
    CREATE TABLE exam_questions (id INTEGER PRIMARY KEY, exam_id TEXT, marks REAL, is_active INTEGER DEFAULT 1);
  `);
  const insert = (table: string, row: Record<string, Value>) => {
    const columns = Object.keys(row);
    db.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...Object.values(row));
  };
  const queries: string[] = [];
  const query = async (sql: string, params: Value[] = [], options?: { cache?: number | false }) => {
    queries.push(sql);
    assert.equal(options?.cache, false, "Courses Exams reads must bypass the SELECT cache");
    return db.prepare(sql).all(...params);
  };
  const mysql = { query, exec: async () => ({ affectedRows: 0 }), ensureColumn: async () => undefined };
  const publicExams = loadModule<typeof import("../src/lib/public-exams.ts")>(
    "src/lib/public-exams.ts", {},
  );
  const lifecycle = loadModule<typeof import("../src/lib/enrolled-exam-lifecycle.ts")>(
    "src/lib/enrolled-exam-lifecycle.ts", { "@/lib/mysql": mysql },
  );
  const selector = loadModule<typeof import("../src/lib/enrolled-exams-course-server.ts")>(
    "src/lib/enrolled-exams-course-server.ts",
    { "@/lib/mysql": mysql, "@/lib/enrolled-exam-lifecycle": lifecycle, "@/lib/public-exams": publicExams },
  );
  const addExam = (id: string, overrides: Record<string, Value> = {}) => insert("exams", { id, title: id, ...overrides });
  const assign = (id: string, course = "course-a") => insert("exam_courses", { exam_id: id, course_id: course });
  const liveIds = async () =>
    (await selector.fetchAllLiveCourseExams()).map((exam) => exam.id).sort();
  return { db, insert, addExam, assign, liveIds, selector, queries };
}

describe("Courses Exams live listing (featured endpoint data source)", () => {
  it("returns every currently Live exam across courses with no hardcoded ids", async (t) => {
    const f = fixture(); t.after(() => f.db.close());
    f.addExam("live-a", { scheduled_at: PAST, ends_at: FUTURE }); f.assign("live-a", "course-a");
    f.addExam("live-b", { scheduled_at: PAST, ends_at: FUTURE }); f.assign("live-b", "course-b");
    // A newly created Live exam appears with no code change (dynamic, never hardcoded).
    f.addExam("live-c", { scheduled_at: PAST, ends_at: FUTURE }); f.assign("live-c", "course-c");
    assert.deepEqual(await f.liveIds(), ["live-a", "live-b", "live-c"]);
  });

  it("excludes upcoming, ended, practice-mode, draft and public-kind exams", async (t) => {
    const f = fixture(); t.after(() => f.db.close());
    f.addExam("upcoming", { scheduled_at: FUTURE, ends_at: "2026-10-14T10:00:00.000Z" }); f.assign("upcoming");
    f.addExam("ended", { scheduled_at: PAST, ends_at: ENDED }); f.assign("ended");
    f.addExam("static-practice", { scheduled_at: PAST, ends_at: FUTURE, exam_mode: "practice" }); f.assign("static-practice");
    f.addExam("draft", { status: "draft", scheduled_at: PAST, ends_at: FUTURE }); f.assign("draft");
    f.addExam("public", { kind: "public", scheduled_at: PAST, ends_at: FUTURE }); f.assign("public");
    f.addExam("live", { scheduled_at: PAST, ends_at: FUTURE }); f.assign("live");
    assert.deepEqual(await f.liveIds(), ["live"]);
  });

  it("drops an exam the moment it ends while keeping its record and uses live question totals", async (t) => {
    const f = fixture(); t.after(() => f.db.close());
    f.addExam("mutable", { scheduled_at: PAST, ends_at: FUTURE }); f.assign("mutable");
    f.insert("exam_questions", { id: 1, exam_id: "mutable", marks: 2.5 });
    f.insert("exam_questions", { id: 2, exam_id: "mutable", marks: 2.5 });
    let exams = await f.selector.fetchAllLiveCourseExams();
    assert.equal(exams.find((exam) => exam.id === "mutable")?.totalMarks, 5);
    assert.equal(exams.find((exam) => exam.id === "mutable")?.totalQuestions, 2);
    // Live window passes: the card disappears from Courses Exams ...
    f.db.exec(`UPDATE exams SET ends_at = '${ENDED}' WHERE id = 'mutable'`);
    assert.deepEqual(await f.liveIds(), []);
    // ... but the Course Content record itself is untouched (lifecycle preserved).
    const rows = plain(f.db.prepare("SELECT status, exam_mode FROM exams WHERE id = 'mutable'").all());
    assert.deepEqual(rows, [{ status: "published", exam_mode: "live" }]);
  });

  it("returns an empty list (empty state) when nothing is Live", async (t) => {
    const f = fixture(); t.after(() => f.db.close());
    assert.deepEqual(plain(await f.liveIds()), []);
    assert.deepEqual(plain(await f.selector.fetchFeaturedCoursesLiveExam()), []);
  });
});

describe("Courses Exams loading regression (90% stall)", () => {
  const source = readFileSync(new URL("../src/components/EnrolledExamCourseSelection.tsx", import.meta.url), "utf8");
  it("renders the embedded listing before any auth or course-loading gate", () => {
    const embeddedAt = source.indexOf("if (embedded)");
    assert.ok(embeddedAt >= 0, "embedded branch must exist");
    assert.ok(
      embeddedAt < source.indexOf("if (authLoading)"),
      "embedded must return before the auth-loading spinner or it never renders",
    );
    assert.ok(
      embeddedAt < source.indexOf("if (!items && !error)"),
      "embedded must return before the course-loading spinner: standalone load() is a no-op when embedded, so courses stays null and the spinner would park at 90% forever",
    );
  });
  it("shows an error with retry (not a spinner) when the live fetch fails", () => {
    assert.ok(source.includes('role="alert"'), "failure must render an alert");
    assert.ok(source.includes("Try Again"), "failure must offer a retry");
  });
});

// Run: node --experimental-strip-types --test tests/courses-exams-featured.test.ts
