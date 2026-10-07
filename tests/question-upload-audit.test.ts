import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import * as parser from "../src/lib/paste-mcq-parser.ts";

const OPTIONS = "A. Alpha\nB. Beta\nC. Gamma\nD. Delta";
const require = createRequire(import.meta.url);
const ts = require("typescript") as typeof import("typescript");

describe("question-upload parser audit", () => {
  it("does not turn a missing per-question answer into a key and truncate later questions", () => {
    const questions = parser.parsePastedMcqs(`1. First?\n${OPTIONS}\nAnswer:\n\n2. Second?\n1. A\n2. B\n3. C\n4. D\nAnswer: 2`);
    assert.equal(questions.length, 2);
    assert.equal(questions[0].correctIndex, null);
    assert.equal(questions[1].question, "Second?");
    assert.deepEqual(questions[1].options, ["A", "B", "C", "D"]);
    assert.equal(questions[1].correctIndex, 1);
  });

  for (const labels of [["i", "ii"], ["1", "2"], ["১", "২"]]) {
    it(`preserves blank-separated ${labels.join("/")} statements in the stem`, () => {
      const statements = `${labels[0]}. Plants have roots.\n${labels[1]}. Plants have leaves.`;
      const questions = parser.parsePastedMcqs(`1. Which statements?\n\n${statements}\n${OPTIONS}\nAnswer: D`);
      assert.equal(questions.length, 1);
      assert.equal(questions[0].question, `Which statements?\n${statements}`);
      assert.equal(questions[0].correctIndex, 3);
    });
  }

  for (const labels of [["A.", "B.", "C.", "D."], ["(A)", "(B)", "(C)", "(D)"], ["(ক)", "(খ)", "(গ)", "(ঘ)"]]) {
    it(`preserves negative signs after ${labels[0]} option labels`, () => {
      const options = ["-5", "-3", "+2", "4"];
      const questions = parser.parsePastedMcqs("11. Which value?\n" + options.map((option, i) => `${labels[i]} ${option}`).join("\n") + "\nAnswer: B");
      assert.deepEqual(questions[0].options, options);
      assert.equal(questions[0].correctIndex, 1);
    });
  }

  for (const answer of ["globin", "not haemoglobin", "B/C", "ঘুম", "-3"])  {
    it(`keeps ambiguous or malformed answer ${answer} unknown`, () => {
      const question = parser.parsePastedMcqs(`1. Which protein?\nA. haemoglobin\nB. myoglobin\nC. globulin\nD. collagen\nAnswer: ${answer}`)[0];
      assert.equal(question.correctIndex, null);
      assert.equal(question.needsReview, true);
    });
  }

  it("keeps the first physical duplicate key entry across mixed formats", () => {
    const key = parser.parseStandaloneAnswerKey("7 B\n7-C\n9D\n9. A");
    assert.deepEqual(Array.from(key.entries), [[7, "B"], [9, "D"]]);
    assert.deepEqual(key.duplicates, [7, 9]);
    assert.equal(key.totalFound, 4);
  });

  it("normalizes full-width standalone keys like pasted questions", () => {
    const key = parser.parseStandaloneAnswerKey("Ａｎｓｗｅｒ Ｋｅｙ：\n１：Ｂ\n２：Ｄ");
    assert.deepEqual(Array.from(key.entries), [[1, "B"], [2, "D"]]);
  });

  it("maps Roman source numbers rather than using their array positions", () => {
    const questions = parser.parsePastedMcqs(`VII. Which gas?\n${OPTIONS}\n\nXII. Which cell?\n${OPTIONS}\n\nAnswer Key:\n12 D\n7B`);
    assert.equal(questions.length, 2);
    assert.deepEqual(questions.map((q, i) => parser.questionNumberForIndex(q.originalNumber, i)), [7, 12]);
    assert.deepEqual(questions.map((q) => q.correctIndex), [1, 3]);
  });

  for (const count of [50, 100]) {
    it(`preserves every field in a heterogeneous ${count}-question EN/BN batch`, () => {
      const expected: { question: string; options: string[]; correctIndex: number; number: number }[] = [];
      const blocks: string[] = [];
      const keys: string[] = [];
      for (let i = 0; i < count; i++) {
        const number = 101 + i * 2;
        const bn = i % 2 === 0;
        const printed = bn ? String(number).replace(/\d/g, (n) => "০১২৩৪৫৬৭৮৯"[Number(n)]) : String(number);
        let question = bn ? `প্রশ্ন ${printed} এর মান কত?` : `Which value is correct for item ${number}?`;
        const labels = i % 6 === 0 ? ["i.", "ii.", "iii.", "iv."] : i % 6 === 1 ? ["1.", "2.", "3.", "4."] : bn ? ["(ক)", "(খ)", "(গ)", "(ঘ)"] : ["[A]", "[B]", "[C]", "[D]"];
        if (i % 6 >= 2) question += "\ni. Roots absorb water.\nii. Leaves make food.";
        const options = [`-${number}`, `-${number + 1}`, `+${number + 2}`, `${number + 3}`];
        const separator = i % 6 < 2 ? "\t" : "\n";
        blocks.push(`${bn ? "প্রশ্ন নং " + printed + "।" : "Question No. " + printed + ":"} ${question}\n` + options.map((o, j) => `${labels[j]} ${o}`).join(separator));
        const correctIndex = i % 4;
        keys.push(`${printed}${i % 3 === 0 ? "-" : i % 3 === 1 ? " " : ""}${["A", "B", "C", "D"][correctIndex]}`);
        expected.push({ question, options, correctIndex, number });
      }
      const questions = parser.parsePastedMcqs(blocks.join("\n\n") + "\n\nউত্তরমালা:\n" + keys.reverse().join("\n"));
      assert.equal(questions.length, count);
      assert.deepEqual(questions.map((q, i) => ({ question: q.question, options: q.options, correctIndex: q.correctIndex, number: parser.questionNumberForIndex(q.originalNumber, i) })), expected);
      assert.ok(questions.every((q) => !q.needsReview));
    });
  }
});

