import type { PdfMaterialQuestion } from "@/lib/pdf-materials";

// A4 dimensions: 210mm x 297mm = 794 x 1123 px @ 96dpi
// Page padding: 10mm top/bottom, 12mm left/right => content height ~1047px
// The question area is whatever is left after the fixed header, the optional
// material-name title, and the per-page answer-key box — all measured from the
// A4 preview DOM (CSS px @96dpi, 1:1 with the html2canvas capture).
export const A4_CONTENT_WIDTH_PX = 682;
export const A4_USABLE_HEIGHT_PX = 820; // legacy fixed budget (kept for back-compat)

/** Full A4 page height in CSS px (297mm @96dpi). */
export const A4_PAGE_HEIGHT_PX = 1123;
/** Vertical page padding (10mm top + 10mm bottom). */
export const A4_PAGE_V_PADDING_PX = 76;
/**
 * Fixed per-page overhead inside the content box, measured from the preview:
 * top header row (~22) + dotted divider (~8) + column margin (~12) +
 * answer-box top offset pt-4 (16) + rounding slack (~18).
 */
export const A4_PAGE_OVERHEAD_PX = 76;
/** Material-name title block (mt-3 + 13px bold line) when a name is set. */
export const A4_TITLE_RESERVE_PX = 46;
/** Topic-group header chip (mb-2 + py-1 + 11px line + border). */
export const TOPIC_HEADER_HEIGHT_PX = 34;

// ── Render metrics (must match the preview DOM in
//    src/app/admin/material-pdf/page.tsx) ──
// Question stem: text-[11px] font-bold, lineHeight = spacing * 1.1
const Q_FONT_PX = 11;
const Q_LINE_FACTOR = 1.1;
// Options: text-[11px], lineHeight = spacing; grid gap-0.5 (2px) + mt-1.5 (6px)
const OPT_FONT_PX = 11;
const OPT_GAP_PX = 2;
const OPT_TOP_MARGIN_PX = 6;
// Question block: mb-3 (12) + p-1 vertical padding (8).
// NOTE: on-screen edit chrome (.pdf-hide buttons, Ans editor, image controls,
// ~22-30px/block) is intentionally EXCLUDED here — every chrome node carries
// data-html2canvas-ignore AND .pdf-hide{display:none} in the capture clone, so
// estimates match the captured PDF exactly. Do not add chrome height without
// updating the fill-regression tests.
const BLOCK_EXTRAS_PX = 20;
// Usable text width per column (~342px) minus the number gutter (~40px) for
// the stem and minus pl-5 (20px) for options; Hind Siliguri 11px averages
// ~6px/char (Bangla) and ~5.5px/char (English) — 48/44 splits the difference.
const CHARS_PER_LINE_Q = 48;
const CHARS_PER_LINE_OPT = 44;
// Answer-key box: two wrapped rows (numbers + answers) of min-w-[24px] items
// at gap-x-4 (16px) => 40px pitch over ~687px => ~17 items per row.
const ANSWER_ITEMS_PER_ROW = 17;
const ANSWER_ROW_HEIGHT_PX = 18;
/** Base answer-box chrome: border + "উত্তরমালা" header + p-2 + dashed divider. */
const ANSWER_BOX_BASE_PX = 62;

/**
 * Estimated height of the per-page answer-key box for `answerCount`
 * (non-image) questions on that page. It grows only when a row wraps, so the
 * pagination loop can account for it exactly as it fills each page.
 */
export function estimateAnswerBoxHeight(answerCount: number): number {
  const rows = Math.max(1, Math.ceil(Math.max(answerCount, 1) / ANSWER_ITEMS_PER_ROW));
  // Two sections (numbers row + answers row), each wrapping into `rows` lines.
  return ANSWER_BOX_BASE_PX + 2 * rows * ANSWER_ROW_HEIGHT_PX;
}

export type LineSpacing = "compact" | "normal" | "relaxed" | number;
export function lineSpacingFactor(v: LineSpacing): number {
  if (typeof v === "number") return v;
  switch (v) {
    case "compact":
      return 1.0;
    case "normal":
      return 1.35;
    case "relaxed":
      return 1.7;
    default:
      return 1.35;
  }
}

