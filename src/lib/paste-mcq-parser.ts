// Paste MCQ Parser — robust flexible MCQ detection
// Supports: varied question numbering (EN/BN digits, Q/Q., Question, প্রশ্ন, Roman I/II/III etc.),
// varied option labels (A-D, a-d, (A), ক/খ/গ/ঘ, 1-4/১-৪, i-iv/I-IV ),
// statement MCQ preservation, flexible spacing/line breaks, mixed formatting,
// automatic answer detection (letter, Bangla label, full text, numeric text etc.)

export type ParsedPasteMcq = {
  question: string;
  options: [string, string, string, string];
  correctIndex: number | null;
  explanation: string;
  marks: number;
  rawBlock: string;
  issues: string[];
  needsReview: boolean;
  confidence: number;
  originalNumber?: string | null;
};

// ── helpers ─────────────────────────────────────────────────────────────────
const BN_DIGIT_MAP: Record<string, string> = { "০": "0", "১": "1", "২": "2", "৩": "3", "৪": "4", "৫": "5", "৬": "6", "৭": "7", "৮": "8", "৯": "9" };
const BN_OPT_MAP: Record<string, number> = { "ক": 0, "খ": 1, "গ": 2, "ঘ": 3 };
const BN_DIGIT_CHARS = "০-৯";

function bnDigitsToAscii(s: string): string {
  return s.replace(/[০-৯]/g, (ch) => BN_DIGIT_MAP[ch] ?? ch);
}

/** Normalize raw pasted text before detection: NBSP, smart quotes/dashes,
 *  full-width chars, zero-width chars, mixed line endings. Preserves real
 *  newlines so multi-line physics/math stems survive. */
export function normalizePasteText(s: string): string {
  let t = String(s ?? "");
  t = t.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // Zero-width / BOM
  t = t.replace(/[\u200B-\u200D\uFEFF]/g, "");
  // NBSP → space
  t = t.replace(/\u00A0/g, " ");
  // Full-width ASCII → half-width (Ａ-Ｚ, ０-９, ，．etc.)
  t = t.replace(/[\uFF01-\uFF5E]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
  );
  t = t.replace(/\uFF61/g, "｡");
  // Smart quotes → straight
  t = t
    .replace(/[“”„‟]/g, '"')
    .replace(/[‘’‚‛]/g, "'")
    // Dashes → hyphen (keep — for answer-prefix regex compat by also allowing -)
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/[…]/g, "...");
  // Normalize Bengali danda variants spaced weirdly: " । " stays, collapse spaces
  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n");
  t = t.replace(/[ \t]{2,}/g, " ");
  // Collapse 3+ blank lines → 2 (block separation survives, noise removed)
  t = t.replace(/\n{4,}/g, "\n\n\n");
  return t;
}

/** True when a non-option line looks like an equation/formula continuation
 *  (physics/math multiline): contains =, →, ≈, √, ∫, ^, _, /, or unit-like
 *  tokens, or starts with -, •, >, or is a short symbol-heavy fragment. */
export function isEquationContinuation(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (/^[-•▪·>\u25B6]\s+\S/.test(t)) return true;
  if (/[=→⇌⇒⇔←↑↓↔≈≠≤≥±×÷√∫∑∏∞∂]/.test(t)) return true;
  if (/\b(Eₖ|K꜀|ΔG|sin|cos|tan|log|ln)\b/i.test(t) && /[=+\-*/^_0-9]/.test(t))
    return true;
  if (/[A-Za-z]\s*=\s*[^=]+/.test(t)) return true;
  if (/H₂|O₂|H2O|NaCl|Ca²|SO₄|kJ\/mol|\bJ\b|\bΩ\b|m\/s/.test(t)) return true;
  // Short fragment with digits+symbols and no sentence end → likely formula line
  if (t.length < 60 && /[0-9]/.test(t) && /[+\-*/^()[\]{}]/.test(t)) return true;
  return false;
}

function normalizeForCompare(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[।॥]/g, "")
    .replace(/[.,;:—\-–\(\)\[\]"'!?\u09F7\u09C3]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanOptionText(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^\*\s*/, "").trim();
  s = s.replace(/^[\*•]+\s*/, "").replace(/^-\s+/, "").trim();
  s = s.replace(/\s*✓\s*$/g, "").trim();
  s = s.replace(/\s*✔\s*$/g, "").trim();
  s = s.replace(/\s*\(correct\)\s*$/i, "").trim();
  s = s.replace(/\s*\*\s*$/g, "").trim();
  s = s.replace(/\s+$/, "").trim();
  // Defense-in-depth: strip trailing answer/explanation text that leaked into option
  // e.g. "Mollusca   উত্তর: (b) Nematoda" → "Mollusca"
  s = s.replace(/\s+(?:Ans(?:wer)?\.?|Correct(?:\s+Answer|\s+option)?|উত্তর\s*ঃ?|সঠিক\s+উত্তর)\s*[:\-=—ঃ.:].*$/i, "").trim();
  s = s.replace(/\s+(?:ব্যাখ্যা\s*ঃ?|Explanation|Explan\.?)\s*[:\-=—ঃ.:].*$/i, "").trim();
  return s;
}

function romanToIndex(tok: string): number | null {
  const t = tok.trim().toLowerCase();
  if (t === "i") return 0;
  if (t === "ii") return 1;
  if (t === "iii") return 2;
  if (t === "iv") return 3;
  return null;
}

// ── canonical answer representation ─────────────────────────────────────────
// The pipeline normalizes every detected answer to "A" | "B" | "C" | "D".
// Anything missing/malformed/out-of-range is explicit null (unknown) —
// it is NEVER defaulted to "A"/index 0. Storage, grading and rendering must
// preserve null and surface it instead of silently converting it.
export type CanonicalAnswerLetter = "A" | "B" | "C" | "D";

/** Index → canonical letter. Anything outside 0–3 (incl. null/undefined) → null. */
export function answerIndexToLetter(
  index: number | null | undefined,
): CanonicalAnswerLetter | null {
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > 3) {
    return null;
  }
  return String.fromCharCode(65 + index) as CanonicalAnswerLetter;
}

/** Canonical letter (EN A–D or BN ক–ঘ, with or without brackets/dots) → index. Else null. */
export function answerLetterToIndex(
  letter: string | null | undefined,
): number | null {
  if (letter === null || letter === undefined) return null;
  const c = String(letter)
    .trim()
    .replace(/^[\(\[]\s*/, "")
    .replace(/\s*[\)\]\.]+$/g, "")
    .trim();
  if (/^[A-Da-d]$/.test(c)) return c.toUpperCase().charCodeAt(0) - 65;
  if (/^[কখগঘ]$/.test(c)) return BN_OPT_MAP[c] ?? null;
  return null;
}

/**
 * Strict answer-index normalization for STORAGE boundaries.
 * Accepts only real integers in [0, optionCount). Empty strings, null,
 * undefined, booleans, NaN, non-integer numbers, letters and out-of-range
 * values all yield null. It NEVER returns 0 for missing/malformed input —
 * the old `Number(x) || 0` idiom silently stored "A".
 */
export function strictAnswerIndex(
  value: unknown,
  optionCount: number,
): number | null {
  if (typeof value === "boolean" || value === null || value === undefined) {
    return null;
  }
  let n: number;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "string") {
    if (value.trim() === "") return null;
    n = Number(value);
  } else {
    return null;
  }
  if (!Number.isInteger(n)) return null;
  if (n < 0 || n >= optionCount) return null;
  return n;
}

/** Compact optional blank choices without changing which choice is correct. */
export function compactMcqOptions(
  options: string[],
  correctIndex: unknown,
): { options: string[]; correctIndex: number | null } {
  const answer = strictAnswerIndex(correctIndex, options.length);
  const kept: string[] = [];
  let remapped: number | null = null;
  options.forEach((option, index) => {
    const text = option.trim();
    if (!text) return;
    if (index === answer) remapped = kept.length;
    kept.push(text);
  });
  return { options: kept, correctIndex: remapped };
}

/**
 * Lenient stored-answer normalization for READ boundaries (grading, answer
 * sheet, result script). Stored snapshots may carry the selection as a
 * number (0-based option index), a numeric string ("2" — JSON or form
 * encoding), or a canonical letter ("B" / "ক"). Question IDs may likewise
 * arrive as strings ("123") or numbers (123) — callers must always key
 * lookups with String(id).
 *
 * Returns a non-negative integer index, or null when the value is
 * missing/malformed. It NEVER falls back to 0/"A": unknown stays unknown
 * and renders as unanswered ("—" / "Not Answered").
 */
export function normalizeStoredAnswerIndex(value: unknown): number | null {
  if (typeof value === "boolean" || value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 && value <= 3 ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    // Canonical letter first (A–D / ক–ঘ, with or without brackets/dots).
    const asLetter = answerLetterToIndex(trimmed);
    if (asLetter !== null) return asLetter;
    const n = Number(trimmed);
    return Number.isInteger(n) && n >= 0 && n <= 3 ? n : null;
  }
  return null;
}

