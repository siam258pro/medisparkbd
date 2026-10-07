import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";
import * as parser from "../src/lib/paste-mcq-parser.ts";
import * as pure from "../src/lib/exam-autosync-pure.ts";
import type { VariantInput, VariantRow, BaseQuestionRow } from "../src/lib/exam-variants.ts";
import type { MasterRow, TranslationRow } from "../src/lib/exam-autosync.ts";

// Exercise the real server code, replacing only DB/auth/Next boundaries.
function load<T>(path: string, dependencies: Record<string, unknown>): T {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: path, reportDiagnostics: true,
  });
  assert.deepEqual(compiled.diagnostics?.filter((d) => d.category === ts.DiagnosticCategory.Error), []);
  const module = { exports: {} };
  const nativeRequire = createRequire(import.meta.url);
  const require = (name: string) => {
    if (name in dependencies) return dependencies[name];
    if (name.startsWith("node:")) return nativeRequire(name);
    throw new Error(`Unexpected dependency: ${name}`);
  };
  runInThisContext(`(function(require, module, exports) {\n${compiled.outputText}\n})`, { filename: path })(require, module, module.exports);
  return module.exports as T;
}
const parseJsonColumn = (value: unknown) => {
  try { return typeof value === "string" ? JSON.parse(value) : value; } catch { return null; }
};
const next = { NextResponse: { json: (data: unknown, init?: ResponseInit) => new Response(JSON.stringify(data), init) } };
const admin = { requireAnyPermission: async () => ({ uid: "admin" }) };
const request = (body: unknown = {}, search = "") => ({
  json: async () => body, nextUrl: new URL(`http://test.invalid/${search}`),
});
const base: BaseQuestionRow = {
  id: 19, question: "বাংলা প্রশ্ন", options: '["ক","খ","গ","ঘ"]',
  correct_index: 0, explanation: "বাংলা ব্যাখ্যা", marks: 1,
};
const input: VariantInput = {
  questionId: 19, version: "english", set: "B", question: "English question",
  options: ["one", "two", "three", "four"], correctIndex: 2, marks: 2,
};
function cell(version = "english", set = "B", changes: Partial<VariantRow> = {}): VariantRow {
  return { question_id: 19, lang: version, set_label: set, question: "English question",
    options: JSON.stringify(input.options), correct_index: 2, marks: 2,
    explanation: null, question_image: null, ...changes };
}
function variantsHarness() {
  const slots = [{ ...base, exam_id: "exam-1", is_active: 1 }, { ...base, id: 20, exam_id: "exam-1", is_active: 0 }];
  let cells: VariantRow[] = [];
  let failWrite = false;
  let failRead = false;
  let failSchema = false;
  const calls: { sql: string; params: unknown[] }[] = [];
  let commits = 0;
  let rollbacks = 0;
  const mysql = {
    parseJsonColumn, ensureColumn: async () => {},
    exec: async () => { if (failSchema) { failSchema = false; throw new Error("schema unavailable"); } return { affectedRows: 1 }; },
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (failRead) throw new Error("read unavailable");
      const active = slots.filter((q) => q.exam_id === params[0] && q.is_active === 1);
      if (sql.includes("FROM exam_questions WHERE")) return [{ n: active.length }];
      assert.match(sql, /q\.is_active = 1/);
      let rows = cells.filter((v) => active.some((q) => q.id === v.question_id));
      if (sql.includes("v.lang = ?")) rows = rows.filter((v) => v.lang === params[1] && v.set_label === params[2]);
      if (sql.includes("GROUP BY")) {
        const counts = new Map<string, { lang: string; set_label: string; n: number }>();
        for (const v of rows) {
          const key = `${v.lang}:${v.set_label}`;
          const value = counts.get(key) ?? { lang: v.lang, set_label: v.set_label, n: 0 };
          value.n++; counts.set(key, value);
        }
        return [...counts.values()];
      }
      return rows;
    },
    withTransaction: async (work: (connection: unknown) => Promise<unknown>) => {
      const before = structuredClone(cells);
      try {
        const result = await work({ query: async (sql: string, params: unknown[] = []) => {
          calls.push({ sql, params });
          if (sql.includes("SELECT id FROM exam_questions")) {
            assert.match(sql, /is_active = 1 FOR UPDATE/);
            return [slots.filter((q) => q.id === params[0] && q.is_active === 1)];
          }
          assert.match(sql, /INSERT INTO exam_question_variants/);
          const [id, lang, set, question, options, correct, explanation, marks, image] = params;
          const row = { question_id: id, lang, set_label: set, question, options, correct_index: correct, explanation, marks, question_image: image } as VariantRow;
          cells = cells.filter((v) => !(v.question_id === id && v.lang === lang && v.set_label === set));
          cells.push(row);
          if (failWrite) throw new Error("write unavailable");
          return [{ affectedRows: 1 }];
        } });
        commits++; return result;
      } catch (e) { cells = before; rollbacks++; throw e; }
    },
  };
  const api = load<typeof import("../src/lib/exam-variants.ts")>("src/lib/exam-variants.ts", { "@/lib/mysql": mysql, "@/lib/paste-mcq-parser": parser });
  return { api, calls, slots, getCells: () => cells, setCells: (rows: VariantRow[]) => { cells = rows; },
    failWrite: () => { failWrite = true; }, failRead: () => { failRead = true; }, failSchema: () => { failSchema = true; },
    counts: () => ({ commits, rollbacks }) };
}

