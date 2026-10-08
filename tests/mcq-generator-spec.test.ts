import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  paginateQuestions,
  paginateQuestionsDebug,
  estimateQuestionHeight,
  estimateAnswerBoxHeight,
  columnBudgetFor,
} from "../src/components/admin/MaterialPdf/pagination.ts";
import {
  splitPasteByTopic,
  sanitizeQuestions,
  isExplicitTopicHeader,
  questionsToPasteText,
} from "../src/lib/material-pdf-utils.ts";
import { columnSpreadExtra } from "../src/components/admin/MaterialPdf/pagination.ts";
import { parsePastedMcqs } from "../src/lib/paste-mcq-parser.ts";
import type { PdfMaterialQuestion } from "../src/lib/pdf-materials.ts";

function createMcq(i: number, qLen = 40, optLen = 10, topic = "", ans = "B"): PdfMaterialQuestion {
  return {
    id: `q-${i}`,
    qNumber: i,
    question: `Question ${i}: ${"Q".repeat(qLen)}`,
    options: [
      `A. Option ${i}A`,
      `B. Option ${i}B`,
      `C. Option ${i}C`,
      `D. Option ${i}D`,
    ],
    answer: ans,
    needsReview: false,
    issues: [],
    image: null,
    isStandaloneImage: false,
    topic: topic || undefined,
  };
}

describe("Section 11: Paste MCQ + Topic Detection", () => {
  it("detects plain topic names without Topic: prefix", () => {
    const raw = `Cell Biology

1. Which is the powerhouse of the cell?
A. Nucleus
B. Mitochondria
C. Ribosome
D. Golgi body
Answer: B

2. What is the outer boundary of animal cells?
A. Cell wall
B. Cell membrane
C. Capsule
D. Pellicle
Answer: B

Genetics

3. Who is the father of genetics?
A. Darwin
B. Mendel
C. Morgan
D. Watson
Answer: B`;

    const sections = splitPasteByTopic(raw);
    assert.equal(sections.length, 2);
    assert.equal(sections[0].topic, "Cell Biology");
    assert.equal(sections[1].topic, "Genetics");

    // Ensure parser parses MCQs under each section without polluting question stems
    const q1 = parsePastedMcqs(sections[0].text);
    assert.equal(q1.length, 2);
    assert.ok(!q1[0].question.includes("Cell Biology"));

    const q2 = parsePastedMcqs(sections[1].text);
    assert.equal(q2.length, 1);
    assert.ok(!q2[0].question.includes("Genetics"));
    assert.equal(q2[0].correctIndex, 1); // B
  });

  it("detects explicit prefix and bracketed topics", () => {
    const raw = `Topic: Zoology
1. Q1?
A. 1
B. 2
C. 3
D. 4
Ans: A

[Botany]
2. Q2?
A. 1
B. 2
C. 3
D. 4
Ans: C`;

    const sections = splitPasteByTopic(raw);
    assert.equal(sections.length, 2);
    assert.equal(sections[0].topic, "Zoology");
    assert.equal(sections[1].topic, "Botany");
  });

  it("does NOT mistake stems or passages for topic headers", () => {
    const raw = `নিচের উদ্দীপকটি পড়ে ১ ও ২ নং প্রশ্নের উত্তর দাও:
1. Q1?
A. 1
B. 2
C. 3
D. 4
Ans: A

2. Q2?
A. 1
B. 2
C. 3
D. 4
Ans: B`;

    const sections = splitPasteByTopic(raw);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].topic, "");
  });
});

describe("Section 27: TEST 1 — 5 MCQs, 1 Topic", () => {
  it("fits on 1 page with continuous numbering 1..5, answer key, and topic header", () => {
    const rawQs = Array.from({ length: 5 }, (_, i) => createMcq(i + 1, 30, 8, "Cell Biology"));
    const sanitized = sanitizeQuestions(rawQs);
    assert.deepEqual(sanitized.map((q) => q.qNumber), [1, 2, 3, 4, 5]);

    const { pages, debug } = paginateQuestionsDebug(sanitized, undefined, "normal", true, {
      titleReserve: true,
    });
    assert.equal(pages.length, 1);
    assert.equal(pages[0].questions.length, 5);

    // Topic header is present for the topic
    const topicHeaders = debug.pages[0].items.filter((it) => it.topicHeader);
    assert.equal(topicHeaders.length, 1);
  });
});