// ── question header detection ──────────────────────────────────────────────
function stripQuestionHeader(line: string): { stripped: string; header: string } | null {
  const raw = line;
  // Try patterns in order: most specific first
  // 1) প্রশ্ন variants: প্রশ্ন, প্রশ্ন নং, প্রশ্ন No.
  let m = raw.match(/^\s*(প্রশ্ন\s*(?:নং\.?|No\.?)?\s*(?:\d+|[০-৯]+)\s*[\.\)\:\-।\)]?)\s*(.*)$/);
  if (m) {
    const header = m[1].trim();
    const rest = (m[2] ?? "").trim();
    // Even if rest empty (header alone next line is question), treat as header
    return { stripped: rest, header };
  }
  // 2) Question variants (with number)
  m = raw.match(/^\s*(Question\s*(?:No\.?)?\s*(?:\d+|[০-৯]+)\s*[\.\)\:\-]?)\s*(.*)$/i);
  if (m) {
    const header = m[1].trim();
    const rest = (m[2] ?? "").trim();
    return { stripped: rest, header };
  }
  // 2b) Plain QUESTION: without number — e.g., "QUESTION: What is...?"
  m = raw.match(/^\s*(QUESTION\s*[:\-])\s*(.*)$/i);
  if (m) {
    const header = m[1].trim();
    const rest = (m[2] ?? "").trim();
    return { stripped: rest, header };
  }
  // 3) Q variants: Q1, Q.1, Q-1, Q01, Q 1, Q. 1, Q- 1, Q1., Q1), Q1:
  // allow Q optionally with dot/dash then digits
  // Must ensure not matching "Qi" etc.
  m = raw.match(/^\s*(Q\s*[\.\-]?\s*[0-9০-৯]+\s*[\.\)\:\-।]?)\s*(.*)$/i);
  if (m) {
    // Validate that captured header looks like Q + number, not just "Q."
    const hdr = m[1].trim();
    if (/^Q/i.test(hdr) && /[0-9০-৯]/.test(hdr)) {
      // Need to ensure rest or header is question start: if remainder empty and next char is not option, still header
      // For "Q1" alone, rest may be empty; treat as header
      const rest = (m[2] ?? "").trim();
      // Guard: Q header should be at line start, not inside "Question" already handled
      return { stripped: rest, header: hdr };
    }
  }
  // Also handle "Q.1" where dot between Q and number: Q\. ? \d+
  m = raw.match(/^\s*(Q\s*[\.\)\:\-]\s*0*\d+\s*[\.\)\:\-]?)\s*(.*)$/i);
  if (m && /\d/.test(m[1])) {
    return { stripped: (m[2] ?? "").trim(), header: m[1].trim() };
  }

  // 4) Numeric: 1. 2. 10. 1) 2) ১০. ১১) ১। 1.- etc.
  m = raw.match(/^\s*([0-9০-৯]+[ \t]*[.)।:\-]\-?)(?![0-9০-৯])[ \t]*(.*)$/);
  if (m) {
    return { stripped: (m[2] ?? "").trim(), header: m[1].trim() };
  }
  // Also allow numeric with no space but at least one non-digit char after? For statements we need space; but for header "1.মূত্র" without space? Still support without space? Better require at least one space but we handle no-space as well if text present
  // 5) Roman numerals: I. II. III. IV. i. ii. iii. etc. (1-30) — support I.- II.- etc.
  m = raw.match(/^\s*((?:[IVXLCDM]{1,5}|[ivxlcdm]{1,5})\s*[\.\)\-]\-?)\s+(.*)$/);
  if (m) {
    const hdr = m[1].trim();
    const tok = hdr.replace(/[\.\)\-]/g, "").trim();
    if (/^(?:[IVXLCDM]+|[ivxlcdm]+)$/.test(tok)) {
      if (/^[A-Da-d]$/.test(tok)) return null;
      if (/^[cCdD]$/.test(tok)) return null;
      return { stripped: (m[2] ?? "").trim(), header: hdr };
    }
  }
  return null;
}

function isQuestionHeaderLine(line: string): boolean {
  return stripQuestionHeader(line) !== null;
}

// ── option parsing ─────────────────────────────────────────────────────────
function parseOptionLine(line: string, allowNumeric = true): { index: number; text: string; isCorrectMarker: boolean } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const checkCorrect = (content: string): { text: string; isCorrect: boolean } => {
    let c = content.trim();
    let isCorrect = false;
    if (/\*\s*$/.test(c) || /\(correct\)\s*$/i.test(c) || /✓\s*$/.test(c) || /✔\s*$/.test(c)) {
      isCorrect = true;
      c = c.replace(/\s*\*\s*$/, "").replace(/\s*\(correct\)\s*$/i, "").replace(/\s*✓\s*$/, "").replace(/\s*✔\s*$/, "").trim();
    }
    return { text: c, isCorrect };
  };

  // 1) English A-D with various wrappers
  // (A) text, [A] text, A. text, A) text, A: text, A - text, A। etc.
  let m = trimmed.match(/^\s*\(\s*([A-Da-d])\s*\)\s*[\.\)\:\—।]?\s*(.+)$/);
  if (m) {
    const idx = m[1].toUpperCase().charCodeAt(0) - 65;
    const ck = checkCorrect(m[2]);
    return { index: idx, text: cleanOptionText(ck.text), isCorrectMarker: ck.isCorrect };
  }
  m = trimmed.match(/^\s*\[\s*([A-Da-d])\s*\]\s*[\.\)\:\—]?\s*(.+)$/);
  if (m) {
    const idx = m[1].toUpperCase().charCodeAt(0) - 65;
    const ck = checkCorrect(m[2]);
    return { index: idx, text: cleanOptionText(ck.text), isCorrectMarker: ck.isCorrect };
  }
  m = trimmed.match(/^\s*([A-Da-d])\s*[\.\)\:\-\—\)]\s*(.+)$/);
  if (m) {
    const idx = m[1].toUpperCase().charCodeAt(0) - 65;
    const ck = checkCorrect(m[2]);
    return { index: idx, text: cleanOptionText(ck.text), isCorrectMarker: ck.isCorrect };
  }

  // 2) Bangla ক খ গ ঘ
  m = trimmed.match(/^\s*\(\s*([কখগঘ])\s*\)\s*[\.\)\:\—।]?\s*(.+)$/);
  if (m) {
    const idx = BN_OPT_MAP[m[1]];
    if (idx !== undefined) {
      const ck = checkCorrect(m[2]);
      return { index: idx, text: cleanOptionText(ck.text), isCorrectMarker: ck.isCorrect };
    }
  }
  m = trimmed.match(/^\s*\[\s*([কখগঘ])\s*\]\s*[\.\)\:\—।]?\s*(.+)$/);
  if (m) {
    const idx = BN_OPT_MAP[m[1]];
    if (idx !== undefined) {
      const ck = checkCorrect(m[2]);
      return { index: idx, text: cleanOptionText(ck.text), isCorrectMarker: ck.isCorrect };
    }
  }
  m = trimmed.match(/^\s*([কখগঘ])\s*[\.\)\:\-\—।\)]?\s+(.+)$/);
  if (m) {
    const idx = BN_OPT_MAP[m[1]];
    if (idx !== undefined) {
      const ck = checkCorrect(m[2]);
      return { index: idx, text: cleanOptionText(ck.text), isCorrectMarker: ck.isCorrect };
    }
  }
  // also handle ক) without space? e.g., "ক)Option"
  m = trimmed.match(/^\s*([কখগঘ])\s*[\)\.\:\-।]\s*(.+)$/);
  if (m) {
    const idx = BN_OPT_MAP[m[1]];
    if (idx !== undefined) {
      const ck = checkCorrect(m[2]);
      return { index: idx, text: cleanOptionText(ck.text), isCorrectMarker: ck.isCorrect };
    }
  }

  // 3) Roman i-iv / I-IV (option style)
  m = trimmed.match(/^\s*\(\s*(i{1,3}|iv|I{1,3}|IV)\s*\)\s*[\.\)\:\—]?\s*(.+)$/);
  if (m) {
    const idx = romanToIndex(m[1]);
    if (idx !== null) {
      const ck = checkCorrect(m[2]);
      return { index: idx, text: cleanOptionText(ck.text), isCorrectMarker: ck.isCorrect };
    }
  }
  m = trimmed.match(/^\s*(i{1,3}|iv|I{1,3}|IV)\s*[\.\)\:\-\—]\s*(.+)$/);
  if (m) {
    const idx = romanToIndex(m[1]);
    if (idx !== null) {
      // Ensure it's really roman option, not question header roman? For option, text after should be option content, not very short question?
      // We'll treat as option if text length reasonable
      if (m[2].trim().length > 0) {
        const ck = checkCorrect(m[2]);
        return { index: idx, text: cleanOptionText(ck.text), isCorrectMarker: ck.isCorrect };
      }
    }
  }

  // 4) Numeric 1-4 / ১-৪
  if (allowNumeric) {
    m = trimmed.match(/^\s*\(\s*([1-4]|[১-৪])\s*\)\s*[\.\)\:\—।]?\s*(.+)$/);
    if (m) {
      const ascii = bnDigitsToAscii(m[1]);
      const idx = parseInt(ascii, 10) - 1;
      if (idx >= 0 && idx < 4) {
        const ck = checkCorrect(m[2]);
        return { index: idx, text: cleanOptionText(ck.text), isCorrectMarker: ck.isCorrect };
      }
    }
    m = trimmed.match(/^\s*([1-4]|[১-৪])\s*[\.\)\:\-\—\)]\s*(.+)$/);
    if (m) {
      const ascii = bnDigitsToAscii(m[1]);
      const idx = parseInt(ascii, 10) - 1;
      if (idx >= 0 && idx < 4) {
        const ck = checkCorrect(m[2]);
        return { index: idx, text: cleanOptionText(ck.text), isCorrectMarker: ck.isCorrect };
      }
    }
  }

  return null;
}

type OptionLabelStyle = "letter" | "number" | "roman";

function optionLabelStyle(line: string): OptionLabelStyle {
  const label = line.trim().replace(/^[([]\s*/, "");
  if (/^[1-4১-৪]/.test(label)) return "number";
  if (/^(?:i{1,3}|iv)\s*[.):\-]/i.test(label)) return "roman";
  return "letter";
}

/** Numeric/Roman labels are options only when they form an option run, not
 *  when a statement list is followed by an A–D/ক–ঘ option group. */
function isAmbiguousOptionRun(lines: string[], start: number, statementsBeforeLetters = false): boolean {
  const first = parseOptionLine(lines[start], true);
  if (!first || first.index !== 0) return false;
  const style = optionLabelStyle(lines[start]);
  let lastIndex = -1;
  let count = 0;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (isBareAnswerPrefix(line) || extractAnswerPayload(line) !== null || extractExplanationPayload(line) !== null) break;
    if (/^(?:Q|Question|প্রশ্ন)/i.test(line) && isQuestionHeaderLine(line)) break;
    const option = parseOptionLine(line, true);
    if (option) {
      if (optionLabelStyle(line) === "letter") return statementsBeforeLetters && count >= 2;
      if (optionLabelStyle(line) !== style || option.index <= lastIndex) break;
      lastIndex = option.index;
      count++;
    } else if (isQuestionHeaderLine(line)) {
      break;
    }
  }
  return !statementsBeforeLetters && count >= 2;
}

// ── mark handling ──────────────────────────────────────────────────────────
// Per latest spec: DO NOT detect MARK/Marks — every MCQ gets Mark = 1.
// MARK lines are silently skipped.
function isMarkLine(line: string): boolean {
  return /^\s*(?:MARK|MARKS)\s*[:\-=—.]?\s*\d+(?:\.\d+)?\s*$/i.test(line.trim());
}