function estimateImageHeight(q: PdfMaterialQuestion, maxHeight: number): number {
  if (!q.image?.dataUrl) return 0;
  // Standalone image block: no question/options, only image
  const w = q.image.widthPercent ?? 100;
  // Estimate height: base on width percent, preserve aspect ~4:3 typical diagram
  // 100% ~ 160px, 70% ~ 120px, 50% ~ 90px, 30% ~ 60px in column width.
  // Capped at the render's maxHeight so large images never under-reserve.
  const base = 160;
  const h = Math.min(maxHeight, Math.round((base * w) / 100));
  // Add padding/margin around image
  return h + 12;
}

export function estimateQuestionHeight(q: PdfMaterialQuestion, spacing: LineSpacing = "normal"): number {
  const factor = lineSpacingFactor(spacing);
  if (q.isStandaloneImage) {
    // Render cap: maxHeight 280px (standalone block).
    return estimateImageHeight(q, 280) + 8;
  }
  const charsPerLineQ = CHARS_PER_LINE_Q;
  const charsPerLineOpt = CHARS_PER_LINE_OPT;
  // Support statement-type MCQs: question contains statements separated by \n (main Q + 1. 2. 3.)
  // Each explicit line should count as at least one typographic line, plus wrapping for long lines
  const qText = q.question || "";
  const qSegments = qText.split("\n");
  let linesQ = 0;
  for (const seg of qSegments) {
    const segTrim = seg.trim();
    // Even empty segment after \n is a line break; count as 1
    if (segTrim.length === 0) {
      linesQ += 1;
      continue;
    }
    linesQ += Math.max(1, Math.ceil(segTrim.length / charsPerLineQ));
  }
  if (linesQ === 0) linesQ = 1;
  // 11px stem at lineHeight spacing*1.1 (matches the preview span style).
  const qHeight = linesQ * (Q_FONT_PX * factor * Q_LINE_FACTOR);
  let optsHeight = OPT_TOP_MARGIN_PX;
  const optLineH = OPT_FONT_PX * factor;
  q.options.forEach((opt, i) => {
    const len = (opt || "").length;
    const lines = Math.max(1, Math.ceil(Math.max(len, 1) / charsPerLineOpt));
    optsHeight += lines * optLineH;
    if (i < q.options.length - 1) optsHeight += OPT_GAP_PX;
  });
  // Render cap: maxHeight 260px (question-attached image).
  const imgH = estimateImageHeight(q, 260);
  // Block chrome: mb-3 + p-1 vertical padding.
  return qHeight + optsHeight + imgH + BLOCK_EXTRAS_PX;
}

export type PaginatedPage = {
  pageNumber: number;
  questions: PdfMaterialQuestion[];
  /**
   * Explicit column assignment — the preview renders these two stacks
   * side-by-side (plain flex + a real divider element) instead of CSS
   * multicol, because the PDF capture (html2canvas) neither renders
   * `column-rule` nor honors `break-inside: avoid` across CSS columns.
   * Every block lives wholly in exactly one column: MCQs can never split.
   */
  columns: [PdfMaterialQuestion[], PdfMaterialQuestion[]];
  startQ: number;
  endQ: number;
};

export type PaginateOptions = {
  /** True when the material-name title block is rendered (reserves 46px). */
  titleReserve?: boolean;
  /**
   * Fixed per-column budget (legacy behaviour, e.g. 740). When omitted the
   * budget is derived from the real page geometry: content height minus
   * header/title overhead minus the page's own answer-box height.
   */
  fixedColumnHeight?: number;
};

export type PageBreakDecision = {
  page: number;
  /** 0 = moved to the right column, 1 = moved to a new page. */
  column: 0 | 1;
  /** Index of the question that triggered the break. */
  atQuestion: number;
  usedH: number;
  capacityH: number;
  remainingH: number;
  nextH: number;
  reason: string;
};

