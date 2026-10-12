import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as publicExams from "../src/lib/public-exams.ts";
import { getPublicLiveState } from "../src/lib/exam-lifecycle.ts";
import type { Exam } from "../src/lib/exams-admin.ts";

// Execute the real backend modules with an isolated DB adapter. SQLite runs
// the production CASE/SUM SQL; no project database or credentials are needed.
const require = createRequire(import.meta.url);
// The project uses Node 20 typings, which predate Node 22's SQLite module.
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      all(...params: (string | number | null)[]): Record<string, unknown>[];
      run(...params: (string | number | null)[]): unknown;
    };
    close(): void;
  };
};
const NOW = Date.parse("2026-10-05T12:00:00.000Z");
const PAST = "2026-10-04 12:00:00.000";
const CURRENT = "2026-10-05 12:00:00.000";
const FUTURE = "2026-10-06 12:00:00.000";

function loadModule<T>(path: string, imports: Record<string, unknown>, clock: new (value?: string | number) => Date = Date): T {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  runInNewContext(code, {
    module: loaded,
    exports: loaded.exports,
    Date: clock,
    require: (name: string) => {
      assert.ok(Object.hasOwn(imports, name), `Unexpected backend dependency: ${name}`);
      return imports[name];
    },
  }, { filename: path });
  return loaded.exports as T;
}

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE course_categories (
      id TEXT PRIMARY KEY, slug TEXT, is_active INTEGER, sort_order INTEGER,
      created_at TEXT DEFAULT '2026-01-01 00:00:00'
    );
    CREATE TABLE exams (
      id TEXT PRIMARY KEY, category_id TEXT, kind TEXT DEFAULT 'public',
      exam_mode TEXT DEFAULT 'live', status TEXT DEFAULT 'published',
      archived INTEGER DEFAULT 0, scheduled_at TEXT, ends_at TEXT,
      chapter_id TEXT, exam_format TEXT
    );
    CREATE TABLE exam_courses (exam_id TEXT, course_id TEXT, PRIMARY KEY (exam_id, course_id));
  `);
  let nowMs = NOW;
  let failDb = false;
  let queryCount = 0;
  class Clock extends Date {
    constructor(value: string | number = nowMs) { super(value); }
    static now() { return nowMs; }
  }
  const query = async (sql: string, params: unknown[] = [], options?: { cache?: number | false }) => {
    queryCount += 1;
    assert.equal(options?.cache, false, "Count queries must bypass the MySQL SELECT cache");
    if (failDb) throw new Error("Database unavailable (fixture)");
    return db.prepare(sql).all(...params as (string | number | null)[]);
  };
  const cachedKeys: string[] = [];
  const nextCache = {
    unstable_cache: (fn: unknown, keys: string[]) => { cachedKeys.push(...keys); return fn; },
  };
  const store = loadModule<typeof import("../src/lib/course-categories-store.ts")>(
    "src/lib/course-categories-store.ts",
    { "@/lib/mysql": { query }, "@/lib/storage": {}, "next/cache": nextCache },
  );
  for (const category of store.DEFAULT_COURSE_CATEGORIES) {
    db.prepare("INSERT INTO course_categories (id, slug, is_active, sort_order) VALUES (?, ?, ?, ?)")
      .run(category.id, category.slug, 1, category.sortOrder);
  }
  const forbidden = () => { throw new Error("Counts must not read cached/full exam catalogs or exam-taking data"); };
  const server = loadModule<typeof import("../src/lib/public-exams-server.ts")>(
    "src/lib/public-exams-server.ts",
    {
      "@/lib/mysql": { query },
      "@/lib/exams-admin": { fetchExams: forbidden, fetchPublishedPublicExams: forbidden },
      "@/lib/course-categories-store": { ...store, fetchActiveCourseCategories: forbidden },
      "react": { cache: (fn: unknown) => fn },
      "next/cache": nextCache,
      "@/lib/public-exams": publicExams,
      "@/lib/exam-taking": { negativePerWrongFor: forbidden },
    },
    Clock,
  );
  const apiCache = loadModule<typeof import("../src/lib/api-cache.ts")>(
    "src/lib/api-cache.ts", { "next/server": require("next/server") },
  );
  const route = loadModule<typeof import("../src/app/api/public-exams/live-counts/route.ts")>(
    "src/app/api/public-exams/live-counts/route.ts",
    { "@/lib/public-exams-server": server, "@/lib/api-cache": apiCache },
  );
  type Input = {
    category_id?: string | null;
    kind?: string;
    exam_mode?: string;
    status?: string;
    archived?: number;
    scheduled_at?: string | null;
    ends_at?: string | null;
    chapter_id?: string | null;
    exam_format?: string | null;
  };
  const add = (id: string, overrides: Input = {}) => {
    const row = {
      id, category_id: "category-medical", kind: "public", exam_mode: "live",
      status: "published", archived: 0, scheduled_at: null, ends_at: null,
      chapter_id: null, exam_format: null,
      ...overrides,
    };
    db.prepare(`INSERT INTO exams
      (id, category_id, kind, exam_mode, status, archived, scheduled_at, ends_at, chapter_id, exam_format)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.id, row.category_id, row.kind, row.exam_mode, row.status, row.archived, row.scheduled_at, row.ends_at, row.chapter_id, row.exam_format);
    return row;
  };
  const assignCourse = (examId: string, course = "some-course") => {
    db.prepare(`INSERT INTO exam_courses (exam_id, course_id) VALUES (?, ?)`).run(examId, course);
  };
  return {
    db, add, assignCourse, server, route, cachedKeys,
    get queryCount() { return queryCount; },
    setTime: (value: number) => { nowMs = value; },
    fail: () => { failDb = true; },
  };
}