describe("variant slot audit", () => {
  it("upserts only the selected permanent-ID/language/set cell and preserves option order", async () => {
    const h = variantsHarness();
    const original = [cell("bangla", "A"), cell("bangla", "B"), cell("english", "A"), cell()];
    h.setCells(structuredClone(original));
    await h.api.saveVariant({ ...input, question: "Updated English B", options: ["four", "three", "two", "one"], correctIndex: 1 });
    assert.deepEqual(h.getCells().slice(0, 3), original.slice(0, 3));
    const updated = h.getCells()[3];
    assert.equal(updated.question_id, 19);
    assert.equal(updated.question, "Updated English B");
    assert.deepEqual(JSON.parse(updated.options), ["four", "three", "two", "one"]);
    assert.equal(updated.correct_index, 1);
    assert.equal(h.slots[0].question, base.question);
    assert.deepEqual(h.counts(), { commits: 1, rollbacks: 0 });
  });
  it("creates a missing cell without creating a base slot or copying other cells", async () => {
    const h = variantsHarness();
    h.setCells([cell("bangla", "A")]);
    await h.api.saveVariant(input);
    assert.equal(h.getCells().length, 2);
    assert.equal(h.slots.length, 2);
    const map = await h.api.fetchVariantMap("exam-1", true);
    assert.equal(map.has("19:english:B"), true);
    assert.equal(map.has("19:english:A"), false);
  });
  it("refuses inactive and deleted/nonexistent permanent slots", async () => {
    const h = variantsHarness();
    for (const questionId of [20, 999]) await assert.rejects(h.api.saveVariant({ ...input, questionId }), /Active question slot/);
    assert.deepEqual(h.getCells(), []);
  });
  it("validates runtime slot, language, set, option and answer values before writes", async () => {
    const h = variantsHarness();
    for (const patch of [
      { questionId: 0 }, { questionId: 1.5 }, { version: "en" }, { set: "C" },
      { question: "", questionImage: "  " }, { options: ["one", " "] }, { options: ["one", null] },
      { correctIndex: null }, { correctIndex: "" }, { correctIndex: true }, { correctIndex: 4 },
    ]) await assert.rejects(h.api.saveVariant({ ...input, ...patch } as VariantInput));
    assert.deepEqual(h.calls, []);
    assert.equal(h.api.isValidVariantContent("Valid question", '["one","two"]', " "), false);
  });
  it("allows image-only variants and keeps invalid marks out of storage", async () => {
    const h = variantsHarness();
    await h.api.saveVariant({ ...input, question: "", questionImage: " /image.png ", marks: Infinity });
    assert.equal(h.getCells()[0].question_image, "/image.png");
    assert.equal(h.getCells()[0].marks, 1);
  });
  it("rolls back a failed upsert without replacing the existing cell", async () => {
    const h = variantsHarness(); h.setCells([cell()]); h.failWrite();
    await assert.rejects(h.api.saveVariant({ ...input, question: "Replacement" }), /write unavailable/);
    assert.deepEqual(h.getCells(), [cell()]);
    assert.deepEqual(h.counts(), { commits: 0, rollbacks: 1 });
  });
  it("retries bootstrap after failure instead of caching a rejected promise", async () => {
    const h = variantsHarness(); h.failSchema();
    await assert.rejects(h.api.saveVariant(input), /schema unavailable/);
    await h.api.saveVariant(input);
    assert.equal(h.getCells().length, 1);
  });
  it("coverage and availability ignore stale cells belonging to inactive slots", async () => {
    const h = variantsHarness();
    h.setCells([cell(), cell("english", "A", { question_id: 20 })]);
    assert.deepEqual(await h.api.availableSetsForExam("exam-1", "english"), ["B"]);
    assert.equal(await h.api.assignSetForExam("exam-1", "english"), "B");
    const coverage = await h.api.variantCoverage("exam-1");
    assert.equal(coverage.totalSlots, 1);
    assert.deepEqual(coverage.coverage, { "english:B": 1 });
    assert.equal((await h.api.fetchVariantMap("exam-1")).size, 1);
  });
  it("unanswered/blank cells do not make a set available", async () => {
    const h = variantsHarness();
    h.setCells([cell("english", "A", { correct_index: null }), cell("english", "B", { options: '["one"," "]' })]);
    assert.deepEqual(await h.api.availableSetsForExam("exam-1", "english"), []);
  });
  it("strict admin reads surface DB failures while legacy reads retain fallback", async () => {
    const h = variantsHarness(); h.failRead();
    await assert.rejects(h.api.fetchVariantMap("exam-1", true), /read unavailable/);
    assert.equal((await h.api.fetchVariantMap("exam-1")).size, 0);
    assert.equal((await h.api.variantCoverage("exam-1")).error, true);
  });
  it("resolves only the requested cell, never another set/language, and preserves unknown answers", () => {
    const h = variantsHarness();
    const map = new Map([["19:english:A", cell("english", "A")], ["19:bangla:B", cell("bangla", "B")]]);
    const fallback = h.api.resolveQuestions([base], map, "english", "B")[0];
    assert.equal(fallback.hasVariant, false);
    assert.equal(fallback.question, base.question);
    map.set("19:english:B", cell("english", "B", { correct_index: null }));
    const resolved = h.api.resolveQuestions([base], map, "english", "B")[0];
    assert.equal(resolved.hasVariant, true);
    assert.equal(resolved.correctIndex, null);
    assert.equal(resolved.explanation, null);
  });
  it("empty, malformed and non-string option cells fall back as a whole, not mixed fields", () => {
    const h = variantsHarness();
    for (const options of ["bad JSON", "{}", "[]", '["one",null]', '["one"," "]']) {
      const variant = cell("english", "B", { options });
      const resolved = h.api.resolveQuestions([base], new Map([["19:english:B", variant]]), "english", "B")[0];
      assert.equal(resolved.question, base.question);
      assert.deepEqual(resolved.options, JSON.parse(base.options));
      assert.equal(resolved.hasVariant, false);
      const overlay = h.api.overlayVariantOntoBase({ ...base }, variant);
      assert.equal(overlay.hasVariant, false);
      assert.equal(overlay.question, base.question);
    }
  });
});