export type PaginateDebugItem = {
  id: string;
  qNumber: number | null;
  height: number;
  topicHeader: boolean;
  column: 0 | 1;
};

export type PaginateDebugPage = {
  page: number;
  capacityH: number;
  usedH: number;
  remainingH: number;
  fillRatio: number;
  /** Per-column budget and per-column used heights (never-split accounting). */
  columnBudgetH: number;
  colUsedH: [number, number];
  items: PaginateDebugItem[];
};

export type PaginateDebugInfo = {
  /** Page geometry the budgets were derived from. */
  availablePageH: number;
  overheadH: number;
  titleReserveH: number;
  breaks: PageBreakDecision[];
  pages: PaginateDebugPage[];
};

export type PaginateResult = {
  pages: PaginatedPage[];
  debug: PaginateDebugInfo;
};

/**
 * Column budget for a page holding `answerCount` (non-image) questions.
 * The answer-key box height is a function of that count, so the budget is
 * exact for the page being filled — no fixed over-reservation.
 */
export function columnBudgetFor(answerCount: number, titleReserve: boolean): number {
  const contentH = A4_PAGE_HEIGHT_PX - A4_PAGE_V_PADDING_PX;
  const titleH = titleReserve ? A4_TITLE_RESERVE_PX : 0;
  return contentH - A4_PAGE_OVERHEAD_PX - titleH - estimateAnswerBoxHeight(answerCount);
}

function topicOf(block: PdfMaterialQuestion): string {
  return block.isStandaloneImage ? "" : (block.topic ?? "").trim();
}