const zeroCounts = () => Object.fromEntries(publicExams.examCategories.map(({ key }) => [key, 0]));
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

// Run: node --experimental-strip-types --test tests/public-exam-counts.test.ts
// node:sqlite is built into Node 22.13+ (still experimental).
describe("fresh public exam category counts", () => {
  it("returns all four numeric category keys, including empty categories", async (t) => {
    const f = fixture();
    t.after(() => f.db.close());
    assert.deepEqual(plain(await f.server.fetchPublicExamCounts()), {
      counts: zeroCounts(), practiceCounts: zeroCounts(),
    });
    assert.equal(f.queryCount, 2, "One category query and one aggregation for both counts");
    assert.ok(!f.cachedKeys.includes("practiceExamCounts"));
    assert.ok(!f.cachedKeys.includes("liveExamCounts"));
  });

  it("counts static and legacy practice, regardless of schedule, plus automatic post-live practice", async (t) => {
    const f = fixture();
    t.after(() => f.db.close());
    f.add("static", { exam_mode: "practice", scheduled_at: FUTURE, ends_at: FUTURE });
    f.add("legacy", { kind: "practice", exam_mode: "live", scheduled_at: FUTURE });
    f.add("both-practice-flags", { kind: "practice", exam_mode: "practice" });
    f.add("post-live", { scheduled_at: PAST, ends_at: CURRENT });
    f.add("long-post-live", { scheduled_at: PAST, ends_at: PAST });
    f.add("live", { scheduled_at: CURRENT, ends_at: FUTURE });
    f.add("no-window");
    f.add("upcoming", { scheduled_at: FUTURE, ends_at: FUTURE });
    const result = await f.server.fetchPublicExamCounts();
    assert.equal(result.practiceCounts["medical-admission"], 5);
    assert.equal(result.counts["medical-admission"], 2);
    assert.deepEqual(plain(await f.server.fetchPracticeExamCounts()), plain(result.practiceCounts));
    assert.deepEqual(plain(await f.server.fetchLiveExamCounts()), plain(result.counts));
  });

  it("matches the category-list lifecycle at exact start/end boundaries without overlapping counts", async (t) => {
    const f = fixture();
    t.after(() => f.db.close());
    const rows = [
      f.add("before-start", { scheduled_at: FUTURE, ends_at: FUTURE }),
      f.add("at-start", { scheduled_at: CURRENT, ends_at: FUTURE }),
      f.add("at-end", { scheduled_at: PAST, ends_at: CURRENT }),
      f.add("after-end", { scheduled_at: PAST, ends_at: PAST }),
      f.add("end-only", { ends_at: CURRENT }),
      f.add("invalid-window", { scheduled_at: FUTURE, ends_at: PAST }),
      f.add("unscheduled"),
    ];
    const expected = { live: 0, practice: 0 };
    for (const row of rows) {
      const phase = getPublicLiveState({
        kind: row.kind as Exam["kind"], examMode: row.exam_mode as Exam["examMode"],
        status: row.status as Exam["status"],
        scheduledAt: row.scheduled_at?.replace(" ", "T").concat("Z") ?? null,
        endsAt: row.ends_at?.replace(" ", "T").concat("Z") ?? null,
      }, NOW);
      if (phase === "live" || phase === "practice") expected[phase] += 1;
    }
    const result = await f.server.fetchPublicExamCounts();
    assert.equal(result.counts["medical-admission"], expected.live);
    assert.equal(result.practiceCounts["medical-admission"], expected.practice);
  });

  it("excludes drafts, admin-closed, archived and enrolled exams, including post-live rows", async (t) => {
    const f = fixture();
    t.after(() => f.db.close());
    for (const exam_mode of ["live", "practice"]) {
      f.add(`draft-${exam_mode}`, { exam_mode, status: "draft", ends_at: PAST });
      f.add(`closed-${exam_mode}`, { exam_mode, status: "closed", ends_at: PAST });
      f.add(`archived-${exam_mode}`, { exam_mode, archived: 1, ends_at: PAST });
      f.add(`enrolled-${exam_mode}`, { exam_mode, kind: "enrolled", ends_at: PAST });
    }
    const result = await f.server.fetchPublicExamCounts();
    assert.deepEqual(plain(result), { counts: zeroCounts(), practiceCounts: zeroCounts() });
  });

  it("excludes course-linked exams from Free Exams even when their kind is public", async (t) => {
    const f = fixture();
    t.after(() => f.db.close());
    f.add("free-live");
    f.add("free-practice", { exam_mode: "practice" });
    // Chapter-linked, Flow-5 format, and directly assigned exams belong to
    // Course Content Control — never to Free Exams, regardless of kind.
    f.add("chapter-linked", { chapter_id: "chapter-1" });
    f.add("chapter-practice", { chapter_id: "chapter-1", exam_mode: "practice" });
    f.add("flow-format", { exam_format: "topic-wise" });
    f.add("assigned", {});
    f.assignCourse("assigned");
    f.add("assigned-practice", { exam_mode: "practice" });
    f.assignCourse("assigned-practice");
    const result = await f.server.fetchPublicExamCounts();
    assert.equal(result.counts["medical-admission"], 1);
    assert.equal(result.practiceCounts["medical-admission"], 1);
  });

  it("uses exact category IDs, not subject/batch heuristics or all similarly named categories", async (t) => {
    const f = fixture();
    t.after(() => f.db.close());
    f.db.prepare("UPDATE course_categories SET slug = 'Medical-Admission' WHERE id = 'category-medical'").run();
    f.db.prepare("INSERT INTO course_categories (id, slug, is_active, sort_order) VALUES (?, ?, ?, ?)")
      .run("medical-second", "medical-extra", 1, 10);
    for (const { key } of publicExams.examCategories) {
      const id = `category-${publicExams.examCategorySlugs[key]}`;
      f.add(`practice-${key}`, { category_id: id, exam_mode: "practice" });
      f.add(`live-${key}`, { category_id: id });
    }
    f.add("unassigned", { category_id: null, exam_mode: "practice" });
    f.add("unknown", { category_id: "deleted-category", exam_mode: "practice" });
    f.add("custom", { category_id: "medical-second", exam_mode: "practice" });
    const result = await f.server.fetchPublicExamCounts();
    for (const { key } of publicExams.examCategories) {
      assert.equal(result.counts[key], 1, key);
      assert.equal(result.practiceCounts[key], 1, key);
    }
  });

  it("preserves missing canonical-category defaults but never reactivates an explicitly disabled category", async (t) => {
    const f = fixture();
    t.after(() => f.db.close());
    f.add("practice", { exam_mode: "practice" });
    f.db.exec("DELETE FROM course_categories WHERE slug = 'medical'");
    assert.equal((await f.server.fetchPublicExamCounts()).practiceCounts["medical-admission"], 1);
    f.db.exec("INSERT INTO course_categories (id, slug, is_active, sort_order) VALUES ('category-medical', 'medical', 0, 3)");
    assert.equal((await f.server.fetchPublicExamCounts()).practiceCounts["medical-admission"], 0);
  });

  it("immediately reflects add, delete, draft, publish, mode, archive and category activation updates", async (t) => {
    const f = fixture();
    t.after(() => f.db.close());
    const practice = async () => (await f.server.fetchPublicExamCounts()).practiceCounts["medical-admission"];
    assert.equal(await practice(), 0);
    f.add("mutable", { exam_mode: "practice" });
    assert.equal(await practice(), 1);
    f.db.exec("UPDATE exams SET status = 'draft' WHERE id = 'mutable'");
    assert.equal(await practice(), 0);
    f.db.exec("UPDATE exams SET status = 'published' WHERE id = 'mutable'");
    assert.equal(await practice(), 1);
    f.db.exec("UPDATE exams SET exam_mode = 'live' WHERE id = 'mutable'");
    assert.equal(await practice(), 0);
    f.db.exec("UPDATE exams SET ends_at = '2026-10-04 12:00:00.000' WHERE id = 'mutable'");
    assert.equal(await practice(), 1);
    f.db.exec("UPDATE exams SET archived = 1 WHERE id = 'mutable'");
    assert.equal(await practice(), 0);
    f.db.exec("UPDATE exams SET archived = 0 WHERE id = 'mutable'");
    f.db.exec("UPDATE course_categories SET is_active = 0 WHERE slug = 'medical'");
    assert.equal(await practice(), 0);
    f.db.exec("UPDATE course_categories SET is_active = 1 WHERE slug = 'medical'");
    assert.equal(await practice(), 1);
    f.db.exec("UPDATE exams SET category_id = 'category-varsity' WHERE id = 'mutable'");
    const moved = await f.server.fetchPublicExamCounts();
    assert.equal(moved.practiceCounts["medical-admission"], 0);
    assert.equal(moved.practiceCounts["varsity-admission"], 1);
    f.db.exec("DELETE FROM exams WHERE id = 'mutable'");
    assert.equal((await f.server.fetchPublicExamCounts()).practiceCounts["varsity-admission"], 0);
  });

  it("moves live to practice immediately as server time crosses End Time without a DB write", async (t) => {
    const f = fixture();
    t.after(() => f.db.close());
    f.add("transition", { scheduled_at: PAST, ends_at: CURRENT });
    f.setTime(NOW - 1);
    const before = await f.server.fetchPublicExamCounts();
    assert.equal(before.counts["medical-admission"], 1);
    assert.equal(before.practiceCounts["medical-admission"], 0);
    f.setTime(NOW);
    const after = await f.server.fetchPublicExamCounts();
    assert.equal(after.counts["medical-admission"], 0);
    assert.equal(after.practiceCounts["medical-admission"], 1);
  });

  it("serves fresh uncached numeric API payloads after mutations", async (t) => {
    const f = fixture();
    t.after(() => f.db.close());
    const first = await f.route.GET();
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("Cache-Control"), "no-store, must-revalidate");
    assert.deepEqual(await first.json(), { counts: zeroCounts(), practiceCounts: zeroCounts() });
    f.add("added", { exam_mode: "practice" });
    const second = await f.route.GET();
    const payload = await second.json();
    assert.equal(payload.practiceCounts["medical-admission"], 1);
    for (const map of [payload.counts, payload.practiceCounts]) {
      assert.deepEqual(Object.keys(map).sort(), Object.keys(zeroCounts()).sort());
      assert.ok(Object.values(map).every((value) => typeof value === "number"));
    }
    assert.equal(f.queryCount, 4, "Each GET must run fresh queries");
  });

  it("returns an uncached 503 on DB failure, never a successful all-zero payload", async (t) => {
    const f = fixture();
    t.after(() => f.db.close());
    f.fail();
    await assert.rejects(f.server.fetchPublicExamCounts(), /Database unavailable/);
    const response = await f.route.GET();
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Cache-Control"), "no-store, must-revalidate");
    assert.deepEqual(await response.json(), { error: "Failed to load exam counts." });
  });
});