function master(changes: Partial<MasterRow> = {}): MasterRow {
  return { id: 19, question_uid: "BIO-Q-0019", exam_id: "exam-1", set_label: "A", topic: "Cell Structure",
    bank_subject: "Biology", question: "কোষ গঠন", options: '["কোষ","DNA","RNA","ATP"]', correct_index: 2,
    explanation: null, difficulty: "Easy", marks: 2, sort_order: 1, is_active: 1, ...changes };
}
function translation(changes: Partial<TranslationRow> = {}): TranslationRow {
  return { question_id: 19, question_uid: "BIO-Q-0019", language: "en", question_text: "Hand-edited question",
    option_a: "Hand A", option_b: "Hand B", option_c: "Hand C", option_d: "Hand D", explanation: null,
    translation_status: "manually_edited", ...changes };
}
function autosyncHarness(masters = [master()], initial: TranslationRow[] = [translation()]) {
  let translations = structuredClone(initial);
  let failInsert = false;
  let failColumns = false;
  let failRead = false;
  let commits = 0;
  let rollbacks = 0;
  const calls: { sql: string; params: unknown[] }[] = [];
  const mysql = {
    parseJsonColumn,
    ensureColumn: async () => { if (failColumns) { failColumns = false; throw new Error("column unavailable"); } },
    exec: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.startsWith("UPDATE question_translations")) {
        const t = translations.find((t) => t.question_id === params[0]);
        if (t && t.translation_status !== "manually_edited") t.translation_status = "failed";
      }
      return { affectedRows: 1 };
    },
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (failRead) throw new Error("read unavailable");
      if (sql.includes("GROUP BY question_uid")) {
        assert.doesNotMatch(sql, /SELECT question_uid, set_label/);
        return [];
      }
      const rows = masters.filter((m) => m.exam_id === params[0] && m.set_label === params[1] && m.is_active === 1);
      if (sql.includes("FROM exam_questions")) return rows;
      if (sql.includes("FROM question_translations")) {
        assert.match(sql, /q\.is_active = 1/);
        return translations.filter((t) => rows.some((m) => m.id === t.question_id));
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    withTransaction: async (work: (connection: unknown) => Promise<unknown>) => {
      const before = structuredClone(translations);
      try {
        const result = await work({ query: async (sql: string, params: unknown[] = []) => {
          calls.push({ sql, params });
          if (sql.includes("FROM exam_questions")) {
            assert.match(sql, /is_active = 1 FOR UPDATE/);
            return [masters.filter((m) => m.id === params[0] && m.is_active === 1)];
          }
          if (sql.includes("SELECT translation_status")) {
            assert.match(sql, /FOR UPDATE/);
            return [translations.filter((t) => t.question_id === params[0])];
          }
          assert.match(sql, /INSERT INTO question_translations/);
          if (failInsert) throw new Error("translation write unavailable");
          const [id, uid, question, a, b, c, d, explanation] = params;
          translations = translations.filter((t) => t.question_id !== id);
          translations.push({ question_id: id, question_uid: uid, language: "en", question_text: question,
            option_a: a, option_b: b, option_c: c, option_d: d, explanation, translation_status: "completed" } as TranslationRow);
          return [{ affectedRows: 1 }];
        } });
        commits++; return result;
      } catch (e) { translations = before; rollbacks++; throw e; }
    },
  };
  const api = load<typeof import("../src/lib/exam-autosync.ts")>("src/lib/exam-autosync.ts", {
    "@/lib/mysql": mysql, "./exam-autosync-pure": pure,
  });
  return { api, mysql, calls, getTranslations: () => translations,
    failInsert: () => { failInsert = true; }, failColumns: () => { failColumns = true; }, failRead: () => { failRead = true; },
    counts: () => ({ commits, rollbacks }) };
}