export function paginateQuestionsDebug(
  questions: PdfMaterialQuestion[],
  usableHeight: number = A4_USABLE_HEIGHT_PX,
  spacing: LineSpacing = "normal",
  twoColumn: boolean = true,
  opts: PaginateOptions = {},
): PaginateResult {
  const titleReserve = opts.titleReserve ?? false;
  const fixed = opts.fixedColumnHeight ?? usableHeight;
  const contentH = A4_PAGE_HEIGHT_PX - A4_PAGE_V_PADDING_PX;
  const overheadH = A4_PAGE_OVERHEAD_PX;
  const titleReserveH = titleReserve ? A4_TITLE_RESERVE_PX : 0;
  const debug: PaginateDebugInfo = {
    availablePageH: contentH,
    overheadH,
    titleReserveH,
    breaks: [],
    pages: [],
  };
  if (questions.length === 0) {
    return {
      pages: [{ pageNumber: 1, questions: [], columns: [[], []], startQ: 1, endQ: 0 }],
      debug: {
        ...debug,
        pages: [{ page: 1, capacityH: 0, usedH: 0, remainingH: 0, fillRatio: 0, columnBudgetH: 0, colUsedH: [0, 0], items: [] }],
      },
    };
  }
  const pages: PaginatedPage[] = [];
  let current: PdfMaterialQuestion[] = [];
  let colA: PdfMaterialQuestion[] = [];
  let colB: PdfMaterialQuestion[] = [];
  let currentItems: PaginateDebugItem[] = [];
  let colH: [number, number] = [0, 0];
  let curAnswers = 0;
  let col: 0 | 1 = 0;
  let lastGlobalTopic = "";

  const pageEmpty = () => current.length === 0;
  const pageUsed = () => colH[0] + colH[1];

  const curPageNo = () => pages.length + 1;

  const budgetFor = (pageNo: number, answerCount: number): number => {
    if (opts.fixedColumnHeight !== undefined) return fixed;
    const isPage1 = pageNo === 1;
    return columnBudgetFor(answerCount, isPage1 && titleReserve);
  };
  const pageCapacityFor = (pageNo: number, answerCount: number): number => {
    const col = budgetFor(pageNo, answerCount);
    return twoColumn ? col * 2 : col;
  };

  const flushDebugPage = (pageNo: number) => {
    const capacityH = pageCapacityFor(pageNo, curAnswers);
    const usedH = pageUsed();
    debug.pages.push({
      page: pageNo,
      capacityH,
      usedH,
      remainingH: Math.max(0, capacityH - usedH),
      fillRatio: capacityH > 0 ? usedH / capacityH : 0,
      columnBudgetH: budgetFor(pageNo, curAnswers),
      colUsedH: [colH[0], colH[1]],
      items: currentItems,
    });
  };

  const flushPage = () => {
    const start = pages.reduce((acc, p) => acc + p.questions.length, 0) + 1;
    flushDebugPage(pages.length + 1);
    pages.push({
      pageNumber: pages.length + 1,
      questions: current,
      columns: [colA, colB],
      startQ: start,
      endQ: start + current.length - 1,
    });
    current = [];
    colA = [];
    colB = [];
    currentItems = [];
    colH = [0, 0];
    curAnswers = 0;
    col = 0;
  };

  const headerFor = (q: PdfMaterialQuestion, topic: string): boolean => {
    if (q.isStandaloneImage || !topic) return false;
    return topic !== lastGlobalTopic;
  };

  const place = (q: PdfMaterialQuestion, h: number, topic: string, c: 0 | 1, topicHeader: boolean) => {
    current.push(q);
    (c === 0 ? colA : colB).push(q);
    currentItems.push({
      id: q.id,
      qNumber: q.isStandaloneImage ? null : (q.qNumber ?? null),
      height: h,
      topicHeader,
      column: c,
    });
    colH[c] += h;
    if (!q.isStandaloneImage) {
      curAnswers += 1;
      if (topic) lastGlobalTopic = topic;
    }
  };

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]!;
    const topic = topicOf(q);
    const baseH = estimateQuestionHeight(q, spacing);
    const nextAnswers = curAnswers + (q.isStandaloneImage ? 0 : 1);
    const pNo = curPageNo();
    const B = budgetFor(pNo, nextAnswers);
    const showHere = headerFor(q, topic);
    const needHere = baseH + (showHere ? TOPIC_HEADER_HEIGHT_PX : 0);

    if (pageEmpty() || colH[col] + needHere <= B) {
      // Fits in the current column (or the page is empty: a single oversize
      // block still gets placed alone and overflows gracefully).
      place(q, needHere, topic, col, showHere);
      continue;
    }

    if (col === 0 && twoColumn) {
      // Whole block moves to the right column — never split across columns.
      // Topic Header stays with the MCQ (never orphaned).
      const showRight = headerFor(q, topic);
      const needRight = baseH + (showRight ? TOPIC_HEADER_HEIGHT_PX : 0);
      if (needRight <= B) {
        debug.breaks.push({
          page: pages.length + 1,
          column: 0,
          atQuestion: i,
          usedH: pageUsed(),
          capacityH: pageCapacityFor(pNo, curAnswers),
          remainingH: B - colH[0],
          nextH: needRight,
          reason: `next block (${Math.round(needRight)}px) exceeds left-column remaining ${Math.round(B - colH[0])}px → whole block to right column`,
        });
        col = 1;
        place(q, needRight, topic, 1, showRight);
        continue;
      }
      // Doesn't fit in either column → whole block to a fresh page.
    }

    debug.breaks.push({
      page: pages.length + 1,
      column: 1,
      atQuestion: i,
      usedH: pageUsed(),
      capacityH: pageCapacityFor(pNo, curAnswers),
      remainingH: pageCapacityFor(pNo, curAnswers) - pageUsed(),
      nextH: needHere,
      reason: `next block (${Math.round(needHere)}px) exceeds remaining ${Math.round(pageCapacityFor(pNo, curAnswers) - pageUsed())}px → whole block to new page`,
    });
    flushPage();
    col = 0;
    const showFresh = headerFor(q, topic);
    const freshNeed = baseH + (showFresh ? TOPIC_HEADER_HEIGHT_PX : 0);
    place(q, freshNeed, topic, 0, showFresh);
  }
  if (current.length > 0) {
    flushPage();
  }
  return { pages, debug };
}

