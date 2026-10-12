import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as helpers from "../src/lib/enrolled-exams.ts";
import * as publicExams from "../src/lib/public-exams.ts";
import * as flow5Shared from "../src/lib/flow5-shared.ts";

const require = createRequire(import.meta.url);
type Value = string | number | null;
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { all(...params: Value[]): Record<string, unknown>[]; run(...params: Value[]): unknown };
    close(): void;
  };
};
const NOW = Date.parse("2026-10-05T12:00:00.000Z");
const PAST = "2026-10-04T12:00:00.000Z";
const FUTURE = "2026-10-06T12:00:00.000Z";

function loadModule<T>(path: string, imports: Record<string, unknown>, clock: typeof Date = Date): T {
  const code = ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  runInNewContext(code, {
    module: loaded, exports: loaded.exports, Date: clock,
    console: { error: () => undefined },
    require: (name: string) => {
      assert.ok(Object.hasOwn(imports, name), `Unexpected dependency (no full catalog, answers or progress loaders): ${name}`);
      return imports[name];
    },
  }, { filename: path });
  return loaded.exports as T;
}
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE catalog_courses (slug TEXT PRIMARY KEY, name TEXT, image_url TEXT,
      content_layout TEXT DEFAULT 'flow-1', status TEXT DEFAULT 'published', availability TEXT DEFAULT 'available');
    CREATE TABLE enrollments (student_uid TEXT, course_id TEXT, enrollment_status TEXT DEFAULT 'active',
      updated_at TEXT DEFAULT '2026-10-05', PRIMARY KEY(student_uid, course_id));
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
      exam_format TEXT, topic_subject TEXT, sort_order INTEGER DEFAULT 0, created_at TEXT DEFAULT '2026-10-05');
    CREATE TABLE exam_questions (id INTEGER PRIMARY KEY, exam_id TEXT, marks REAL, is_active INTEGER DEFAULT 1);
    CREATE TABLE subject_contents (id TEXT PRIMARY KEY, course_slug TEXT, subject_id TEXT, title TEXT,
      content_type TEXT DEFAULT 'exam', video_url TEXT, file_url TEXT, duration_minutes INTEGER DEFAULT 30,
      sort_order INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1, created_at TEXT DEFAULT '2026-10-05');
    CREATE TABLE chapter_contents (id TEXT PRIMARY KEY, chapter_id TEXT, title TEXT, content_type TEXT DEFAULT 'exam',
      video_url TEXT, file_url TEXT, duration_minutes INTEGER DEFAULT 30, sort_order INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1, created_at TEXT DEFAULT '2026-10-05');
    CREATE TABLE course_classes (id TEXT, chapter_id TEXT, title TEXT, video_url TEXT, note_url TEXT,
      duration_minutes INTEGER, sort_order INTEGER, is_active INTEGER DEFAULT 1);
    CREATE TABLE course_materials (id INTEGER, chapter_id TEXT, title TEXT, file_url TEXT, material_type TEXT,
      sort_order INTEGER, is_active INTEGER DEFAULT 1);
  `);
  const insert = (table: string, row: Record<string, Value>) => {
    const columns = Object.keys(row);
    db.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...Object.values(row));
  };
  insert("catalog_courses", { slug: "own", name: "Own course", image_url: "/own.png" });
  insert("catalog_courses", { slug: "other", name: "Other course" });
  insert("enrollments", { student_uid: "student-a", course_id: "own" });
  insert("enrollments", { student_uid: "student-b", course_id: "other" });
  let uid: string | null = "student-a";
  let configured = true;
  let failDb = false;
  let now = NOW;
  class Clock extends Date {
    constructor(value: string | number = now) { super(value); }
    static now() { return now; }
  }
  const queries: string[] = [];
  const cacheViolations: string[] = [];
  const query = async (sql: string, params: Value[] = [], options?: { cache?: number | false }) => {
    queries.push(sql);
    if (options?.cache !== false) cacheViolations.push(sql);
    assert.equal(options?.cache, false, "Every student shortcut/flow read must bypass the SELECT cache");
    if (failDb) throw new Error("Database unavailable (fixture)");
    return db.prepare(sql).all(...params);
  };
  const mysql = { query, exec: async () => ({ affectedRows: 0 }), ensureColumn: async () => undefined };
  const lifecycle = loadModule<typeof import("../src/lib/enrolled-exam-lifecycle.ts")>(
    "src/lib/enrolled-exam-lifecycle.ts", { "@/lib/mysql": mysql }, Clock as typeof Date,
  );
  const server = loadModule<typeof import("../src/lib/enrolled-exams-server.ts")>(
    "src/lib/enrolled-exams-server.ts", { "@/lib/mysql": mysql, "@/lib/enrolled-exams": helpers }, Clock as typeof Date,
  );
  const selector = loadModule<typeof import("../src/lib/enrolled-exams-course-server.ts")>(
    "src/lib/enrolled-exams-course-server.ts",
    { "@/lib/mysql": mysql, "@/lib/enrolled-exam-lifecycle": lifecycle, "@/lib/public-exams": publicExams }, Clock as typeof Date,
  );
  const flow4 = loadModule<typeof import("../src/lib/flow4.ts")>("src/lib/flow4.ts", { "@/lib/mysql": mysql });
  const flow5 = loadModule<typeof import("../src/lib/flow5.ts")>(
    "src/lib/flow5.ts", { "@/lib/mysql": mysql, "@/lib/flow5-shared": flow5Shared }, Clock as typeof Date,
  );
  const common = {
    "next/server": require("next/server"),
    "@/lib/auth-api": { getFirebaseUser: async () => uid ? { uid } : null },
    "@/lib/mysql": { get isMysqlConfigured() { return configured; } },
    "@/lib/enrolled-exams-server": server,
  };
  const route = loadModule<typeof import("../src/app/api/my/course-exams/route.ts")>(
    "src/app/api/my/course-exams/route.ts",
    { ...common, "@/lib/enrolled-exams": helpers, "@/lib/enrolled-exams-course-server": selector },
  );
  const flow4Route = loadModule<typeof import("../src/app/api/my/flow4/route.ts")>(
    "src/app/api/my/flow4/route.ts", { ...common, "@/lib/flow4": flow4 },
  );
  const flow5Route = loadModule<typeof import("../src/app/api/my/flow5/route.ts")>(
    "src/app/api/my/flow5/route.ts", { ...common, "@/lib/flow5": flow5 },
  );
  const { NextRequest } = require("next/server");
  const request = (path: string) => new NextRequest(`http://localhost${path}`);
  const addExam = (id: string, overrides: Record<string, Value> = {}) => insert("exams", { id, title: id, ...overrides });
  const assign = (id: string, course = "own") => insert("exam_courses", { exam_id: id, course_id: course });
  const addSubject = (id: string, course = "own", active = 1) => {
    insert("course_subjects", { id, name: id, is_active: active });
    insert("course_subject_assignments", { subject_id: id, course_slug: course });
  };
  const ids = async () => plain((await selector.fetchFreshCourseExamShortcuts("own")).map((exam) => exam.id).sort()) as string[];
  return {
    db, insert, addExam, assign, addSubject, ids, server, selector, flow4, flow5, route, request, queries, cacheViolations,
    get: (course = "own") => route.GET(request(`/api/my/course-exams?course=${encodeURIComponent(course)}&uid=student-b`)),
    getFlow4: (queryString = "course=own&direct=1") => flow4Route.GET(request(`/api/my/flow4?${queryString}`)),
    getFlow5: (queryString = "course=own") => flow5Route.GET(request(`/api/my/flow5?${queryString}`)),
    authenticate: (value: string | null) => { uid = value; },
    configure: (value: boolean) => { configured = value; },
    fail: (value = true) => { failDb = value; },
    setTime: (value: number) => { now = value; },
  };
}