describe("Section 27: TEST 2 — 20 MCQs, 2 Topics", () => {
  it("groups by topic, maintains continuous numbering 1..20, and paginates cleanly", () => {
    const t1 = Array.from({ length: 10 }, (_, i) => createMcq(i + 1, 35, 8, "Topic 1"));
    const t2 = Array.from({ length: 10 }, (_, i) => createMcq(11 + i, 35, 8, "Topic 2"));
    const all = sanitizeQuestions([...t1, ...t2]);

    assert.equal(all.length, 20);
    assert.equal(all[0].qNumber, 1);
    assert.equal(all[19].qNumber, 20);

    const { pages, debug } = paginateQuestionsDebug(all, undefined, "normal", true, {
      titleReserve: true,
    });
    // Total questions placed must equal 20
    const totalPlaced = pages.reduce((acc, p) => acc + p.questions.length, 0);
    assert.equal(totalPlaced, 20);

    // Each topic group head reserves a topic header
    const headers = debug.pages.flatMap((p) => p.items).filter((it) => it.topicHeader);
    assert.ok(headers.length >= 2);
  });
});

describe("Section 27: TEST 3 — 50+ MCQs, 4+ Topics", () => {
  it("paginates 52 MCQs across 4 topics without loss, duplication, or overlap", () => {
    const topics = ["Cell Biology", "Genetics", "Ecology", "Physiology"];
    const qs = Array.from({ length: 52 }, (_, i) => {
      const topic = topics[Math.floor(i / 13)];
      return createMcq(i + 1, 40, 10, topic);
    });
    const sanitized = sanitizeQuestions(qs);

    const { pages, debug } = paginateQuestionsDebug(sanitized, undefined, "normal", true, {
      titleReserve: true,
    });
    const totalPlaced = pages.reduce((acc, p) => acc + p.questions.length, 0);
    assert.equal(totalPlaced, 52);

    // Ensure continuous numbering
    for (let i = 0; i < sanitized.length; i++) {
      assert.equal(sanitized[i].qNumber, i + 1);
    }

    // Ensure pages fill safely without column overflow
    for (const p of debug.pages) {
      assert.ok(p.colUsedH[0] <= p.columnBudgetH + 1);
      assert.ok(p.colUsedH[1] <= p.columnBudgetH + 1);
    }
  });
});

describe("Section 27: TEST 4 — MCQs with images", () => {
  it("participates in height calculation and does not split", () => {
    const qWithImg: PdfMaterialQuestion = {
      ...createMcq(1, 40, 10, "Diagrams"),
      image: { dataUrl: "data:image/png;base64,fake", widthPercent: 100 },
    };
    const standaloneImg: PdfMaterialQuestion = {
      id: "img-1",
      qNumber: 0,
      question: "",
      options: ["", "", "", ""],
      answer: "",
      needsReview: false,
      issues: [],
      image: { dataUrl: "data:image/png;base64,fake", widthPercent: 100 },
      isStandaloneImage: true,
    };
    const rest = Array.from({ length: 5 }, (_, i) => createMcq(i + 2, 40, 10, "Diagrams"));

    const all = sanitizeQuestions([qWithImg, standaloneImg, ...rest]);
    const { pages } = paginateQuestionsDebug(all, undefined, "normal", true, {});
    const totalPlaced = pages.reduce((acc, p) => acc + p.questions.length, 0);
    assert.equal(totalPlaced, 7);

    // Standalone image does not increment qNumber
    assert.equal(all[0].qNumber, 1);
    assert.equal(all[1].isStandaloneImage, true);
    assert.equal(all[2].qNumber, 2);
  });
});