export function paginateQuestions(
  questions: PdfMaterialQuestion[],
  usableHeight: number = A4_USABLE_HEIGHT_PX,
  spacing: LineSpacing = "normal",
  twoColumn: boolean = true,
  opts: PaginateOptions = {},
): PaginatedPage[] {
  return paginateQuestionsDebug(questions, usableHeight, spacing, twoColumn, opts).pages;
}

/** Console report: available height, per-question heights, break decisions. */
export function logPaginateDebug(debug: PaginateDebugInfo): void {
   
  console.groupCollapsed(
    `[pdf-paginate] page content ${debug.availablePageH}px − overhead ${debug.overheadH}px − title ${debug.titleReserveH}px`,
  );
  for (const p of debug.pages) {
     
    console.log(
      `page ${p.page}: capacity ${Math.round(p.capacityH)}px (col ${Math.round(p.columnBudgetH)}px each), ` +
        `used ${Math.round(p.usedH)}px [L ${Math.round(p.colUsedH[0])} / R ${Math.round(p.colUsedH[1])}], ` +
        `remaining ${Math.round(p.remainingH)}px, fill ${(p.fillRatio * 100).toFixed(1)}%`,
    );
  }
  if (debug.breaks.length > 0) {
     
    console.table(
      debug.breaks.map((b) => ({
        page: b.page,
        atQuestion: b.atQuestion,
        used: Math.round(b.usedH),
        capacity: Math.round(b.capacityH),
        remaining: Math.round(b.remainingH),
        next: Math.round(b.nextH),
        reason: b.reason,
      })),
    );
  }
   
  console.groupEnd();
}

/**
 * Evenly spread a column's leftover budget between its blocks so no
 * visible hole remains at the column bottom. Order is untouched — only
 * inter-block spacing grows. Returns the EXTRA marginBottom (px) per block
 * root (on top of the regular mb-3), or 0 to keep the column top-aligned.
 *
 * Guards: single-block columns can't spread; sparse pages (e.g. the last
 * one) stay top-aligned; tiny slacks aren't worth touching; per-gap extra
 * is capped so estimates-vs-reality drift can never overflow the column.
 */
export const COLUMN_SPREAD_MIN_SLACK_PX = 24;
export const COLUMN_SPREAD_MAX_GAP_PX = 24;
export const COLUMN_SPREAD_MIN_FILL = 0.7;
export function columnSpreadExtra(
  columnBudgetH: number,
  colUsedH: number,
  blockCount: number,
  fillRatio: number,
): number {
  if (blockCount <= 1 || fillRatio < COLUMN_SPREAD_MIN_FILL) return 0;
  const slack = columnBudgetH - colUsedH;
  if (!(slack > COLUMN_SPREAD_MIN_SLACK_PX)) return 0;
  return Math.min(slack / blockCount, COLUMN_SPREAD_MAX_GAP_PX);
}

export const ANSWER_LABELS = {
  en: ["A", "B", "C", "D"] as const,
  bn: ["ক", "খ", "গ", "ঘ"] as const,
};

export function normalizeAnswer(ans: string): string {
  const t = ans.trim();
  if (["A", "B", "C", "D", "a", "b", "c", "d"].includes(t)) return t.toUpperCase();
  if (["ক", "খ", "গ", "ঘ"].includes(t)) return t;
  // also accept 1-4
  if (["1", "2", "3", "4"].includes(t)) return String.fromCharCode(64 + Number(t));
  return t;
}

export function answerToDisplay(ans: string, preferBn: boolean): string {
  if (!ans) return "—";
  const up = ans.toUpperCase();
  if (["A", "B", "C", "D"].includes(up)) {
    if (preferBn) {
      const map: Record<string, string> = { A: "ক", B: "খ", C: "গ", D: "ঘ" };
      return map[up] ?? up;
    }
    return up;
  }
  if (["ক", "খ", "গ", "ঘ"].includes(ans)) {
    if (!preferBn) {
      const map: Record<string, string> = { ক: "A", খ: "B", গ: "C", ঘ: "D" };
      return map[ans] ?? ans;
    }
    return ans;
  }
  return ans;
}