// ── answer detection ───────────────────────────────────────────────────────
function extractAnswerPayload(line: string): string | null {
  const t = line.trim();
  if (!t) return null;
  // Prefixes: Answer, Ans, Ans., Correct Answer, Correct, Correct option, উত্তর, উত্তরঃ, সঠিক উত্তর, সঠিক উত্তরঃ
  // Allow suffix punctuation : :ঃ - = — . and optional "is"
  // We capture everything after prefix as payload
  // CRITICAL: Strip any trailing ব্যাখ্যা:/Explanation: that may appear on the same line
  const patterns: RegExp[] = [
    // Bangla সঠিক উত্তর
    /^\s*সঠিক\s*উত্তর\s*ঃ?\s*[:\-=—ঃ.:]?\s*(.+?)\s*$/i,
    // Bangla উত্তর (with optional ঃ) - must handle visarga char
    /^\s*উত্তর\s*ঃ?\s*[:\-=—ঃ.:]?\s*(.+?)\s*$/i,
    // English: Correct Answer / Correct option / Answer / Ans
    /^\s*(?:Correct\s+Answer|Correct\s+option|Correct|Ans(?:wer)?\.?)\s*(?:is)?\s*[:\-=—ঃ.:]?\s*(.+?)\s*$/i,
    // Generic fallback: "Answer: B" with optional Key/Solution
    /^\s*(?:Answer\s*Key|Key|Solution)\s*[:\-=—ঃ.:]?\s*(.+?)\s*$/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) {
      let payload = (m[1] ?? "").trim();
      // Strip trailing ব্যাখ্যা:/Explanation: that might be on the same line
      payload = payload.replace(/\s*(?:ব্যাখ্যা\s*ঃ?|Explanation|Explan\.?)\s*[:\-=—ঃ.:].*$/i, "").trim();
      // payload may include trailing punctuation like "." or "."
      payload = payload.replace(/^[\(\[]\s*/, "").replace(/\s*[\)\]]\s*$/, "").trim();
      payload = payload.replace(/[\.\)\:\-]+$/g, "").trim();
      if (payload) return payload;
    }
  }
  // Also handle case where answer prefix and payload are separated by Bangla colon "："?
  // Already covered.
  return null;
}

// A line that is ONLY a per-question answer prefix ("Correct Answer:" with no
// payload). The payload may sit on the next line ("Answer:\nB") — joinable,
// never A. NOTE: key-section headings ("Answer Key:", "Solution:") are
// deliberately EXCLUDED here — those belong to the answer-key flow, and this
// check must run BEFORE the key-section defense below.
const BARE_QUESTION_ANSWER_PREFIX_RE =
  /^\s*(?:সঠিক\s*উত্তর|উত্তর|Correct\s+Answer|Correct\s+option|Correct|Ans(?:wer)?\.?)\s*[:\-=—ঃ.:]\s*$/i;

function isBareAnswerPrefix(line: string): boolean {
  return BARE_QUESTION_ANSWER_PREFIX_RE.test(line);
}

/** True when a line may serve as the payload of a preceding bare answer prefix. */
function isJoinableAnswerContinuation(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (isQuestionHeaderLine(line)) return false;
  if (parseOptionLine(line, true) !== null) return false;
  if (extractAnswerPayload(line) !== null) return false;
  if (extractExplanationPayload(line) !== null) return false;
  if (isMarkLine(line)) return false;
  if (answerKeyHeadingRemainder(line) !== null) return false;
  return true;
}

// ── explanation detection ─────────────────────────────────────────────────
function extractExplanationPayload(line: string): string | null {
  const t = line.trim();
  if (!t) return null;
  const patterns: RegExp[] = [
    // Bangla ব্যাখ্যা
    /^\s*ব্যাখ্যা\s*ঃ?\s*[:\-=—ঃ.:]?\s*(.+?)\s*$/i,
    // English Explanation
    /^\s*(?:Explanation|Explan\.?)\s*[:\-=—ঃ.:]?\s*(.+?)\s*$/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) {
      let payload = (m[1] ?? "").trim();
      // Remove trailing punctuation that is likely answer marker remnants
      payload = payload.replace(/[\.\)\:\-]+$/g, "").trim();
      if (payload) return payload;
    }
  }
  return null;
}

/** Compare free text against the four option texts (normalized). Content is
 *  ground truth when the answer line carries the option text itself. */
function matchTextToOptionIndex(
  text: string,
  options: [string, string, string, string],
): number | null {
  const normPayload = normalizeForCompare(text);
  if (!normPayload) return null;
  // Substrings (e.g. "globin" or "not Oxygen") are not confident answers.
  // Require a unique normalized match, allowing comma/space differences in
  // combination answers such as "1, 2" versus "1,2".
  const compactPayload = normPayload.replace(/[\s,]+/g, "");
  const matches: number[] = [];
  for (let i = 0; i < 4; i++) {
    if (!options[i]?.trim()) continue;
    const normOpt = normalizeForCompare(options[i]);
    if (normOpt === normPayload || normOpt.replace(/[\s,]+/g, "") === compactPayload) matches.push(i);
  }
  return matches.length === 1 ? matches[0] : null;
}

function mapAnswerPayloadToIndex(payload: string, options: [string, string, string, string]): number | null {
  const raw = payload.trim();
  if (!raw) return null;
  // Remove surrounding brackets/parens and trailing dot
  const clean = raw.replace(/^[\(\[]\s*/, "").replace(/\s*[\)\]\.]+$/g, "").trim();

  // 1) Single label check
  // English A-D
  if (/^[A-Da-d]$/.test(clean)) {
    return clean.toUpperCase().charCodeAt(0) - 65;
  }
  // Bangla
  if (/^[কখগঘ]$/.test(clean)) {
    return BN_OPT_MAP[clean];
  }
  // Numeric 1-4 / Bangla ১-৪
  if (/^[1-4]$/.test(clean) || /^[১-৪]$/.test(clean)) {
    const ascii = bnDigitsToAscii(clean);
    const idx = parseInt(ascii, 10) - 1;
    if (idx >= 0 && idx < 4) return idx;
  }
  // Roman i-iv
  const romanIdx = romanToIndex(clean);
  if (romanIdx !== null) return romanIdx;

  // Handle payload like "B." or "(B)" already stripped, but also "Option B" etc. Not needed.

  // 2) Full text match: compare normalized payload with each option text
  const viaText = matchTextToOptionIndex(clean, options);
  if (viaText !== null) return viaText;
  // 2b) Leading letter marker with trailing text, e.g. "(d) Shark", "D - Shark",
  // "D: Shark", "[B] Urochrome". The remainder text is matched first (content is
  // ground truth against the current option order); when it does not match,
  // the explicit letter is trusted over returning unknown.
  const lead = clean.match(
    /^(?:\(\s*([A-Da-d])\s*[\)\]\.:]|\[\s*([A-Da-d])\s*[\]\)\.:]|([A-Da-d])\s*[\)\.\:\-\—–])\s+(\S[\s\S]*)$/,
  );
  if (lead) {
    const letter = (lead[1] ?? lead[2] ?? lead[3] ?? "").toUpperCase();
    const rest = (lead[4] ?? "").trim();
    if (rest) {
      const viaRest = matchTextToOptionIndex(rest, options);
      if (viaRest !== null) return viaRest;
    }
    if (/^[A-D]$/.test(letter)) return letter.charCodeAt(0) - 65;
  }
  const bnLead = clean.match(
    /^(?:\(\s*([কখগঘ])\s*[\)\]\.:।]|\[\s*([কখগঘ])\s*[\]\)\.:।]|([কখগঘ])\s*[\)\.\:\-\—–।])\s+(\S[\s\S]*)$/,
  );
  if (bnLead) {
    const letter = bnLead[1] ?? bnLead[2] ?? bnLead[3] ?? "";
    const rest = (bnLead[4] ?? "").trim();
    if (rest) {
      const viaRest = matchTextToOptionIndex(rest, options);
      if (viaRest !== null) return viaRest;
    }
    if (/^[কখগঘ]$/.test(letter)) return BN_OPT_MAP[letter] ?? null;
  }
  const namedLabel = clean.match(/^(?:option|অপশন)\s+([A-Da-dকখগঘ])$/i);
  return namedLabel ? answerLetterToIndex(namedLabel[1]) : null;
}

// ── answer-key section detection (trailing "Answer Key:" block) ─────────────
// The pasted content may end with a separate Answer Key section, e.g.:
//   Answer Key:
//   1. B
//   2. C
//   ...
// This section must NOT be parsed as questions/options. It is stripped before
// question parsing, then each entry is mapped back to its question by the
// ORIGINAL question number (before the system renumbers Q01..QNN).

function answerKeyHeadingRemainder(line: string): string | null {
  // Strip decorative borders like "--- Answer Key ---" / "*** উত্তরমালা ***"
  let t = line.trim();
  if (!t) return null;
  t = t.replace(/^[\-\=*_#~•\s]+/, "").replace(/[\-\=*_#~•\s]+$/, "").trim();
  if (!t) return null;
  // Heading prefix — longer alternatives first (উত্তরমালা before উত্তর, etc.)
  const m = t.match(
    /^(Answer\s*Keys?|Answers?\s*(?:Key|Sheet|List)|Correct\s*Answers?|Ans(?:wer)?s?\s*Key|Ans(?:wer)?s?|উত্তর\s*মালা|উত্তরমালা|উত্তরপত্র|উত্তর\s*সমূহ|উত্তরসমূহ|সঠিক\s*উত্তর\s*মালা|সঠিক\s*উত্তর\s*সমূহ|সঠিক\s*উত্তর|উত্তর)\s*[:\-=—ঃ.]?\s*(.*)$/i,
  );
  if (!m) return null;
  const remainder = (m[2] ?? "").trim().replace(/^[:\-=—ঃ.\s]+/, "").trim();
  return remainder;
}

// True when a string is just a single answer label (per-question "Answer: B"),
// which must NOT be treated as an answer-key heading. 4-option only (A–D).
function isSingleAnswerLabel(s: string): boolean {
  const c = s.trim().replace(/^[\(\[]\s*/, "").replace(/\s*[\)\]\.]+$/g, "").trim();
  if (/^[A-Da-d]$/.test(c)) return true;
  if (/^[কখগঘ]$/.test(c)) return true;
  if (/^[1-4]$/.test(c) || /^[১-৪]$/.test(c)) return true;
  if (/^(i{1,3}|iv|I{1,3}|IV)$/.test(c)) return true;
  // "Option B" style single answer
  if (/^(?:option|অপশন)\s*[A-Da-d]$/.test(c.trim())) return true;
  return false;
}

export function answerKeyLabelToIndex(label: string): number | null {
  const c = label.trim().replace(/^[\(\[]\s*/, "").replace(/\s*[\)\]]$/g, "").trim();
  if (/^[A-Da-d]$/.test(c)) return c.toUpperCase().charCodeAt(0) - 65;
  if (/^[কখগঘ]$/.test(c)) return BN_OPT_MAP[c] ?? null;
  if (/^[1-4]$/.test(c)) return parseInt(c, 10) - 1;
  if (/^[১-৪]$/.test(c)) return parseInt(bnDigitsToAscii(c), 10) - 1;
  const r = romanToIndex(c);
  if (r !== null) return r;
  return null;
}

// Parse "1. B", "2-C", "3: A", "4) D", "Q5: b", "১. খ" etc. from key block text.
// Multiple entries per line ("1. B 2. C", "1-B, 2-C") are all captured.
// 4-option only: indices are always 0..3, matching the inline answer path.
const ANSWER_KEY_ENTRY_RE =
  /(?:^|[\s,;|।]+)(?:Q(?:uestion)?\s*|প্রশ্ন\s*(?:নং\.?|No\.?)?\s*)?([0-9০-৯]+)(?:\s*[\.\)\]:\-–—=ঃ।]+\s*\(?\s*|[ \t]+(?=[A-Da-dকখগঘ])|(?=[A-Da-dকখগঘ]))([A-Da-d]|[কখগঘ]|[1-4]|[১-৪]|iv|IV|i{1,3}|I{1,3})[ \t]*\)?(?![A-Za-z\u0980-\u09FF0-9])/g;