// Execute the actual component handlers with a small hook harness. No DOM,
// React renderer, API server or database is needed; all fetches are mocked.
function editorHarness() {
  const source = readFileSync(new URL("../src/components/admin/ExamPaperEditor.tsx", import.meta.url), "utf8");
  const cut = source.indexOf("  const headerBlock =");
  assert.ok(cut > 0, "editor handler boundary");
  const instrumented = source.slice(0, cut) + "  return { handleSaveAll, handleImageUpload, handleRefresh, handleDetect, handleRemoveAll, handleAnswerKeyOcr, setQuestions, setDrafts, setLangVersion, setSetLabel, setBulkText, drafts, questions, notice, error, dirtyCount, imageUploadingSlot, saveAllBusy, answerKeyText, answerKeyMsg, answerKeyError };\n}";
  const compiled = ts.transpileModule(instrumented, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const values: any[] = [];
  let cursor = 0;
  const hooks = {
    useState(initial: any) {
      const index = cursor++;
      if (!(index in values)) values[index] = initial;
      return [values[index], (value: any) => { values[index] = typeof value === "function" ? value(values[index]) : value; }];
    },
    useRef(initial: any) {
      const index = cursor++;
      if (!(index in values)) values[index] = { current: initial };
      return values[index];
    },
    useMemo(callback: () => any, dependencies: any[]) {
      const index = cursor++;
      const previous = values[index];
      if (!previous || dependencies.some((dependency, i) => !Object.is(dependency, previous.dependencies[i]))) {
        values[index] = { value: callback(), dependencies };
      }
      return values[index].value;
    },
    useCallback: (callback: any) => callback,
    useEffect: () => {},
    useLayoutEffect: (callback: () => void) => callback(),
  };
  const exports: any = {};
  const requests: { url: string; init: any }[] = [];
  let respond: (url: string, init: any) => any = () => Promise.resolve({ ok: true, json: async () => ({ saved: 1 }) });
  runInNewContext(compiled, {
    exports,
    require: (name: string) => name === "react" ? hooks : name === "@/lib/paste-mcq-parser" ? parser : {},
    fetch: (url: string, init: any) => { requests.push({ url, init }); return respond(url, init); },
    setTimeout: () => 0,
    console: { error: () => {} },
    URLSearchParams,
    FormData,
    window: { confirm: () => true },
  });
  let examId = "audit-exam";
  const render = () => {
    cursor = 0;
    return exports.default({ exam: { id: examId, title: "Audit", questionCount: 2 }, authHeaders: { Authorization: "mock-token" }, onClose: () => {} });
  };
  let editor = render();
  const draft = { question: "Which value?", options: ["Alpha", "", "Gamma", "Delta"], correctIndex: 2, explanation: "", questionImage: null, sourceNumber: 7 };
  editor.setQuestions([{ id: 12, examId, question: "Old question?", options: ["Old A", "Old B"], correctIndex: 0, questionImage: "old-image", marks: 1 }]);
  editor.setDrafts({ 0: draft });
  editor = render();
  return { render, editor, requests, draft, respond: (callback: typeof respond) => { respond = callback; }, switchExam: (id: string) => { examId = id; } };
}

function deferredResponse() {
  let resolve!: (response: any) => void;
  const promise = new Promise<any>((done) => { resolve = done; });
  return { promise, resolve };
}

function response(data: any) { return { ok: true, json: async () => data }; }

describe("question editor mocked save/upload audit", () => {
  it("saves explicit image removal and normalizes unchanged drafts to the saved option mapping", async () => {
    const harness = editorHarness();
    await harness.editor.handleSaveAll();
    const payload = JSON.parse(harness.requests[0].init.body);
    assert.deepEqual(payload.questions[0].options, ["Alpha", "Gamma", "Delta"]);
    assert.equal(payload.questions[0].correctIndex, 1);
    assert.equal(payload.questions[0].questionImage, null);
    const editor = harness.render();
    assert.deepEqual(Array.from(editor.drafts[0].options), ["Alpha", "Gamma", "Delta", ""]);
    assert.equal(editor.drafts[0].correctIndex, 1);
    assert.equal(editor.drafts[0].sourceNumber, 7);
    assert.equal(editor.dirtyCount, 0);
  });

  it("never merges a server-rejected item as saved", async () => {
    const harness = editorHarness();
    harness.editor.setDrafts({ 0: harness.draft, 1: { ...harness.draft, question: "Rejected question?" } });
    harness.respond(() => Promise.resolve(response({ saved: 1, errors: [{ index: 1, error: "Invalid slot" }] })));
    await harness.render().handleSaveAll();
    const editor = harness.render();
    assert.equal(editor.questions.length, 1);
    assert.equal(editor.drafts[1].question, "Rejected question?");
    assert.match(editor.notice, /Q02|Invalid slot/);
  });

  it("preserves edits made while a save is in flight", async () => {
    const harness = editorHarness();
    const pending = deferredResponse();
    harness.respond(() => pending.promise);
    const saving = harness.editor.handleSaveAll();
    harness.editor.setDrafts({ 0: { ...harness.draft, question: "Edited during save?" } });
    pending.resolve(response({ saved: 1 }));
    await saving;
    const editor = harness.render();
    assert.equal(editor.drafts[0].question, "Edited during save?");
    assert.equal(editor.questions[0].question, harness.draft.question);
    assert.equal(editor.dirtyCount, 1);
  });

  for (const operation of ["save", "image", "refresh", "ocr"] as const) {
    for (const switchKind of ["workspace", "away-and-back", "exam"] as const) {
      it(`${operation} discards stale UI updates after a ${switchKind} switch`, async () => {
        const harness = editorHarness();
        const pending = deferredResponse();
        harness.respond(() => pending.promise);
        const running = operation === "save" ? harness.editor.handleSaveAll() : operation === "image" ? harness.editor.handleImageUpload({ name: "test.png", type: "image/png" }, 0) : operation === "ocr" ? harness.editor.handleAnswerKeyOcr([new File(["mock"], "key.png", { type: "image/png" })]) : harness.editor.handleRefresh();
        if (switchKind === "exam") harness.switchExam("different-exam");
        else harness.editor.setLangVersion("english");
        let current = harness.render();
        if (switchKind === "away-and-back") {
          current.setLangVersion("bangla");
          current = harness.render();
        }
        const replacement = { ...harness.draft, question: "Other workspace?", questionImage: "other-image" };
        current.setDrafts({ 0: replacement });
        current.setQuestions([{ id: 99, question: "Other saved?", options: ["A", "B"], correctIndex: 1 }]);
        pending.resolve(response(operation === "save" ? { saved: 1 } : operation === "image" ? { url: "stale-upload" } : operation === "ocr" ? { texts: ["7-B"] } : { questions: [{ id: 12, question: "Stale refresh?", options: ["A", "B"], correctIndex: 0 }] }));
        await running;
        current = harness.render();
        assert.equal(current.drafts[0].question, replacement.question);
        assert.equal(current.drafts[0].questionImage, replacement.questionImage);
        assert.equal(current.questions[0].id, 99);
        assert.equal(current.notice, null);
        assert.equal(current.answerKeyMsg, null);
        assert.equal(current.answerKeyText, "");
      });
    }
  }

  it("does not reattach an old image after Remove All", async () => {
    const harness = editorHarness();
    const pending = deferredResponse();
    harness.respond(() => pending.promise);
    const uploading = harness.editor.handleImageUpload({ name: "test.png", type: "image/png" }, 0);
    harness.editor.handleRemoveAll();
    pending.resolve(response({ url: "stale-upload" }));
    await uploading;
    assert.equal(Object.keys(harness.render().drafts).length, 0);
  });
});