describe("autosync DB boundaries", () => {
  it("automatic sync does not overwrite any manually edited English fields", async () => {
    const h = autosyncHarness();
    assert.equal(await h.api.syncTranslationFor(19), "manually_edited");
    assert.deepEqual(h.getTranslations(), [translation()]);
    assert.equal(h.calls.some((c) => c.sql.includes("INSERT INTO question_translations")), false);
  });
  it("explicit regeneration replaces manual wording atomically and keeps option identities", async () => {
    const m = master(); const h = autosyncHarness([m]);
    assert.equal(await h.api.syncTranslationFor(19, true), "completed");
    const t = h.getTranslations()[0];
    assert.equal(t.question_id, 19);
    assert.deepEqual([t.option_a, t.option_b, t.option_c, t.option_d], ["cell", "DNA", "RNA", "ATP"]);
    assert.equal(m.correct_index, 2);
    assert.equal(t.translation_status, "completed");
  });
  it("creates missing translations only for active masters", async () => {
    const h = autosyncHarness([master(), master({ id: 20, is_active: 0 })], []);
    assert.equal(await h.api.syncTranslationFor(19), "completed");
    assert.equal(await h.api.syncTranslationFor(20), "failed");
    assert.equal(await h.api.syncTranslationFor(999), "failed");
    assert.equal(h.getTranslations().length, 1);
  });
  it("failed explicit regeneration preserves manual content AND manual status", async () => {
    const h = autosyncHarness(); h.failInsert();
    assert.equal(await h.api.syncTranslationFor(19, true), "failed");
    assert.deepEqual(h.getTranslations(), [translation()]);
    assert.deepEqual(h.counts(), { commits: 0, rollbacks: 1 });
  });
  it("failed automatic writes preserve cached content and mark only nonmanual rows failed", async () => {
    const h = autosyncHarness([master()], [translation({ translation_status: "needs_update" })]); h.failInsert();
    assert.equal(await h.api.syncTranslationFor(19), "failed");
    assert.equal(h.getTranslations()[0].question_text, "Hand-edited question");
    assert.equal(h.getTranslations()[0].translation_status, "failed");
  });
  it("does not mark corrupt master option arrays as completed translations", async () => {
    const h = autosyncHarness([master({ options: '["one",null]' })], []);
    assert.equal(await h.api.syncTranslationFor(19), "failed");
    assert.deepEqual(h.getTranslations(), []);
  });
  it("failed additive schema setup is surfaced and may be retried", async () => {
    const h = autosyncHarness(); h.failColumns();
    await assert.rejects(h.api.ensureAutoSyncTables(), /column unavailable/);
    await h.api.ensureAutoSyncTables();
  });
  it("translation fetch failure is not mislabeled as a missing translation", async () => {
    const h = autosyncHarness(); h.failRead();
    await assert.rejects(h.api.fetchTranslations("exam-1", "A"), /read unavailable/);
  });
  it("disjoint checking uses strict-group-mode-compatible SQL", async () => {
    const h = autosyncHarness();
    assert.deepEqual(await h.api.checkSetDisjoint("exam-1"), { disjoint: true, duplicates: [] });
  });
  it("publication rejects out-of-range answers, empty translations, stale statuses and order gaps", async () => {
    const masters = Array.from({ length: 100 }, (_, i) => master({ id: i + 1, question_uid: `BIO-Q-${i + 1}`,
      sort_order: i + 1, topic: pure.SYNC_TOPICS[Math.floor(i / 25)] }));
    const translations = masters.map((m) => translation({ question_id: m.id, translation_status: "completed" }));
    const h = autosyncHarness(masters, translations);
    assert.equal((await h.api.validateSet("exam-1", "A")).publishable, true);
    masters[0].correct_index = 4;
    assert.equal((await h.api.validateSet("exam-1", "A")).answersMatch, false);
    masters[0].correct_index = 2;
    h.getTranslations()[0].option_a = " ";
    assert.equal((await h.api.validateSet("exam-1", "A")).translationsOk, false);
    h.getTranslations()[0].option_a = "one";
    h.getTranslations()[0].translation_status = "needs_update";
    assert.equal((await h.api.validateSet("exam-1", "A")).translationsOk, false);
    h.getTranslations()[0].translation_status = "completed";
    masters[1].sort_order = 1;
    assert.equal((await h.api.validateSet("exam-1", "A")).orderMatch, false);
  });
});