function parseAnswerKeyEntries(keyText: string): Map<number, string> {
  return parseStandaloneAnswerKey(keyText).entries;
}

// ── standalone answer-key detection (separate Answer Key workflow) ──────────
// Parses a dedicated answer-key input (NOT trailing section of questions).
// Supports compact + continuous formats with NO truncation limit:
//   "1. A", "2-B", "3: C", "4) D", "5 A", "1A 2B 3C",
//   "1-A, 2-B, 3-C", "Q1: b", "১. খ", "উত্তরমালা / Answer Key:" headings.
// Matching downstream is by QUESTION NUMBER (never array position).
export type StandaloneAnswerKeyResult = {
  /** question number → raw answer label (first entry wins on duplicates) */
  entries: Map<number, string>;
  /** question numbers in first-seen order */
  order: number[];
  /** question numbers seen more than once (duplicates, second+ ignored) */
  duplicates: number[];
  /** total raw matches found (including duplicates) */
  totalFound: number;
};

function stripStandaloneKeyHeadings(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const rem = answerKeyHeadingRemainder(line);
    if (rem === null) {
      kept.push(line);
      continue;
    }
    if (rem === "") continue; // pure heading line ("Answer Key:") — drop
    if (isSingleAnswerLabel(rem)) {
      kept.push(line); // e.g. "Answer: B" alone — keep, may hold an entry
      continue;
    }
    // Heading with inline entries ("Answer Key: 1-A 2-B") — keep remainder + rest
    kept.push(rem);
  }
  return kept.join("\n");
}

function collectKeyMatches(
  keyText: string,
  re: RegExp,
  out: Map<number, string>,
  duplicates: number[],
  seenCount: Map<number, number>,
): number {
  let found = 0;
  // Fresh regex instance per call (global flag) to avoid lastIndex carryover
  const rx = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = rx.exec(keyText)) !== null) {
    const numAscii = bnDigitsToAscii(m[1]);
    const qNum = parseInt(numAscii, 10);
    if (!Number.isFinite(qNum) || qNum <= 0 || qNum > 1000) continue;
    const label = (m[2] ?? "").trim();
    if (answerKeyLabelToIndex(label) === null) continue;
    found += 1;
    seenCount.set(qNum, (seenCount.get(qNum) ?? 0) + 1);
    if (out.has(qNum)) {
      if (!duplicates.includes(qNum)) duplicates.push(qNum);
      continue; // first entry wins, never guess on duplicates
    }
    out.set(qNum, label);
  }
  return found;
}

export function parseStandaloneAnswerKey(rawText: string): StandaloneAnswerKeyResult {
  const out = new Map<number, string>();
  const duplicates: number[] = [];
  const seenCount = new Map<number, number>();
  const order: number[] = [];
  if (!rawText || !rawText.trim()) return { entries: out, order, duplicates, totalFound: 0 };
  const keyText = stripStandaloneKeyHeadings(normalizePasteText(rawText));
  if (!keyText.trim()) return { entries: out, order, duplicates, totalFound: 0 };

  // Scan all supported formats together in physical order so the first
  // duplicate wins regardless of whether it uses spaces, dots or no separator.
  const totalFound = collectKeyMatches(keyText, ANSWER_KEY_ENTRY_RE, out, duplicates, seenCount);

  out.forEach((_v, k) => order.push(k));
  order.sort((a, b) => a - b);
  duplicates.sort((a, b) => a - b);
  return { entries: out, order, duplicates, totalFound };
}

/** Original question number → parsed-question index (first unused wins). */
export function buildQuestionNumberMap(
  originalNumbers: Array<string | null | undefined>,
): Map<number, number> {
  const numToIdx = new Map<number, number>();
  originalNumbers.forEach((header, i) => {
    const n = originalHeaderToNumber(header) ?? i + 1;
    if (!numToIdx.has(n)) numToIdx.set(n, i);
  });
  return numToIdx;
}

export function questionNumberForIndex(
  originalNumber: string | null | undefined,
  fallbackIndex: number,
): number {
  return originalHeaderToNumber(originalNumber) ?? fallbackIndex + 1;
}

function splitAnswerKeySection(text: string): {
  mainText: string;
  keyEntries: Map<number, string>;
  keyFound: boolean;
} {
  const empty = { mainText: text, keyEntries: new Map<number, string>(), keyFound: false };
  const lines = text.split("\n");
  // Collect heading candidates
  const candidates: { idx: number; remainder: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const rem = answerKeyHeadingRemainder(lines[i]);
    if (rem === null) continue;
    if (rem !== "" && isSingleAnswerLabel(rem)) continue; // per-question "Answer: B"
    candidates.push({ idx: i, remainder: rem });
  }
  if (candidates.length === 0) return empty;
  // Prefer the LAST heading that yields ≥1 entry (key lives at the very end)
  for (let c = candidates.length - 1; c >= 0; c--) {
    const { idx, remainder } = candidates[c];
    const tail = (remainder ? remainder + "\n" : "") + lines.slice(idx + 1).join("\n");
    if (!tail.trim()) continue;
    // A per-question "Answer:" is also a possible heading. Never cut off
    // subsequent questions merely because their numeric options resemble keys.
    const remainderText = stripStandaloneKeyHeadings(tail).replace(ANSWER_KEY_ENTRY_RE, "").replace(/[\s,;|।]+/g, "");
    if (remainderText) continue;
    const entries = parseAnswerKeyEntries(tail);
    if (entries.size === 0) continue;
    const mainText = lines.slice(0, idx).join("\n").trim();
    if (!mainText) continue; // no questions before key — ignore
    return { mainText, keyEntries: entries, keyFound: true };
  }
  return empty;
}

function originalHeaderToNumber(header: string | null | undefined): number | null {
  if (!header) return null;
  const ascii = bnDigitsToAscii(header);
  const m = ascii.match(/\d+/);
  if (m) {
    const n = parseInt(m[0], 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const roman = ascii.trim().replace(/[.)\-]+$/, "").trim().toUpperCase();
  if (!/^(?=.)M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/.test(roman)) return null;
  const values: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let n = 0;
  for (let i = 0; i < roman.length; i++) {
    const value = values[roman[i]];
    n += value < (values[roman[i + 1]] ?? 0) ? -value : value;
  }
  return n > 0 ? n : null;
}

// Apply trailing answer-key entries to parsed questions by ORIGINAL number.
// Key is authoritative: a confident key entry overrides any inline answer.
// Questions with no key entry keep their inline answer (if any); if the final
// correct answer is still unknown the question is flagged for manual review.
function applyAnswerKey(
  parsed: ParsedPasteMcq[],
  keyEntries: Map<number, string>,
): ParsedPasteMcq[] {
  if (keyEntries.size === 0) return parsed;
  // Original number → question index (first unused wins on duplicates)
  const numToIdx = new Map<number, number>();
  parsed.forEach((p, i) => {
    const n = originalHeaderToNumber(p.originalNumber) ?? i + 1;
    if (!numToIdx.has(n)) numToIdx.set(n, i);
  });
  const assigned = new Set<number>();
  keyEntries.forEach((label, qNum) => {
    const targetIdx = numToIdx.get(qNum);
    if (targetIdx === undefined) return; // no matching question — ignore, never guess
    const optIdx = answerKeyLabelToIndex(label);
    if (optIdx === null || optIdx < 0 || optIdx > 3) return;
    parsed[targetIdx].correctIndex = optIdx;
    assigned.add(targetIdx);
  });
  // Recompute issues/flags per question
  return parsed.map((p, i) => {
    const issues = (p.issues ?? []).filter(
      (x) => x !== "Answer could not be confidently detected — please verify.",
    );
    if (p.correctIndex === null || p.correctIndex === undefined) {
      issues.push("No answer-key entry found for this question — please verify.");
    } else if (!p.options[p.correctIndex]?.trim()) {
      issues.push(
        `Correct answer ${String.fromCharCode(65 + (p.correctIndex ?? 0))} is empty — please verify.`,
      );
    }
    // De-dupe while preserving order
    const seen = new Set<string>();
    const deduped = issues.filter((x) => (seen.has(x) ? false : (seen.add(x), true)));
    const needsReview = deduped.length > 0;
    return {
      ...p,
      issues: deduped,
      needsReview,
      confidence: needsReview
        ? p.options.filter((o) => o.trim()).length >= 2 && p.question.length >= 3
          ? 0.75
          : 0.4
        : 0.96,
    };
  });
}
function isStatementLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  // Only English A-D and Bangla option styles are true options that should not be considered statements.
  // Numeric 1-4 and roman i-iv may be either statements or options; treat as statements when before options.
  const first = t.charAt(0);
  if (/[A-Da-dকখগঘ]/.test(first)) {
    if (parseOptionLine(t, false) !== null) return false;
  } else if (t.startsWith("(") || t.startsWith("[")) {
    // e.g., (A) or [ক)
    if (parseOptionLine(t, false) !== null) return false;
  }
  if (extractAnswerPayload(t) !== null) return false;
  // Arabic numerals 1-9 with dot/paren
  if (/^\s*[1-9]\s*[.)\-:]\s+.+/.test(t)) return true;
  if (/^\s*[১-৯০]\s*[.)\-:।]\s*.+/.test(t)) return true;
  if (/^\s*(?:i{1,3}|iv|v|vi{1,3}|ix|x)\s*[.)\-:]\s+.+/i.test(t)) return true;
  if (/^\s*(?:I{1,3}|IV|VI{1,3}|IX|X)\s*[.)\-:]\s+.+/.test(t)) return true;
  return false;
}

// ── inline helpers ─────────────────────────────────────────────────────────
// A line that already carries an explicit answer payload must keep that
// payload on the SAME line — option-marker splitting must never cut inside it
// (e.g. "Correct Answer: (c) Shark" must not become "Correct Answer:" + "(c) Shark").
// The guard is a lookbehind placed AFTER the lookahead in each rule below, so
// it is evaluated at the post-whitespace position: with the `m` flag, `^`
// anchors at line starts and `[^\n]*` cannot cross lines, so a split
// positioned after an answer prefix on the same line is suppressed while
// splits before the prefix (real inline options) still work.
const NOT_IN_ANSWER_LINE = String.raw`(?<!^[^\n]*(?:সঠিক\s*উত্তর|উত্তর|Correct\s+Answer|Correct\s+option|Correct|Ans(?:wer)?\.?|Answer\s*Key|Key|Solution)\s*[:\-=—ঃ.:][^\n]*)`;