async function payload(response: Response, status = 200) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  return response.json();
}

describe("complete, isolated legacy course exams", () => {
  it("includes direct assignments, subject-less chapters, subject and paper paths once each", async (t) => {
    const f = fixture(); t.after(() => f.db.close());
    f.addSubject("biology");
    f.insert("course_papers", { id: "paper", subject_id: "biology" });
    for (const [id, subject, paper, owner] of [
      ["direct", null, null, "own"], ["subject", "biology", null, "own"],
      ["paper-ch", "biology", "paper", "own"], ["legacy", "biology", null, null],
    ]) f.insert("course_chapters", { id, subject_id: subject, paper_id: paper, course_slug: owner });
    f.addExam("assigned-only"); f.assign("assigned-only");
    for (const chapter of ["direct", "subject", "paper-ch", "legacy"]) f.addExam(chapter, { chapter_id: chapter });
    f.assign("paper-ch");
    assert.deepEqual(await f.ids(), ["assigned-only", "direct", "legacy", "paper-ch", "subject"]);
    assert.equal(f.queries.length, 2, "Only one selection and one targeted totals query");
  });

  it("never imports another course's chapter through a shared subject, or unassigned chapters", async (t) => {
    const f = fixture(); t.after(() => f.db.close());
    f.addSubject("shared");
    f.insert("course_subject_assignments", { subject_id: "shared", course_slug: "other" });
    f.insert("course_subjects", { id: "unassigned", name: "Unassigned" });
    for (const [id, subject, owner] of [
      ["own-ch", "shared", "own"], ["foreign-ch", "shared", "other"],
      ["unassigned-ch", "unassigned", "own"], ["foreign-direct", null, "other"],
    ] as const) {
      f.insert("course_chapters", { id, subject_id: subject, course_slug: owner });
      f.addExam(id, { chapter_id: id });
    }
    f.addExam("other-assigned"); f.assign("other-assigned", "other");
    f.addExam("orphan");
    assert.deepEqual(await f.ids(), ["own-ch"]);
    // Explicit assignment is intentional cross-course access, unlike an accidental subject join.
    f.assign("foreign-ch");
    assert.deepEqual(await f.ids(), ["foreign-ch", "own-ch"]);
  });

  it("requires active, correctly linked hierarchy nodes unless explicitly assigned", async (t) => {
    const f = fixture(); t.after(() => f.db.close());
    f.addSubject("active"); f.addSubject("inactive", "own", 0);
    f.insert("course_papers", { id: "inactive-paper", subject_id: "active", is_active: 0 });
    f.insert("course_papers", { id: "wrong-paper", subject_id: "inactive" });
    for (const [id, subject, paper, active] of [
      ["inactive-ch", "active", null, 0], ["inactive-subject", "inactive", null, 1],
      ["inactive-paper-ch", "active", "inactive-paper", 1], ["wrong-paper-ch", "active", "wrong-paper", 1],
    ] as const) {
      f.insert("course_chapters", { id, subject_id: subject, paper_id: paper, course_slug: "own", is_active: active });
      f.addExam(id, { chapter_id: id });
    }
    assert.deepEqual(await f.ids(), []);
    f.assign("inactive-ch");
    assert.deepEqual(await f.ids(), ["inactive-ch"]);
  });

  it("excludes public/practice-kind/draft/closed exams even when explicitly assigned", async (t) => {
    const f = fixture(); t.after(() => f.db.close());
    for (const [id, kind, status] of [
      ["published", "enrolled", "published"], ["public", "public", "published"],
      ["public-practice", "practice", "published"], ["draft", "enrolled", "draft"], ["closed", "enrolled", "closed"],
    ]) { f.addExam(id, { kind, status }); f.assign(id); }
    assert.deepEqual(await f.ids(), ["published"]);
  });

  it("retains upcoming/live/archived/no-window phases at canonical exact boundaries", async (t) => {
    const f = fixture(); t.after(() => f.db.close());
    for (const [id, start, end] of [
      ["upcoming", FUTURE, null], ["live", PAST, FUTURE], ["practice", PAST, PAST],
      ["at-start", new Date(NOW).toISOString(), FUTURE], ["at-end", PAST, new Date(NOW).toISOString()],
      ["unscheduled", null, null],
    ] as const) { f.addExam(id, { scheduled_at: start, ends_at: end }); f.assign(id); }
    const result = await f.selector.fetchFreshCourseExamShortcuts("own");
    assert.deepEqual(Object.fromEntries(result.map((exam) => [exam.id, exam.status])), {
      "at-end": "Live", "at-start": "Live", live: "Live", practice: "Archived", unscheduled: "Live", upcoming: "Upcoming",
    });
    f.setTime(NOW + 1);
    assert.equal((await f.selector.fetchFreshCourseExamShortcuts("own")).find((exam) => exam.id === "at-end")?.status, "Archived");
  });

  it("uses fresh active question totals and existing scoring rules, without answers or attempt data", async (t) => {
    const f = fixture(); t.after(() => f.db.close());
    f.addExam("with-questions", { course_type: "Admission", rule_template: "medical", negative_enabled: 1,
      negative_per_wrong: 0.5, second_timer_enabled: 1, second_timer_deduction: 3 });
    f.assign("with-questions");
    f.addExam("configured-only"); f.assign("configured-only");
    f.insert("exam_questions", { id: 1, exam_id: "with-questions", marks: 2.5 });
    f.insert("exam_questions", { id: 2, exam_id: "with-questions", marks: 3 });
    f.insert("exam_questions", { id: 3, exam_id: "with-questions", marks: 999, is_active: 0 });
    let exams = await f.selector.fetchFreshCourseExamShortcuts("own");
    assert.equal(exams.find((exam) => exam.id === "configured-only")?.totalMarks, 100);
    const exam = exams.find((item) => item.id === "with-questions")!;
    assert.equal(exam.totalMarks, 5.5); assert.equal(exam.totalQuestions, 2);
    assert.equal(exam.negativeMarks, publicExams.negativePerWrongFor({ courseType: "Admission", ruleTemplate: "medical" }));
    assert.equal(exam.secondTimerDeduction, 3); assert.equal(exam.scope, "COURSE");
    assert.ok(!("answerKey" in exam));
    assert.ok(f.queries.every((sql) => !/answer_key|exam_results|student_class_progress/.test(sql)));
    f.db.exec("UPDATE exam_questions SET marks = 8 WHERE id = 1");
    exams = await f.selector.fetchFreshCourseExamShortcuts("own");
    assert.equal(exams.find((item) => item.id === "with-questions")?.totalMarks, 11);
  });

  it("reflects assignment, status, chapter ownership and activation edits on the very next read", async (t) => {
    const f = fixture(); t.after(() => f.db.close());
    f.addSubject("subject");
    f.insert("course_chapters", { id: "ch", subject_id: "subject", course_slug: "own" });
    f.addExam("mutable", { chapter_id: "ch" });
    assert.deepEqual(await f.ids(), ["mutable"]);
    f.db.exec("UPDATE exams SET status = 'draft'"); assert.deepEqual(await f.ids(), []);
    f.db.exec("UPDATE exams SET status = 'published'; UPDATE course_chapters SET course_slug = 'other'"); assert.deepEqual(await f.ids(), []);
    f.assign("mutable"); assert.deepEqual(await f.ids(), ["mutable"]);
    f.db.exec("DELETE FROM exam_courses"); assert.deepEqual(await f.ids(), []);
    f.db.exec("UPDATE course_chapters SET course_slug = 'own', is_active = 0"); assert.deepEqual(await f.ids(), []);
    f.db.exec("UPDATE course_chapters SET is_active = 1"); assert.deepEqual(await f.ids(), ["mutable"]);
    assert.deepEqual(f.cacheViolations, []);
  });
});