function translationRoute(status = "completed", affectedRows = 1) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const syncs: unknown[][] = [];
  const api = load<typeof import("../src/app/api/admin/exam-sets/translations/route.ts")>("src/app/api/admin/exam-sets/translations/route.ts", {
    "next/server": next, "@/lib/admin": admin,
    "@/lib/mysql": { exec: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return { affectedRows }; } },
    "@/lib/exam-autosync": { ensureAutoSyncTables: async () => {}, syncTranslationFor: async (...args: unknown[]) => { syncs.push(args); return status; } },
  });
  return { api, calls, syncs };
}

describe("translation maintenance API", () => {
  it("reports failed regeneration instead of a successful response or pre-clearing manual status", async () => {
    const h = translationRoute("failed");
    const response = await h.api.POST(request({ questionId: 19 }) as never);
    assert.equal(response.status, 500);
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.syncs, [[19, true]]);
  });
  it("rejects missing, null, zero and negative IDs before touching DB", async () => {
    const h = translationRoute();
    for (const questionId of [undefined, null, 0, -1, 1.5]) {
      assert.equal((await h.api.POST(request({ questionId }) as never)).status, 400);
      assert.equal((await h.api.PATCH(request({ questionId, option_a: "one" }) as never)).status, 400);
    }
    assert.deepEqual(h.calls, []); assert.deepEqual(h.syncs, []);
  });
  it("rejects empty or null question/option wording and reports a missing translation", async () => {
    const h = translationRoute("completed", 0);
    for (const fields of [{ question_text: " " }, { question_text: null }, { option_a: null }, { option_a: " " }]) {
      assert.equal((await h.api.PATCH(request({ questionId: 19, ...fields }) as never)).status, 400);
    }
    const response = await h.api.PATCH(request({ questionId: 19, question_text: "Good English" }) as never);
    assert.equal(response.status, 404);
    assert.match(h.calls[0].sql, /q\.is_active = 1/);
  });
  it("manual wording writes cannot modify the master answer, order, language or set", async () => {
    const h = translationRoute();
    const response = await h.api.PATCH(request({ questionId: 19, question_text: "English", option_a: "Option A", correct_index: 3, set_label: "B", sort_order: 9 }) as never);
    assert.equal(response.status, 200);
    assert.doesNotMatch(h.calls[0].sql, /SET[^]*correct_index|SET[^]*sort_order|SET[^]*set_label/);
    assert.deepEqual(h.calls[0].params, ["English", "Option A", 19]);
  });
});