function injectNewlinesForInline(text: string): string {
  // Insert newline before option markers that appear inline after at least one space, if not already at line start
  // This helps split "Q? A. opt B. opt" into separate lines
  // We do replacements for each option style
  let s = text;
  try {
  // We need to handle option markers inline: detect patterns preceded by whitespace and not at start of line
  // Use a function to insert \n before each match that is not at line start
  const optionInlineRe = /[ \t]{1,}(?=((?:\(?\s*[A-Da-d]\s*\)?\s*[\.\)\:\-]\s+)|(?:\(?\s*[কখগঘ]\s*\)?\s*[\.\)\:\-।]?\s+)|(?:\(?\s*[1-4]\s*\)?\s*[\.\)\:\-]\s+)|(?:\(?\s*[১-৪]\s*\)?\s*[\.\)\:\-।]?\s+)|(?:\(?\s*(?:i{1,3}|iv)\s*\)?\s*[\.\)\:\-]\s+)|(?:\(?\s*(?:I{1,3}|IV)\s*\)?\s*[\.\)\:\-]\s+)))/g;
  // Instead of complex lookahead, we scan and insert
  // Simpler: replace occurrences of "  A. " or " A. " with "\nA. " when not at line start via regex with capture
  // Every rule below carries the NOT_IN_ANSWER_LINE guard AFTER its lookahead
  // (needs the `m` flag so `^` anchors at line starts).
  s = s.replace(new RegExp(`([^\\n])[ \\t]+(?=[A-Da-d]\\s*[\\.\\)\\:\\-])${NOT_IN_ANSWER_LINE}`, "gm"), "$1\n");
  s = s.replace(new RegExp(`([^\\n])[ \\t]+(?=\\([A-Da-d]\\)\\s*[\\.\\)\\:\\-]?)${NOT_IN_ANSWER_LINE}`, "gm"), "$1\n");
  s = s.replace(new RegExp(`([^\\n])[ \\t]+(?=[কখগঘ]\\s*[\\.\\)\\:\\-।])${NOT_IN_ANSWER_LINE}`, "gm"), "$1\n");
  s = s.replace(new RegExp(`([^\\n])[ \\t]+(?=\\([কখগঘ]\\))${NOT_IN_ANSWER_LINE}`, "gm"), "$1\n");
  s = s.replace(new RegExp(`([^\\n])[ \\t]+(?=\\[[A-Da-dকখগঘ]\\])${NOT_IN_ANSWER_LINE}`, "gm"), "$1\n");
  s = s.replace(new RegExp(`([^\\n])[ \\t]{2,}(?=[1-4]\\s*[\\.\\)\\:\\-])${NOT_IN_ANSWER_LINE}`, "gm"), "$1\n");
  s = s.replace(new RegExp(`([^\\n])[ \\t]{2,}(?=[১-৪]\\s*[\\.\\)\\:\\-।])${NOT_IN_ANSWER_LINE}`, "gm"), "$1\n");
  // Roman inline
  s = s.replace(new RegExp(`([^\\n])[ \\t]{2,}(?=(?:i{1,3}|iv)\\s*[\\.\\)\\:\\-])${NOT_IN_ANSWER_LINE}`, "gim"), "$1\n");
  s = s.replace(new RegExp(`([^\\n])[ \\t]{2,}(?=(?:I{1,3}|IV)\\s*[\\.\\)\\:\\-])${NOT_IN_ANSWER_LINE}`, "gm"), "$1\n");
  // Answer inline: handle multi-word prefixes first, then single-word with lookbehind to avoid splitting "Correct Answer" inside
  s = s.replace(/([^\n])[ \t]+(?=(?:Correct\s+Answer|Correct\s+option|সঠিক\s+উত্তর)\s*[:\-=—ঃ.:])/gi, "$1\n");
  s = s.replace(/([^\n])[ \t]+(?<!Correct\s)(?<!সঠিক\s)(?=(?:Ans(?:wer)?\.?|Correct|উত্তর\s*ঃ?)\s*[:\-=—ঃ.:])/gi, "$1\n");
  // Explanation inline: ব্যাখ্যা: / Explanation:
  s = s.replace(/([^\n])[ \t]+(?=(?:ব্যাখ্যা\s*ঃ?|Explanation|Explan\.?)\s*[:\-=—ঃ])/gi, "$1\n");
  // A number inside a stem/header is not a new question. Only split an
  // inline header after an answer, and never let whitespace span newlines.
  s = s.replace(/[ \t]+(?=(?:Q[ \t]*[.\-]?[ \t]*[0-9০-৯]+[ \t]*[.):\-।]|Question[ \t]*(?:No\.?)?[ \t]*[0-9০-৯]+[ \t]*[.):\-]|প্রশ্ন[ \t]*(?:নং\.?)?[ \t]*[0-9০-৯]+[ \t]*[.):\-।]|[0-9০-৯]+[ \t]*[.)।][ \t]+[^\n]{3,}|[IVXLCDM]+[.)][ \t]+\S))/gi,
    (space, offset: number, source: string) => {
      const prefix = source.slice(source.lastIndexOf("\n", offset - 1) + 1, offset);
      return /(?:সঠিক\s*উত্তর|উত্তর|Correct\s+Answer|Ans(?:wer)?\.?)\s*[:=ঃ\-]/i.test(prefix) ? "\n" : space;
    });
  } catch {
    return text;
  }

  return s;
}

// ── block parsing ──────────────────────────────────────────────────────────
function parseSingleBlock(blockText: string): ParsedPasteMcq {
  const rawBlock = blockText;
  // Preprocess inline newlines for this block
  const withInlines = injectNewlinesForInline(blockText);
  const linesRaw = withInlines.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  // We'll parse lines
  let questionLines: string[] = [];
  const options: [string, string, string, string] = ["", "", "", ""];
  let correctIndex: number | null = null;
  let answerPayloadRaw: string | null = null;
  let originalNumber: string | null = null;
  let optionMarkerCorrectIdx: number | null = null;

  // First pass: collect answer payloads, explanation, and options, separate question
  const nonAnswerLines: string[] = [];
  let explanationRaw: string | null = null;
  for (let i = 0; i < linesRaw.length; i++) {
    const line = linesRaw[i];
    // Bare per-question answer prefix ("Correct Answer:" alone) — the payload
    // may sit on the next line ("Answer:\nB"). Join it when eligible; must run
    // BEFORE the key-section defense (a bare prefix is not a key heading).
    // Otherwise the answer stays unknown (null), never A, and the stray line
    // never becomes question/option text.
    if (isBareAnswerPrefix(line)) {
      let j = i + 1;
      while (j < linesRaw.length && !linesRaw[j].trim()) j++;
      const next = j < linesRaw.length ? linesRaw[j] : "";
      if (next && isJoinableAnswerContinuation(next)) {
        const joined = extractAnswerPayload(`${line.trim()} ${next.trim()}`);
        if (joined !== null) {
          answerPayloadRaw = joined; // keep last
          i = j;
          continue;
        }
      }
      continue;
    }
    // Defense-in-depth: a bare answer-key heading that survived section
    // splitting must never become question/option text.
    const keyRem = answerKeyHeadingRemainder(line);
    if (keyRem !== null && (keyRem === "" || parseAnswerKeyEntries(keyRem).size > 0 || parseAnswerKeyEntries(line).size > 0)) {
      if (keyRem === "" || !isSingleAnswerLabel(keyRem)) continue;
    }
    const payload = extractAnswerPayload(line);
    if (payload !== null) {
      // This line is answer
      answerPayloadRaw = payload; // keep last
      // Don't add to nonAnswerLines
      continue;
    }
    const explanationPayload = extractExplanationPayload(line);
    if (explanationPayload !== null) {
      // This line is explanation — store separately, don't add to nonAnswerLines
      explanationRaw = explanationPayload;
      continue;
    }
    if (isMarkLine(line)) {
      // Fixed mark = 1 per spec — silently skip MARK lines
      continue;
    }
    nonAnswerLines.push(line);
  }

  // Locate the option group by context, not by a contiguous suffix: PDF/Word
  // wrapping may put continuation text between any two option labels.
  let optionStartIdx = -1;
  for (let i = 0; i < nonAnswerLines.length; i++) {
    const line = nonAnswerLines[i];
    if (i === 0 && isQuestionHeaderLine(line)) continue;
    const option = parseOptionLine(line, true);
    if (option && (optionLabelStyle(line) === "letter" || isAmbiguousOptionRun(nonAnswerLines, i))) {
      optionStartIdx = i;
      break;
    }
  }
  questionLines = nonAnswerLines.slice(0, optionStartIdx >= 0 ? optionStartIdx : nonAnswerLines.length);
  if (questionLines.length > 0) {
    const header = stripQuestionHeader(questionLines[0]);
    if (header) {
      originalNumber = header.header;
      if (header.stripped) questionLines[0] = header.stripped;
      else questionLines.shift();
    }
  }
  let lastOptionIndex = -1;
  if (optionStartIdx >= 0) {
    const style = optionLabelStyle(nonAnswerLines[optionStartIdx]);
    for (const line of nonAnswerLines.slice(optionStartIdx)) {
      const option = parseOptionLine(line, true);
      if (option && optionLabelStyle(line) === style) {
        lastOptionIndex = option.index;
        options[option.index] = options[option.index]
          ? `${options[option.index]} ${option.text}` : option.text;
        if (option.isCorrectMarker && optionMarkerCorrectIdx === null) optionMarkerCorrectIdx = option.index;
      } else if (lastOptionIndex >= 0) {
        options[lastOptionIndex] = `${options[lastOptionIndex]} ${cleanOptionText(line)}`.trim();
      }
    }
  }

  let question = "";
  if (questionLines.length > 0) {
    // If questionLines contains multiple statement lines, join with newline to preserve structure
    if (questionLines.length === 1) question = questionLines[0].replace(/\s+/g, " ").trim();
    else {
      // Check if any line is statement-like (starts with number) or an
      // equation continuation (physics/math multiline) → keep newlines.
      const hasStmt = questionLines.some((l) => isStatementLine(l));
      const hasEq = questionLines.some((l) => isEquationContinuation(l));
      if (hasStmt || hasEq) question = questionLines.join("\n").replace(/[ \t]+\n/g, "\n").trim();
      else question = questionLines.join(" ").replace(/\s+/g, " ").trim();
    }
  }
  if (!question) {
    // Fallback: take first non-option line as question
    const firstNonOption = nonAnswerLines.find((l) => !parseOptionLine(l, true));
    if (firstNonOption) {
      const sh = stripQuestionHeader(firstNonOption);
      question = sh ? (sh.stripped || firstNonOption) : firstNonOption;
      question = question.replace(/\s+/g, " ").trim();
    }
  }

  // Resolve answer
  if (answerPayloadRaw !== null) {
    const mapped = mapAnswerPayloadToIndex(answerPayloadRaw, options);
    if (mapped !== null) correctIndex = mapped;
  }
  if (correctIndex === null && optionMarkerCorrectIdx !== null) correctIndex = optionMarkerCorrectIdx;

  // Issues
  const issues: string[] = [];
  if (!question || question.length < 3) issues.push("Question text missing or too short");
  const filledCount = options.filter((o) => o.trim().length > 0).length;
  if (filledCount < 4) {
    const missing = options.map((o, i) => (!o.trim() ? String.fromCharCode(65 + i) : null)).filter(Boolean) as string[];
    if (missing.length) issues.push(`Missing option ${missing.join(", ")}`);
  }
  if (filledCount < 2) issues.push("At least 2 options required");
  if (correctIndex === null) issues.push("Answer could not be confidently detected — please verify.");
  else if (correctIndex < 0 || correctIndex >= 4 || !options[correctIndex]?.trim()) issues.push(`Correct answer ${String.fromCharCode(65 + (correctIndex ?? 0))} is empty`);

  const needsReview = issues.length > 0;
  const confidence = needsReview ? (filledCount >= 2 && question.length >= 3 ? 0.75 : 0.4) : 0.96;

  return {
    question,
    options,
    correctIndex,
    explanation: explanationRaw ?? "",
    marks: 1,
    rawBlock,
    issues,
    needsReview,
    confidence,
    originalNumber,
  };
}