describe("authenticated, fresh course exam shortcut API", () => {
  it("returns the selected course metadata and its complete exam list, ignoring caller UID", async (t) => {
    const f = fixture(); t.after(() => f.db.close());
    f.addExam("own-exam"); f.assign("own-exam");
    f.addExam("other-exam"); f.assign("other-exam", "other");
    const data = await payload(await f.get());
    assert.equal(data.course.course_id, "own");
    assert.equal(data.course.direct_exam_route_url, "/dashboard/enrolled-courses/own/course-exams");
    assert.deepEqual(data.exams.map((exam: { id: string }) => exam.id), ["own-exam"]);
    assert.equal(f.queries.length, 3, "Ownership/catalog lookup + course selection + scoped live totals");
    assert.equal((await payload(await f.get("other"), 403)).error, "This course is unavailable or you are not actively enrolled.");
  });

  it("returns fresh exam metadata after layout changes for every course layout", async (t) => {
    const f = fixture(); t.after(() => f.db.close());
    f.addExam("exam"); f.assign("exam");
    await payload(await f.get());
    for (const [layout, suffix] of [["flow-4", "flow4-exams"], ["flow-5", "exam-flow"], ["flow-2", "course-exams"]]) {
      f.db.prepare("UPDATE catalog_courses SET name = 'Renamed', image_url = '/fresh.png', content_layout = ? WHERE slug = 'own'").run(layout);
      const before = f.queries.length;
      const data = await payload(await f.get());
      assert.equal(data.course.course_name, "Renamed"); assert.equal(data.course.banner_image_url, "/fresh.png");
      assert.equal(data.course.direct_exam_route_url, `/dashboard/enrolled-courses/own/${suffix}`);
      // Courses Exams serves every layout: the selected enrolled course's
      // exams come back regardless of content layout (enrollment gate first).
      assert.equal(f.queries.length - before, 3);
      assert.equal(data.exams.length, 1);
    }
  });

  it("allows published hidden courses, but immediately denies revoked, unpublished or deleted courses", async (t) => {
    const f = fixture(); t.after(() => f.db.close());
    f.db.exec("UPDATE catalog_courses SET availability = 'hidden' WHERE slug = 'own'");
    assert.deepEqual((await payload(await f.get())).exams, []);
    for (const status of ["pending", "cancelled", "completed"]) {
      f.db.prepare("UPDATE enrollments SET enrollment_status = ? WHERE course_id = 'own'").run(status);
      await payload(await f.get(), 403);
    }
    f.db.exec("UPDATE enrollments SET enrollment_status = 'active'; UPDATE catalog_courses SET status = 'unpublished' WHERE slug = 'own'");
    await payload(await f.get(), 403);
    f.db.exec("DELETE FROM catalog_courses WHERE slug = 'own'"); await payload(await f.get(), 403);
  });

  it("returns no-store for unauthenticated, missing-course, configuration and DB failures", async (t) => {
    const f = fixture(); t.after(() => f.db.close());
    f.authenticate(null); await payload(await f.get(), 401);
    f.authenticate("student-a"); f.configure(false); await payload(await f.get(), 401);
    f.configure(true); await payload(await f.route.GET(f.request("/api/my/course-exams")), 400);
    assert.equal(f.queries.length, 0);
    f.fail(); await payload(await f.get(), 500);
  });
});