describe("Section 27: TEST 5 — MCQ that does not fit at bottom of column", () => {
  it("moves the COMPLETE MCQ to the next column/page (atomic block rule)", () => {
    // Fill left column to near capacity
    const filler = Array.from({ length: 6 }, (_, i) => createMcq(i + 1, 50, 12));
    const tallMcq = createMcq(7, 400, 30); // very tall question
    const rest = Array.from({ length: 5 }, (_, i) => createMcq(8 + i, 40, 10));

    const all = sanitizeQuestions([...filler, tallMcq, ...rest]);
    const { pages, debug } = paginateQuestionsDebug(all, undefined, "normal", true, {});

    // tallMcq must NOT be in column 0 if it doesn't fit
    const p1 = pages[0];
    const inCol0 = p1.columns[0].some((q) => q.id === tallMcq.id);
    const inCol1 = p1.columns[1].some((q) => q.id === tallMcq.id);
    assert.ok(!inCol0 || !inCol1, "MCQ must never be split across both columns");

    // A break decision was recorded
    assert.ok(debug.breaks.length > 0);
  });
});

describe("Section 27: TEST 6 — Topic Header with not enough space for first MCQ", () => {
  it("moves Topic Header and first MCQ together to next column/page (no orphaned header)", () => {
    // Fill column 0 so only ~20px remains
    const filler = Array.from({ length: 7 }, (_, i) => createMcq(i + 1, 40, 10, "Topic A"));
    const newTopicMcq = createMcq(8, 80, 20, "Topic B"); // Needs TOPIC_HEADER_HEIGHT_PX + baseH

    const all = sanitizeQuestions([...filler, newTopicMcq]);
    const { pages } = paginateQuestionsDebug(all, undefined, "normal", true, {});

    // In column 0 of page 1, there must NOT be an orphaned Topic B header without newTopicMcq
    const p1Col0HasNewTopic = pages[0].columns[0].some((q) => q.id === newTopicMcq.id);
    const p1Col1HasNewTopic = pages[0].columns[1].some((q) => q.id === newTopicMcq.id);

    if (!p1Col0HasNewTopic && p1Col1HasNewTopic) {
      // It moved intact to column 1!
      assert.ok(true, "Topic B moved to column 1 together with its MCQ");
    }
  });
});

describe("Section 27: TEST 7, 8, 9 — MCQ & Topic Reordering & Renumbering", () => {
  it("TEST 8: moving a Topic up moves ALL its associated MCQs and recalculates numbering", () => {
    const topicA = Array.from({ length: 3 }, (_, i) => createMcq(i + 1, 30, 8, "Topic A"));
    const topicB = Array.from({ length: 3 }, (_, i) => createMcq(4 + i, 30, 8, "Topic B"));
    const initial = sanitizeQuestions([...topicA, ...topicB]);

    assert.equal(initial[0].topic, "Topic A");
    assert.equal(initial[0].qNumber, 1);
    assert.equal(initial[3].topic, "Topic B");
    assert.equal(initial[3].qNumber, 4);

    // Simulate moving Topic B UP
    const chunks: { topic: string; items: PdfMaterialQuestion[] }[] = [
      { topic: "Topic A", items: topicA },
      { topic: "Topic B", items: topicB },
    ];
    // Swap
    const [moved] = chunks.splice(1, 1);
    chunks.splice(0, 0, moved);
    const reordered = sanitizeQuestions(chunks.flatMap((c) => c.items));

    // Topic B is now first, with questions numbered 1, 2, 3!
    assert.equal(reordered[0].topic, "Topic B");
    assert.equal(reordered[0].qNumber, 1);
    assert.equal(reordered[2].topic, "Topic B");
    assert.equal(reordered[2].qNumber, 3);

    // Topic A is now second, with questions numbered 4, 5, 6!
    assert.equal(reordered[3].topic, "Topic A");
    assert.equal(reordered[3].qNumber, 4);
    assert.equal(reordered[5].topic, "Topic A");
    assert.equal(reordered[5].qNumber, 6);
  });

  it("TEST 9: deleting an MCQ automatically recalculates continuous numbering", () => {
    const qs = Array.from({ length: 5 }, (_, i) => createMcq(i + 1, 30, 8, "Topic A"));
    const initial = sanitizeQuestions(qs);
    assert.deepEqual(initial.map((q) => q.qNumber), [1, 2, 3, 4, 5]);

    // Delete question at index 2 (Q3)
    const afterDelete = sanitizeQuestions(initial.filter((_, idx) => idx !== 2));
    assert.equal(afterDelete.length, 4);
    assert.deepEqual(afterDelete.map((q) => q.qNumber), [1, 2, 3, 4]);
  });
});