// True when a block contains 2+ inline option markers on the same line,
// e.g. "ক) .. খ) .. গ) .. ঘ)" or "A. .. B. .. C. .. D. .." pasted without
// newlines. Used to force the inline fallback even when statement-guard fires.
function hasInlineOptionMarkers(blockText: string): boolean {
  const re =
    /(?:\(?\s*[A-Da-d]\s*\)?\s*[\.\)\:\-\—]\s+|\(?\s*[কখগঘ]\s*\)?\s*[\.\)\:\-।]?\s+|\(?\s*[1-4]\s*\)?\s*[\.\)\:\-]\s+|\(?\s*[১-৪]\s*\)?\s*[\.\)\:\-।]?\s+|\(?\s*(?:iv|i{1,3})\s*\)?\s*[\.\)\:\-]\s+)/gi;
  let count = 0;
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(blockText)) !== null) {
    count++;
    if (count >= 2) return true;
    if (m[0].length === 0) re.lastIndex++;
  }
  return false;
}

// Fallback inline extraction for blocks where line-based fails (e.g., no newlines)
function parseSingleBlockInline(blockText: string): ParsedPasteMcq | null {
  const rawBlock = blockText;
  // Find answer first
  const answerRe = /(?:উত্তর\s*ঃ?\s*[:\-=—.]?|সঠিক\s*উত্তর\s*ঃ?\s*[:\-=—.]?|Ans(?:wer)?\.?\s*(?:is)?\s*[:\-=—.]?|Correct(?:\s+Answer)?\s*(?:is)?\s*[:\-=—.]?)\s*([^\n\r]*?)(?:\s*(?:ব্যাখ্যা\s*ঃ?|Explanation|Explan\.?)\s*[:\-=—.]|$)/gi;
  // We'll work on normalized block without injecting newlines
  let answerPayload: string | null = null;
  let answerPos = -1;
  let mAns: RegExpExecArray | null;
  // Find last answer occurrence
  const tempAnsMatches: { payload: string; index: number }[] = [];
  while ((mAns = answerRe.exec(blockText)) !== null) {
    let p = (mAns[1] ?? "").trim();
    p = p.replace(/^[\(\[]\s*/, "").replace(/\s*[\)\]\.]+$/g, "").trim();
    if (p) tempAnsMatches.push({ payload: p, index: mAns.index });
  }
  if (tempAnsMatches.length > 0) {
    const last = tempAnsMatches[tempAnsMatches.length - 1];
    answerPayload = last.payload;
    answerPos = last.index;
  }
  const textBeforeAnswer = answerPos >= 0 ? blockText.slice(0, answerPos) : blockText;

  // Find explanation (after answer)
  const textAfterAnswer = answerPos >= 0 ? blockText.slice(answerPos) : "";
  const explanationRe = /(?:ব্যাখ্যা\s*ঃ?\s*[:\-=—.]?|Explanation|Explan\.?)\s*[:\-=—.]?\s*([^\n\r]+)/gi;
  let explanationPayload: string | null = null;
  let mExp: RegExpExecArray | null;
  while ((mExp = explanationRe.exec(textAfterAnswer)) !== null) {
    let p = (mExp[1] ?? "").trim();
    p = p.replace(/^[\(\[]\s*/, "").replace(/\s*[\)\]\.]+$/g, "").trim();
    if (p) explanationPayload = p;
  }

  // Find option markers globally
  const optGlobalRe = /(?:\(\s*([A-Da-d])\s*\)|[\(\[]\s*([A-Da-d])\s*[\)\]]|([A-Da-d])\s*[\.\)\:\-\—]|\([কখগঘ]\)|([কখগঘ])\s*[\.\)\:\-।]|\(([কখগঘ])\)|([1-4])\s*[\.\)\:\-]|([১-৪])\s*[\.\)\:\-।]|(i{1,3}|iv)\s*[\.\)\:\-]|(I{1,3}|IV)\s*[\.\)\:\-])/g;
  // Simpler: use parseOptionLine positions by scanning with regex for each style separately
  // Instead, collect positions via exec of a unified regex that captures label and delimiter
  const unifiedRe = /(?:\(?\s*([A-Da-d])\s*\)?\s*[\.\)\:\-\—]\s+|\(?\s*([কখগঘ])\s*\)?\s*[\.\)\:\-।]?\s+|\(?\s*([1-4])\s*\)?\s*[\.\)\:\-]\s+|\(?\s*([১-৪])\s*\)?\s*[\.\)\:\-।]?\s+|\(?\s*(i{1,3}|iv)\s*\)?\s*[\.\)\:\-]\s+|\(?\s*(I{1,3}|IV)\s*\)?\s*[\.\)\:\-]\s+)/gi;
  const matches: { start: number; end: number; label: string; style: string }[] = [];
  let m: RegExpExecArray | null;
  unifiedRe.lastIndex = 0;
  while ((m = unifiedRe.exec(textBeforeAnswer)) !== null) {
    const start = m.index;
    const end = m.index + m[0].length;
    let label = "";
    let style = "";
    if (m[1]) { label = m[1]; style = "en"; }
    else if (m[2]) { label = m[2]; style = "bn"; }
    else if (m[3]) { label = m[3]; style = "num"; }
    else if (m[4]) { label = m[4]; style = "bnNum"; }
    else if (m[5]) { label = m[5]; style = "romanL"; }
    else if (m[6]) { label = m[6]; style = "romanU"; }
    matches.push({ start, end, label, style });
    if (m[0].length === 0) unifiedRe.lastIndex++;
  }
  // Drop a leading question number mis-matched as numeric option ("1. Q? ..."):
  // if the first marker sits at the very start and is numeric, and 2+ real
  // letter options follow, it is the question header, not an option.
  if (
    matches.length >= 3 &&
    matches[0].start <= 2 &&
    (matches[0].style === "num" || matches[0].style === "bnNum")
  ) {
    const restStyles = matches.slice(1).map((x) => x.style);
    const letterCount = restStyles.filter((s) => s === "en" || s === "bn").length;
    if (letterCount >= 2) matches.shift();
  }
  if (matches.length < 2) return null;
  // Find last consecutive group of 2-4 matches that are valid options
  // Take last up to 4 matches as candidate option group
  const candidateGroup = matches.slice(-4);
  // Need to ensure they are distinct indices 0-3
  const tmpOptions: [string, string, string, string] = ["", "", "", ""];
  let hasValid = false;
  for (let k = 0; k < candidateGroup.length; k++) {
    const cg = candidateGroup[k];
    let idx: number | null = null;
    if (cg.style === "en") idx = cg.label.toUpperCase().charCodeAt(0) - 65;
    else if (cg.style === "bn") idx = BN_OPT_MAP[cg.label];
    else if (cg.style === "num") idx = parseInt(cg.label, 10) - 1;
    else if (cg.style === "bnNum") idx = parseInt(bnDigitsToAscii(cg.label), 10) - 1;
    else if (cg.style.startsWith("roman")) idx = romanToIndex(cg.label);
    if (idx !== null && idx >= 0 && idx < 4) {
      // text for this option is substring from end to next match start (or answerPos)
      const nextStart = k + 1 < candidateGroup.length ? candidateGroup[k + 1].start : textBeforeAnswer.length;
      const rawOptText = textBeforeAnswer.slice(cg.end, nextStart).trim();
      // Clean up to next option marker or answer - need to remove trailing newline etc.
      const cleaned = cleanOptionText(rawOptText.split(/\n/)[0] ?? rawOptText);
      tmpOptions[idx] = cleaned;
      hasValid = true;
    }
  }
  if (!hasValid || tmpOptions.filter((o) => o.trim()).length < 2) return null;
  // Question text is from after header strip up to first candidateGroup start
  const firstOptStart = candidateGroup[0].start;
  let qTextRaw = textBeforeAnswer.slice(0, firstOptStart).trim();
  // Strip leading question number. qTextRaw may be multi-line (physics/math
  // stem) — strip the header from the FIRST line only, keep the rest.
  const firstNl = qTextRaw.indexOf("\n");
  const firstLine = firstNl >= 0 ? qTextRaw.slice(0, firstNl) : qTextRaw;
  const restLines = firstNl >= 0 ? qTextRaw.slice(firstNl) : "";
  const shFirst = stripQuestionHeader(firstLine);
  const sh = shFirst
    ? {
        stripped: ((shFirst.stripped || "") + restLines).trim(),
        header: shFirst.header,
      }
    : null;
  if (sh) {
    if (sh.stripped) qTextRaw = sh.stripped;
    else {
      // Header alone, try next segment before options? Keep as is without header
      qTextRaw = qTextRaw.replace(/^\s*(?:\d+|[০-৯]+|Q\s*0*\d+|Question\s*(?:No\.?)?\s*\d+|QUESTION\s*[:\-]|প্রশ্ন\s*(?:নং\.?)?\s*\d+|[IVXLCDM]+)\s*[\.\)\:\-।\)]?\s*/i, "").trim();
    }
  } else {
    // Also strip plain QUESTION: without number if present
    const qm = qTextRaw.match(/^\s*QUESTION\s*[:\-]\s*(.*)$/i);
    if (qm) qTextRaw = (qm[1] ?? "").trim();
  }
  // Clean question: preserve newlines for multi-line physics/math stems.
  if (isEquationContinuation(qTextRaw) || qTextRaw.includes("\n")) {
    qTextRaw = qTextRaw.replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n").trim();
  } else {
    qTextRaw = qTextRaw.replace(/\s+/g, " ").trim();
  }
  // Resolve answer
  let correctIndex: number | null = null;
  let marks: number = 1;
  // Check for MARK in the block (after answer)
  const markMatch = rawBlock.match(/(?:^|\n)\s*(?:MARK|MARKS)\s*[:\-=—.]?\s*(\d+(?:\.\d+)?)\s*$/im);
  if (markMatch) {
    const v = parseFloat(markMatch[1]);
    if (Number.isFinite(v) && v >= 0) marks = v;
  }
  if (answerPayload) {
    correctIndex = mapAnswerPayloadToIndex(answerPayload, tmpOptions);
  }
  // Fallback to correct marker inside option text? Not needed

  const issues: string[] = [];
  if (!qTextRaw || qTextRaw.length < 3) issues.push("Question text missing or too short");
  const filled = tmpOptions.filter((o) => o.trim()).length;
  if (filled < 4) {
    const missing = tmpOptions.map((o, i) => (!o.trim() ? String.fromCharCode(65 + i) : null)).filter(Boolean) as string[];
    if (missing.length) issues.push(`Missing option ${missing.join(", ")}`);
  }
  if (filled < 2) issues.push("At least 2 options required");
  if (correctIndex === null) issues.push("Answer could not be confidently detected — please verify.");
  const needsReview = issues.length > 0;
  return {
    question: qTextRaw,
    options: tmpOptions,
    correctIndex,
    explanation: explanationPayload ?? "",
    marks,
    rawBlock,
    issues,
    needsReview,
    confidence: needsReview ? 0.7 : 0.95,
    originalNumber: sh?.header ?? null,
  };
}