describe("flow-4/5 downstream freshness without changing their content models", () => {
  it("reads flow-4 subject/direct/legacy content uncached and reflects edits immediately", async (t) => {
    const f = fixture(); t.after(() => f.db.close());
    f.addSubject("biology");
    f.insert("subject_contents", { id: "direct-exam", course_slug: "own", subject_id: "biology", title: "Original" });
    f.insert("course_chapters", { id: "chapter", subject_id: "biology", course_slug: "own" });
    f.insert("chapter_contents", { id: "legacy-exam", chapter_id: "chapter", title: "Legacy" });
    let data = await payload(await f.getFlow4());
    assert.equal(data.subjects[0].contents[0].title, "Original");
    f.db.exec("UPDATE subject_contents SET title = 'Updated'");
    data = await payload(await f.getFlow4()); assert.equal(data.subjects[0].contents[0].title, "Updated");
    data = await payload(await f.getFlow4("course=own&direct=1&subject=biology")); assert.equal(data.contents[0].title, "Updated");
    data = await payload(await f.getFlow4("course=own&subject=biology")); assert.equal(data.subjects[0].chapters[0].contents[0].title, "Legacy");
    f.db.exec("UPDATE subject_contents SET is_active = 0");
    data = await payload(await f.getFlow4()); assert.deepEqual(data.subjects[0].contents, []);
    f.db.exec("DELETE FROM chapter_contents");
    f.addExam("fallback", { chapter_id: "chapter" });
    await f.flow4.getFlow4Contents("chapter");
    assert.deepEqual(f.cacheViolations, []);
  });

  it("reads flow-5 exams/totals/counts uncached and reflects status and score edits immediately", async (t) => {
    const f = fixture(); t.after(() => f.db.close());
    f.addExam("flow5-exam", { exam_format: "topic-wise", topic_subject: "bio1-botany" }); f.assign("flow5-exam");
    f.insert("exam_questions", { id: 1, exam_id: "flow5-exam", marks: 2 });
    let data = await payload(await f.getFlow5()); assert.equal(data.counts.formats["topic-wise"], 1);
    data = await payload(await f.getFlow5("course=own&format=topic-wise&subject=bio1-botany")); assert.equal(data.exams[0].totalMarks, 2);
    f.db.exec("UPDATE exam_questions SET marks = 7; UPDATE exams SET title = 'Renamed'");
    data = await payload(await f.getFlow5("course=own&format=topic-wise")); assert.equal(data.exams[0].totalMarks, 7); assert.equal(data.exams[0].title, "Renamed");
    f.db.exec("UPDATE exams SET status = 'draft'");
    data = await payload(await f.getFlow5()); assert.equal(data.counts.formats["topic-wise"], 0);
    data = await payload(await f.getFlow5("course=own&format=topic-wise")); assert.deepEqual(data.exams, []);
    assert.deepEqual(f.cacheViolations, []);
  });

  it("isolates flow-5 chapter-linked exams even when subjects are shared across courses", async (t) => {
    const f = fixture(); t.after(() => f.db.close());
    f.addSubject("shared");
    f.insert("course_subject_assignments", { subject_id: "shared", course_slug: "other" });
    for (const [id, owner, active] of [["own-ch", "own", 1], ["foreign-ch", "other", 1], ["disabled-ch", "own", 0], ["legacy-ch", null, 1]] as const) {
      f.insert("course_chapters", { id, subject_id: "shared", course_slug: owner, is_active: active });
      f.addExam(id, { chapter_id: id, exam_format: "topic-wise", topic_subject: "bio1-botany" });
    }
    let data = await payload(await f.getFlow5());
    assert.equal(data.counts.formats["topic-wise"], 2);
    data = await payload(await f.getFlow5("course=own&format=topic-wise"));
    assert.deepEqual(data.exams.map((exam: { id: string }) => exam.id).sort(), ["legacy-ch", "own-ch"]);
    f.assign("foreign-ch");
    data = await payload(await f.getFlow5());
    assert.equal(data.counts.formats["topic-wise"], 3, "Explicit assignment intentionally grants access");
  });

  it("uses fresh UID-scoped enrollment gates and no-store on every flow API error", async (t) => {
    const f = fixture(); t.after(() => f.db.close());
    for (const get of [f.getFlow4, f.getFlow5]) {
      await payload(await get());
      f.db.exec("UPDATE enrollments SET enrollment_status = 'pending' WHERE course_id = 'own'");
      await payload(await get(), 403);
      f.db.exec("UPDATE enrollments SET enrollment_status = 'active'");
      await payload(await get("course=other"), 403);
      f.authenticate(null); await payload(await get(), 401);
      f.authenticate("student-a"); await payload(await get(""), 400);
      f.fail(); await payload(await get(), 500); f.fail(false);
    }
    await payload(await f.getFlow5("course=own&format=invalid"), 400);
    await payload(await f.getFlow5("course=own&format=topic-wise&subject=invalid"), 400);
    assert.deepEqual(f.cacheViolations, []);
  });
});

// Run: node --experimental-strip-types --test tests/enrolled-exams-course.test.ts
// Isolated SQLite executes the real selectors and flow loaders without project DB credentials.