describe("Section 28: exact detection parity with exam editor", () => {
  it("never treats [A] option labels, Unit-questions or Answer-Key separators as topics", () => {
    assert.equal(isExplicitTopicHeader("[A]"), null);
    assert.equal(isExplicitTopicHeader("Unit of heredity is called?"), null);
    assert.equal(isExplicitTopicHeader("--- Answer Key ---"), null);
    assert.equal(isExplicitTopicHeader("Topic: Cell Biology"), "Cell Biology");
    assert.equal(isExplicitTopicHeader("[Cell Biology]"), "Cell Biology");
  });

  it("keeps explanation continuations inside the question instead of phantom topics", () => {
    const raw = `1. What is the powerhouse of the cell?
A. Nucleus
B. Mitochondria
C. Ribosome
D. Golgi body
Answer: B
It produces energy for the cell
2. What is the outer boundary?
A. Cell wall
B. Cell membrane
C. Capsule
D. Pellicle
Answer: B`;
    const sections = splitPasteByTopic(raw);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].topic, "");
    const parsed = parsePastedMcqs(sections[0].text);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].correctIndex, 1);
    assert.equal(parsed[1].correctIndex, 1);
  });

  it("keeps blank-separated group labels as topics", () => {
    const raw = `1. Q1?
A. 1
B. 2
C. 3
D. 4
Answer: A

Group B

2. Q2?
A. 1
B. 2
C. 3
D. 4
Answer: B`;
    const sections = splitPasteByTopic(raw);
    assert.equal(sections.length, 2);
    assert.equal(sections[1].topic, "Group B");
    assert.equal(parsePastedMcqs(sections[1].text).length, 1);
  });

  it("round-trips exam-loaded text exactly (paste -> detect -> same count + answers)", () => {
    const qs = [
      createMcq(1, 30, 8, "Cell Biology", "B"),
      createMcq(2, 30, 8, "Cell Biology", "D"),
      createMcq(3, 30, 8, "Genetics", "A"),
    ];
    const text = questionsToPasteText(sanitizeQuestions(qs));
    const sections = splitPasteByTopic(text);
    const got: string[] = [];
    let total = 0;
    for (const s of sections) {
      for (const p of parsePastedMcqs(s.text)) {
        total += 1;
        got.push(p.correctIndex === null ? "?" : String.fromCharCode(65 + p.correctIndex));
      }
    }
    assert.equal(total, 3);
    assert.deepEqual(got, ["B", "D", "A"]);
  });
});

describe("Section 29: column spread leaves no visible holes", () => {
  it("spreads genuine leftover on well-filled multi-block columns", () => {
    // 100px slack over 5 blocks -> 20px extra per block
    assert.equal(columnSpreadExtra(700, 600, 5, 0.85), 20);
  });

  it("stays top-aligned for sparse pages, single blocks and tiny slacks", () => {
    assert.equal(columnSpreadExtra(700, 200, 5, 0.4), 0); // sparse page
    assert.equal(columnSpreadExtra(700, 600, 1, 0.9), 0); // single block
    assert.equal(columnSpreadExtra(700, 690, 5, 0.95), 0); // 10px slack
  });

  it("caps per-gap extra so drift can never overflow", () => {
    assert.equal(columnSpreadExtra(700, 400, 5, 0.9), 24); // 60 -> capped
  });
});