// ── split by numbering (for block detection) ───────────────────────────────
function splitByNumbering(text: string): string[] | null {
  const lines = injectNewlinesForInline(text).split("\n");
  const blocks: string[] = [];
  let start = -1;
  let seenOptions = false;
  let ambiguousStyle: OptionLabelStyle | null = null;
  let lastOptionIndex = -1;
  let afterAnswer = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (isBareAnswerPrefix(line) || extractAnswerPayload(line) !== null) {
      afterAnswer = true;
      continue;
    }
    const header = stripQuestionHeader(line);
    const option = parseOptionLine(line, true);
    const style = option ? optionLabelStyle(line) : null;
    const explicitHeader = header !== null && (
      /^(?:Q|Question|প্রশ্ন)/i.test(header.header) ||
      /[।]/.test(header.header)
    );
    const continuesOptionRun = !afterAnswer && option !== null &&
      style === ambiguousStyle && option.index > lastOptionIndex;
    // Before the options, bare numbered/Roman lines are stem statements.
    // After the options, a fresh header starts the next question unless it is
    // still part of the active numeric/Roman option group.
    if (start < 0 && header && lines.slice(0, i).some((l) => l.trim())) return null;
    const separatedHeader = header !== null && !seenOptions && i > start + 1 &&
      !lines[i - 1].trim() && !isAmbiguousOptionRun(lines, i) && !isAmbiguousOptionRun(lines, i, true);
    if (header && (start < 0 || explicitHeader || separatedHeader || ((seenOptions || afterAnswer) && !continuesOptionRun))) {
      if (start >= 0) blocks.push(lines.slice(start, i).join("\n").trim());
      start = i;
      seenOptions = false;
      ambiguousStyle = null;
      lastOptionIndex = -1;
      afterAnswer = false;
      continue;
    }
    if (start < 0 || !option) continue;
    if (style === "letter" || continuesOptionRun || (!seenOptions && isAmbiguousOptionRun(lines, i))) {
      seenOptions = true;
      ambiguousStyle = style === "letter" ? null : style;
      lastOptionIndex = option.index;
    }
  }
  if (start < 0) return null;
  blocks.push(lines.slice(start).join("\n").trim());
  return blocks;
}

function parseViaLineScan(text: string): ParsedPasteMcq[] {
  const withInlines = injectNewlinesForInline(text.replace(/\r\n/g, "\n"));
  const rawLines = withInlines.split("\n");
  type Block = { questionLines: string[]; statements: string[]; options: [string, string, string, string]; correctIndex: number | null; explanation: string; marks: number; rawLines: string[]; originalNumber: string | null; _pendingAnswerPayload?: string };
  const blocks: Block[] = [];
  let current: Block | null = null;

  const flushCurrent = () => {
    if (current && (current.questionLines.length > 0 || current.statements.length > 0 || current.options.some((o) => o.trim()))) {
      blocks.push(current);
    }
    current = null;
  };

  for (let idx = 0; idx < rawLines.length; idx++) {
    const line = rawLines[idx];
    const trimmed = line.trim();
    if (trimmed === "") continue;
    // Bare per-question answer prefix ("Correct Answer:" alone) — payload may
    // sit on the next line. Stash it as pending so it resolves once options
    // are known. Runs BEFORE the key-section defense (not a key heading).
    if (isBareAnswerPrefix(trimmed)) {
      if (!current) continue;
      let j = idx + 1;
      while (j < rawLines.length && !rawLines[j].trim()) j++;
      const next = j < rawLines.length ? rawLines[j].trim() : "";
      if (next && isJoinableAnswerContinuation(next)) {
        const joined = extractAnswerPayload(`${trimmed} ${next}`);
        if (joined !== null) {
          const mapped = mapAnswerPayloadToIndex(joined, current.options);
          if (mapped !== null) current.correctIndex = mapped;
          else current._pendingAnswerPayload = joined;
        }
        current.rawLines.push(line);
        // Skip the consumed continuation line on the next iteration.
        rawLines[j] = "";
        continue;
      }
      current.rawLines.push(line);
      continue;
    }
    // Defense-in-depth: stray answer-key heading/entries never become questions.
    // (Only when the remainder is empty or actually parses as key entries —
    // a question that merely starts with the word "Answers" must survive.)
    const keyRemScan = answerKeyHeadingRemainder(line);
    if (
      keyRemScan !== null &&
      (keyRemScan === "" ||
        (!isSingleAnswerLabel(keyRemScan) && parseAnswerKeyEntries(keyRemScan).size > 0))
    ) {
      current?.rawLines.push(line);
      continue;
    }
    if (isMarkLine(line)) {
      if (!current) continue;
      // Fixed mark = 1 — skip line, keep marks = 1
      current.rawLines.push(line);
      continue;
    }
    const payload = extractAnswerPayload(line);
    if (payload !== null) {
      if (!current) continue;
      // Map later after options known? Store raw then resolve
      // For line-scan we can directly map if options already have some
      const mapped = mapAnswerPayloadToIndex(payload, current.options);
      if (mapped !== null) current.correctIndex = mapped;
      else {
        // Store payload for later resolution (keep as string? We'll keep as pending)
        // For now, if not mappable, keep payload to try later with full options
        // We'll store as temporary marker: keep payload in a hidden field via rawLines and resolve after block completion
        // Instead, save payload raw for later: we set a property via rawLines with special marker
        current._pendingAnswerPayload = payload;
      }
      current.rawLines.push(line);
      continue;
    }

    const explanationPayload = extractExplanationPayload(line);
    if (explanationPayload !== null) {
      if (!current) continue;
      // Store explanation — last one wins
      current.explanation = explanationPayload;
      current.rawLines.push(line);
      continue;
    }

    // Statement lines — must be checked before option, when still in question phase
    if (current && current.options.every((o) => o === "") && isStatementLine(line)) {
      current.statements.push(trimmed);
      current.rawLines.push(line);
      continue;
    }

    const isQStart = isQuestionHeaderLine(line);
    // If this line looks like a new question header, handle before treating as option (to avoid header "১. ..." being taken as numeric option)
    if (isQStart) {
      // But if current exists and has no options yet and isQStart is actually a statement that slipped (e.g., roman statement not caught), isStatementLine already handled, so remaining is genuine question
      // Check if this is truly a new question vs continuation: if current has no options, treat numeric 1.,2.,3. that are statements? They would have been caught as isStatementLine, so not here.
      // So we can safely treat as new question header if current has content
      if (current && (current.questionLines.length > 0 || current.statements.length > 0 || current.options.some((o) => o.trim()))) {
        flushCurrent();
      }
      const sh = stripQuestionHeader(line);
      let qText = line.trim();
      let orig: string | null = null;
      if (sh) {
        orig = sh.header;
        qText = sh.stripped;
      } else {
        qText = line.trim();
      }
      current = { questionLines: qText ? [qText] : [], statements: [], options: ["", "", "", ""], correctIndex: null, explanation: "", marks: 1, rawLines: [line], originalNumber: orig };
      continue;
    }

    const opt = parseOptionLine(line, true);
    if (opt) {
      if (!current) {
        current = { questionLines: [], statements: [], options: ["", "", "", ""], correctIndex: null, explanation: "", marks: 1, rawLines: [], originalNumber: null };
      }
      // Duplicate option label suggests new question if current already has question and at least 2 options
      if (current.options[opt.index] !== "" && current.options.some((o) => o !== "")) {
        const hasQuestion = current.questionLines.length > 0 || current.statements.length > 0;
        const filled = current.options.filter((o) => o.trim()).length;
        if (hasQuestion && filled >= 2) {
          flushCurrent();
        current = { questionLines: [], statements: [], options: ["", "", "", ""], correctIndex: null, explanation: "", marks: 1, rawLines: [], originalNumber: null };
        }
      }
      if (opt.isCorrectMarker && current.correctIndex === null) {
        current.correctIndex = opt.index;
      }
      if (current.options[opt.index] === "") current.options[opt.index] = opt.text;
      else current.options[opt.index] += " " + opt.text;
      current.rawLines.push(line);
      continue;
    }

    // Plain text
    if (!current) {
      current = { questionLines: [trimmed], statements: [], options: ["", "", "", ""], correctIndex: null, explanation: "", marks: 1, rawLines: [line], originalNumber: null };
      continue;
    }
    const hasAnyOption = current.options.some((o) => o !== "");
    if (!hasAnyOption) {
      if (current.statements.length > 0) {
        current.statements[current.statements.length - 1] += " " + trimmed;
        current.rawLines.push(line);
      } else {
        current.questionLines.push(trimmed);
        current.rawLines.push(line);
      }
    } else {
      // After options: multi-line option continuation vs new question.
      // Equation-like lines always continue the current block. Otherwise a
      // plain line continues the last option when the option set is still
      // INCOMPLETE (<4 filled) and the line does not look like a new
      // question (no header, no ?/: /। ending). A complete 4-option set
      // followed by text starts a new question (old behavior preserved).
      if (isEquationContinuation(trimmed)) {
        let last = -1;
        for (let k = 3; k >= 0; k--) if (current.options[k]) { last = k; break; }
        if (last >= 0) {
          current.options[last] = `${current.options[last]} ${cleanOptionText(trimmed)}`.trim();
          current.rawLines.push(line);
          continue;
        }
      }
      const filledOpts = current.options.filter((o) => o.trim()).length;
      const looksLikeQuestion =
        isQuestionHeaderLine(trimmed) || /[?:।]$/.test(trimmed) || trimmed.length > 150;
      if (!looksLikeQuestion && filledOpts >= 1 && filledOpts < 4) {
        let last = -1;
        for (let k = 3; k >= 0; k--) if (current.options[k]) { last = k; break; }
        if (last >= 0) {
          current.options[last] = `${current.options[last]} ${cleanOptionText(trimmed)}`.trim();
          current.rawLines.push(line);
          continue;
        }
      }
      // After options, plain text likely starts new question
      flushCurrent();
      current = { questionLines: [trimmed], statements: [], options: ["", "", "", ""], correctIndex: null, explanation: "", marks: 1, rawLines: [line], originalNumber: null };
    }
  }
  flushCurrent();

  // Resolve pending answer payloads for blocks where answer was full text not yet mapped
  for (const b of blocks) {
    const pending = b._pendingAnswerPayload;
    if (pending && b.correctIndex === null) {
      const mapped = mapAnswerPayloadToIndex(pending, b.options);
      if (mapped !== null) b.correctIndex = mapped;
    }
    delete b._pendingAnswerPayload;
  }

  return blocks.map((b) => {
    const blockText = b.rawLines.join("\n");
    // Preserve multi-line physics/math stems: equation lines keep newlines.
    const hasEqLine = b.questionLines.some((l) => isEquationContinuation(l));
    const baseQuestion = hasEqLine
      ? b.questionLines.join("\n").replace(/[ \t]+\n/g, "\n").trim()
      : b.questionLines.join(" ").replace(/\s+/g, " ").trim();
    const statementsText = b.statements.join("\n").trim();
    const question = statementsText ? (baseQuestion ? `${baseQuestion}\n${statementsText}` : statementsText) : baseQuestion;
    const marks = b.marks;
    const issues: string[] = [];
    if (!question || question.length < 3) issues.push("Question text missing or too short");
    const filled = b.options.filter((o) => o.trim()).length;
    if (filled < 4) {
      const missing = b.options.map((o, i) => (!o.trim() ? String.fromCharCode(65 + i) : null)).filter(Boolean) as string[];
      if (missing.length) issues.push(`Missing option ${missing.join(", ")}`);
    }
    if (filled < 2) issues.push("At least 2 options required");
    if (b.correctIndex === null) issues.push("Answer could not be confidently detected — please verify.");
    else if (!b.options[b.correctIndex]?.trim()) issues.push(`Correct answer ${String.fromCharCode(65 + (b.correctIndex ?? 0))} is empty`);
    const needsReview = issues.length > 0;
    const confidence = needsReview ? 0.7 : 0.95;
    return {
      question,
      options: b.options,
      correctIndex: b.correctIndex,
      explanation: b.explanation ?? "",
      marks: marks,
      rawBlock: blockText,
      issues,
      needsReview,
      confidence,
      originalNumber: b.originalNumber,
    };
  });
}