function questionRoute(failAt = 0, ids = [19, 21]) {
  const applied: { sql: string; params: unknown[] }[] = [];
  const pending: { sql: string; params: unknown[] }[] = [];
  const syncs: number[] = [];
  let writes = 0;
  let rolledBack = false;
  const mysql = {
    withTransaction: async (work: (connection: unknown) => Promise<unknown>) => {
      try {
        const result = await work({ query: async (sql: string, params: unknown[] = []) => {
          if (sql.startsWith("SELECT id")) { assert.match(sql, /is_active = 1 FOR UPDATE/); return [ids.map((id) => ({ id }))]; }
          pending.push({ sql, params });
          if (++writes === failAt) throw new Error("write failed");
          return [{ affectedRows: 1 }];
        } });
        applied.push(...pending); return result;
      } catch (e) { rolledBack = true; throw e; }
    },
    exec: async () => { throw new Error("Mutation escaped transaction"); },
    query: async () => { throw new Error("Unexpected pooled query"); },
  };
  const api = load<typeof import("../src/app/api/admin/exam-sets/questions/route.ts")>("src/app/api/admin/exam-sets/questions/route.ts", {
    "next/server": next, "@/lib/admin": admin, "@/lib/mysql": mysql,
    "@/lib/exam-autosync": { ...pure, ensureAutoSyncTables: async () => {}, syncTranslationFor: async (id: number) => { syncs.push(id); } },
  });
  return { api, applied, pending, syncs, rolledBack: () => rolledBack };
}

describe("master mutation isolation and transactions", () => {
  it("reorder rejects duplicate, partial, foreign and inactive ID lists without writes", async () => {
    for (const order of [[19, 19], [19], [19, 999], [19, 20], [19, "bad"]]) {
      const h = questionRoute();
      const response = await h.api.POST(request({ action: "reorder", examId: "exam-1", set: "A", order }) as never);
      assert.equal(response.status, 400);
      assert.deepEqual(h.applied, []); assert.deepEqual(h.pending, []); assert.deepEqual(h.syncs, []);
    }
  });
  it("reorder commits all positions within the requested active exam/set without regenerating wording", async () => {
    const h = questionRoute();
    assert.equal((await h.api.POST(request({ action: "reorder", examId: "exam-1", set: "A", order: [21, 19] }) as never)).status, 200);
    assert.equal(h.applied.length, 3);
    assert.deepEqual(h.applied[1].params, [1, 21, "exam-1", "A"]);
    assert.deepEqual(h.applied[2].params, [2, 19, "exam-1", "A"]);
    assert.deepEqual(h.syncs, []);
  });
  it("mid-reorder DB failure rolls back all writes and never queues sync", async () => {
    const h = questionRoute(3);
    assert.equal((await h.api.POST(request({ action: "reorder", examId: "exam-1", set: "A", order: [21, 19] }) as never)).status, 500);
    assert.equal(h.rolledBack(), true); assert.deepEqual(h.applied, []); assert.deepEqual(h.syncs, []);
  });
  it("master updates are scoped to active exam/set and commit together with the English stale marker", async () => {
    const h = questionRoute();
    const response = await h.api.POST(request({ action: "update", id: 19, examId: "exam-1", set: "A", question: "Updated Bangla" }) as never);
    assert.equal(response.status, 200);
    assert.match(h.applied[0].sql, /id = \? AND exam_id = \? AND set_label = \? AND is_active = 1/);
    assert.deepEqual(h.applied[0].params, ["Updated Bangla", 19, "exam-1", "A"]);
    assert.match(h.applied[1].sql, /language = 'en'.*translation_status != 'manually_edited'/);
    assert.deepEqual(h.syncs, [19]);
  });
  it("stale-marker failure rolls back the master edit and does not queue a translation", async () => {
    const h = questionRoute(2);
    assert.equal((await h.api.POST(request({ action: "update", id: 19, examId: "exam-1", set: "A", question: "Updated Bangla" }) as never)).status, 500);
    assert.equal(h.rolledBack(), true); assert.deepEqual(h.applied, []); assert.deepEqual(h.syncs, []);
  });
  it("unknown actions and missing correct answers cannot silently create/update a master", async () => {
    const h = questionRoute();
    assert.equal((await h.api.POST(request({ action: "typo", examId: "exam-1" }) as never)).status, 400);
    assert.equal((await h.api.POST(request({ action: "update", id: 19, examId: "exam-1", set: "A", correctOption: null }) as never)).status, 400);
    assert.deepEqual(h.applied, []);
  });
});