export function parsePastedMcqs(pastedText: string): ParsedPasteMcq[] {
  if (!pastedText || !pastedText.trim()) return [];
  const normalized = normalizePasteText(pastedText).trim();
  if (!normalized) return [];

  // ── Separate trailing Answer Key section (never parsed as questions) ──
  const { mainText, keyEntries, keyFound } = splitAnswerKeySection(normalized);
  const text = keyFound ? mainText : normalized;
  const finish = (list: ParsedPasteMcq[]): ParsedPasteMcq[] =>
    keyFound ? applyAnswerKey(list, keyEntries) : list;

  // Try numbered split first
  const numberedBlocks = splitByNumbering(text);
  if (numberedBlocks && numberedBlocks.length > 0) {
    const parsed: ParsedPasteMcq[] = [];
    for (const block of numberedBlocks) {
      const p = parseSingleBlock(block);
      if (p.options.every((o) => !o.trim())) {
        // Avoid converting statement lines (e.g., Roman I., II. statements) into options via inline fallback
        const rawLines = block.split("\n").map((l) => l.trim()).filter(Boolean);
        const hasStatementLines = rawLines.some((l) => isStatementLine(l));
        const hasADOptions = rawLines.some((l) => {
          const t = l.trim();
          return /^[A-Da-dকখগঘ(]/.test(t) && parseOptionLine(t, false) !== null;
        });
        if (hasStatementLines && !hasADOptions && !hasInlineOptionMarkers(block)) {
          // This block has statements but no real A-D/Bangla options (e.g., "III. Third Q?" with I., II. statements only) — keep as is with missing options warning
          parsed.push(p);
        } else {
          const inline = parseSingleBlockInline(block);
          if (inline && inline.options.filter((o) => o.trim()).length >= 2) parsed.push(inline);
          else parsed.push(p);
        }
      } else {
        parsed.push(p);
      }
    }
    // Explicitly numbered questions stay in preview even when incomplete.
    return finish(parsed);
  }

  const viaLines = parseViaLineScan(text);
  if (viaLines.length > 0) {
    const enhanced = viaLines.map((b) => {
      if (b.options.filter((o) => o.trim()).length < 2) {
        const rawLines = b.rawBlock.split("\n").map((l) => l.trim()).filter(Boolean);
        const hasStatementLines = rawLines.some((l) => isStatementLine(l));
        const hasADOptions = rawLines.some((l) => /^[A-Da-dকখগঘ(]/.test(l.trim()) && parseOptionLine(l, false) !== null);
        if (hasStatementLines && !hasADOptions && !hasInlineOptionMarkers(b.rawBlock)) return b;
        const inline = parseSingleBlockInline(b.rawBlock);
        if (inline && inline.options.filter((o) => o.trim()).length >= 2) return inline;
      }
      return b;
    });
    // Filter out blocks that still have <2 options (likely false splits) unless they're the only block
    const filtered = enhanced.filter((b) => b.options.filter((o) => o.trim()).length >= 2 || b.question.length >= 10);
    if (filtered.length > 0) return finish(filtered);
    return finish(enhanced);
  }

  const single = parseSingleBlock(text);
  const inlineSingle = parseSingleBlockInline(text);
  if (inlineSingle && inlineSingle.options.filter((o) => o.trim()).length >= 2) return finish([inlineSingle]);
  return finish([single]);
}

// ── canonical formatter (Global Paste Formatter) ────────────────────────────
// Takes ANY pasted MCQs and returns 100% detectable canonical text:
//   Bangla:  ১। question\n(ক) ..\n(খ) ..\n(গ) ..\n(ঘ) ..\nসঠিক উত্তর: ঘ
//   English: 1. question\nA. ..\nB. ..\nC. ..\nD. ..\nAnswer: B
// Multi-line physics/math stems keep their equation lines with \n.
export type CanonicalFormatLang = "bangla" | "english";

const BN_NUMERALS = ["০", "১", "২", "৩", "৪", "৫", "৬", "৭", "৮", "৯"];
function toBnNumber(n: number): string {
  return String(n)
    .split("")
    .map((d) => BN_NUMERALS[parseInt(d, 10)] ?? d)
    .join("");
}
const BN_OPT_LABELS = ["ক", "খ", "গ", "ঘ"];
const EN_OPT_LABELS = ["A", "B", "C", "D"];

export function formatParsedToCanonical(
  list: ParsedPasteMcq[],
  lang: CanonicalFormatLang = "bangla",
): string {
  const bn = lang === "bangla";
  return list
    .map((p, i) => {
      const n = i + 1;
      const qNum = bn ? `${toBnNumber(n)}।` : `${n}.`;
      const q = (p.question || "").trim();
      const opts = [0, 1, 2, 3].map((k) => {
        const label = bn ? `(${BN_OPT_LABELS[k]})` : `${EN_OPT_LABELS[k]}.`;
        return `${label} ${(p.options[k] || "").trim()}`;
      });
      const ansLabel = p.correctIndex !== null && p.correctIndex >= 0 && p.correctIndex < 4
        ? bn
          ? BN_OPT_LABELS[p.correctIndex]
          : EN_OPT_LABELS[p.correctIndex]
        : "";
      const ansLine = bn
        ? ansLabel
          ? `সঠিক উত্তর: ${ansLabel}`
          : `সঠিক উত্তর: `
        : ansLabel
          ? `Answer: ${ansLabel}`
          : `Answer: `;
      return `${qNum} ${q}\n${opts.join("\n")}\n${ansLine}`;
    })
    .join("\n\n");
}

export function formatPastedToCanonical(
  pastedText: string,
  lang: CanonicalFormatLang = "bangla",
): { formatted: string; detected: number; needsReview: number } {
  const parsed = parsePastedMcqs(pastedText);
  return {
    formatted: formatParsedToCanonical(parsed, lang),
    detected: parsed.length,
    needsReview: parsed.filter((p) => p.needsReview).length,
  };
}

export function recomputeParsedMcq(mcq: ParsedPasteMcq): ParsedPasteMcq {
  // Preserve marks if already set
  if (mcq.marks == null) {
    const markMatch = mcq.rawBlock.match(/(?:^|\n)\s*(?:MARK|MARKS)\s*[:\-=—.]?\s*(\d+(?:\.\d+)?)\s*$/im);
    if (markMatch) {
      const v = parseFloat(markMatch[1]);
      if (Number.isFinite(v) && v >= 0) mcq.marks = v;
    }
  }
  const issues: string[] = [];
  if (!mcq.question || mcq.question.trim().length < 3) issues.push("Question text missing or too short");
  const filled = mcq.options.filter((o) => o.trim()).length;
  if (filled < 4) {
    const missing = mcq.options.map((o, i) => (!o.trim() ? String.fromCharCode(65 + i) : null)).filter(Boolean) as string[];
    if (missing.length) issues.push(`Missing option ${missing.join(", ")}`);
  }
  if (filled < 2) issues.push("At least 2 options required");
  if (mcq.correctIndex === null) issues.push("Answer could not be confidently detected — please verify.");
  else if (mcq.correctIndex < 0 || mcq.correctIndex >= 4 || !mcq.options[mcq.correctIndex]?.trim()) issues.push(`Correct answer ${String.fromCharCode(65 + (mcq.correctIndex ?? 0))} is empty`);
  const needsReview = issues.length > 0;
  return { ...mcq, issues, needsReview, confidence: needsReview ? 0.7 : 0.96 };
}
