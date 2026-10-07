"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  buttonPrimaryClass,
  buttonSecondaryClass,
  cardClass,
} from "./admin-ui";
import {
  answerKeyLabelToIndex,
  parsePastedMcqs,
  parseStandaloneAnswerKey,
  questionNumberForIndex,
} from "@/lib/paste-mcq-parser";

type ExamBrief = {
  id: string;
  title: string;
  subject?: string;
  totalMarks?: number;
  durationMinutes?: number;
  questionCount?: number;
  totalQuestions?: number;
  ruleTemplate?: string | null;
  rule_template?: string | null;
  status?: string;
  marksPerQuestion?: number | null;
};

type ExamQuestion = {
  id: number | null;
  examId: string | null;
  subject: string;
  question: string;
  questionImage?: string | null;
  options: string[];
  /** Saved answer index, or null when unknown (rendered unset — never shown as A). */
  correctIndex: number | null;
  explanation: string | null;
  marks: number;
  isActive?: boolean;
  /** True when this slot already has authored content for the active version/set. */
  hasVariant?: boolean;
};

type LangVersion = "bangla" | "english";
type SetLabel = "A" | "B";

function tabKey(version: LangVersion, set: SetLabel): string {
  return `${version}:${set}`;
}

const EMPTY_OPTIONS = ["", "", "", ""];

/** Unsaved per-slot edits. Nothing reaches the database until Save Questions. */
type SlotDraft = {
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
  questionImage: string | null;
  /** Original pasted question number (e.g. 25 for "25. ...") — used to match
   *  a separately detected Answer Key by QUESTION NUMBER, never array position. */
  sourceNumber: number | null;
};

function emptyDraft(): SlotDraft {
  // Unknown answer starts unset (-1 = nothing selected) so saving without
  // picking an answer is impossible — it can never silently become A.
  return { question: "", options: [...EMPTY_OPTIONS], correctIndex: -1, explanation: "", questionImage: null, sourceNumber: null };
}

function draftFromQuestion(q: ExamQuestion | null | undefined): SlotDraft {
  const opts = q?.options?.length
    ? (q.options.length >= 4 ? q.options.slice(0, 4) : [...q.options, ...EMPTY_OPTIONS.slice(q.options.length)])
    : [...EMPTY_OPTIONS];
  while (opts.length < 4) opts.push("");
  return {
    question: q?.question || "",
    options: opts.slice(0, 4),
    // Preserve an explicit unknown as unset (-1) — never coerce it to 0/A.
    correctIndex: q?.correctIndex ?? -1,
    explanation: q?.explanation ?? "",
    questionImage: q?.questionImage ?? null,
    sourceNumber: null,
  };
}

/** True when the draft differs from the saved slot (i.e. unsaved changes). */
function isDraftDirty(d: SlotDraft | undefined, q: ExamQuestion | null | undefined): boolean {
  if (!d) return false;
  if ((d.question || "") !== (q?.question || "")) return true;
  const qOpts = q?.options?.slice(0, 4) ?? [];
  for (let i = 0; i < 4; i++) {
    if ((d.options[i] || "") !== (qOpts[i] || "")) return true;
  }
  if ((d.correctIndex ?? -1) !== (q?.correctIndex ?? -1)) return true;
  if ((d.explanation || "") !== (q?.explanation || "")) return true;
  if ((d.questionImage ?? null) !== (q?.questionImage ?? null)) return true;
  return false;
}

function isCompleted(q: ExamQuestion | null | undefined): boolean {
  if (!q || q.id === null) return false;
  if (!q.question || q.question.trim().length < 3) return false;
  const filled = q.options.filter((o) => o && o.trim().length > 0);
  if (filled.length < 2) return false;
  // An unknown answer (null) is never complete — it must not read as A.
  if (q.correctIndex === null || q.correctIndex === undefined) return false;
  if (q.correctIndex < 0 || q.correctIndex >= q.options.length) return false;
  if (!q.options[q.correctIndex]?.trim()) return false;
  return true;
}

/** Content-derived review issues for a slot draft. Fully empty slots report
 *  nothing — only slots with some content but incomplete data are flagged,
 *  so "Needs review" survives answer clicks, refreshes and saves instead of
 *  depending solely on the transient post-detection warnings map. */
function draftContentIssues(d: SlotDraft | undefined): string[] {
  if (!d) return [];
  const hasAny =
    d.question.trim().length > 0 || d.options.some((o) => o.trim()) || !!d.questionImage;
  if (!hasAny) return [];
  const out: string[] = [];
  if (d.question.trim().length < 3 && !d.questionImage) out.push("Question text missing or too short");
  if (d.options.filter((o) => o.trim()).length < 2) out.push("At least 2 options required");
  if (d.correctIndex < 0 || d.correctIndex >= d.options.length || !d.options[d.correctIndex]?.trim()) {
    out.push("Answer not selected — please verify.");
  }
  return out;
}

/** Parser warnings (post-detection) + live content issues, de-duplicated. */
function mergedSlotWarnings(stored: string[] | undefined, d: SlotDraft | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of [...(stored ?? []), ...draftContentIssues(d)]) {
    if (!seen.has(w)) {
      seen.add(w);
      out.push(w);
    }
  }
  return out;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export default function ExamPaperEditor({
  exam,
  authHeaders,
  onClose,
  onChanged,
  embedded = false,
}: {
  exam: ExamBrief;
  authHeaders: Record<string, string>;
  onClose: () => void;
  onChanged?: () => void;
  embedded?: boolean;
}) {
  const [questions, setQuestions] = useState<ExamQuestion[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [detectBusy, setDetectBusy] = useState(false);
  const [saveAllBusy, setSaveAllBusy] = useState(false);
  /** Determinate save progress (processed/total questions). Null when idle. */
  const [saveProgress, setSaveProgress] = useState<{ done: number; total: number } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [drafts, setDrafts] = useState<Record<number, SlotDraft>>({});
  // Language Version (Bangla / English) × Set (A / B): four separate
  // workspaces sharing the same permanent Question IDs and slot order.
  // Each workspace has its own paste area — no auto-translation between them.
  const [langVersion, setLangVersion] = useState<LangVersion>("bangla");
  const [setLabel, setSetLabel] = useState<SetLabel>("A");
  const activeTab = `${exam.id}:${tabKey(langVersion, setLabel)}`;
  const [bulkTexts, setBulkTexts] = useState<Record<string, string>>({});
  const bulkText = bulkTexts[activeTab] ?? "";
  const setBulkText = useCallback((value: string) => {
    setBulkTexts((prev) => ({ ...prev, [activeTab]: value }));
  }, [activeTab]);
  const [coverage, setCoverage] = useState<{ totalSlots: number; coverage: Record<string, number>; hasAnyVariant: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [savingSlot, setSavingSlot] = useState<number | null>(null);
  const [imageUploadingSlot, setImageUploadingSlot] = useState<number | null>(null);
  const [detectWarnings, setDetectWarnings] = useState<Record<number, string[]>>({});
  const [detectExistingMap, setDetectExistingMap] = useState<Record<number, boolean>>({});
  // True right after "Remove All" — suppresses empty-slot reseeding so the
  // page stays in a truly empty detection state until the next Detect /
  // Refresh / workspace switch. Without this, the drafts-seeding effect
  // repopulates totalSlots empty drafts and Q01..QNN cards reappear.
  const [detectionCleared, setDetectionCleared] = useState(false);
  // ── Separate Answer Key workflow (per version/set workspace, like bulkTexts) ──
  // "included" = existing combined Question+Answer detection (default, unchanged).
  // "separate" = detect questions only, then detect/paste a standalone key and Apply by question number.
  const [answerSources, setAnswerSources] = useState<Record<string, "included" | "separate">>({});
  const answerSource = answerSources[activeTab] ?? "included";
  const setAnswerSource = useCallback((value: "included" | "separate") => {
    setAnswerSources((prev) => ({ ...prev, [activeTab]: value }));
  }, [activeTab]);
  const [answerKeyTexts, setAnswerKeyTexts] = useState<Record<string, string>>({});
  const answerKeyText = answerKeyTexts[activeTab] ?? "";
  const setAnswerKeyText = useCallback((value: string) => {
    setAnswerKeyTexts((prev) => ({ ...prev, [activeTab]: value }));
  }, [activeTab]);
  /** Detected key: question number → raw answer label (editable via dropdowns). */
  const [answerKeyMaps, setAnswerKeyMaps] = useState<Record<string, Record<number, string>>>({});
  const answerKeyMap = answerKeyMaps[activeTab] ?? {};
  const [answerKeyDupes, setAnswerKeyDupes] = useState<Record<string, number[]>>({});
  const answerKeyDupesForTab = answerKeyDupes[activeTab] ?? [];
  const [answerKeyBusy, setAnswerKeyBusy] = useState(false);
  const [answerKeyOcrBusy, setAnswerKeyOcrBusy] = useState<string | null>(null);
  const [answerKeyMsg, setAnswerKeyMsg] = useState<string | null>(null);
  const [answerKeyError, setAnswerKeyError] = useState<string | null>(null);
  const [addKeyNum, setAddKeyNum] = useState("");
  const [addKeyLabel, setAddKeyLabel] = useState("A");
  const answerKeyFileRef = useRef<HTMLInputElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const bearer = useMemo(() => authHeaders["Authorization"] || authHeaders["authorization"] || "", [authHeaders]);
  // Staleness guard: increments on every workspace switch so in-flight fetches
  // from a previous workspace discard their results instead of overwriting the
  // current workspace's questions state.
  const loadVersionRef = useRef(0);
  // Tracks the currently visible workspace so async save continuations never
  // write results into a different workspace the admin switched to mid-save.
  // (No automatic refetch happens on save — the Refresh button is the only
  // manual refresh; saves merge into local state instead.)
  const workspace = useMemo(() => ({ examId: exam.id, v: langVersion, s: setLabel }), [exam.id, langVersion, setLabel]);
  const workspaceRef = useRef(workspace);
  useLayoutEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);
  const draftGenerationRef = useRef(0);
  const saveOperationRef = useRef(0);
  const imageOperationRef = useRef(0);
  const ocrOperationRef = useRef(0);

  const load = useCallback(async (forVersion?: LangVersion, forSet?: SetLabel) => {
    const v = forVersion ?? langVersion;
    const s = forSet ?? setLabel;
    const version = ++loadVersionRef.current;
    const workspace = workspaceRef.current;
    try {
      const res = await fetch(`/api/admin/exams/questions?examId=${encodeURIComponent(exam.id)}&version=${v}&set=${s}`, {
        cache: "no-store",
        headers: authHeaders,
      });
      const data = (await res.json()) as { questions?: ExamQuestion[] };
      if (!res.ok || !Array.isArray(data.questions)) throw new Error("Failed to load questions.");
      if (version === loadVersionRef.current && workspaceRef.current === workspace) setQuestions(data.questions);
    } catch {
      // Never blank the visible list on a failed fetch — keep showing the
      // current questions/counters and let an explicit refresh retry.
      if (version === loadVersionRef.current && workspaceRef.current === workspace) setQuestions((prev) => prev ?? []);
    }
  }, [exam.id, authHeaders, langVersion, setLabel]);

  const loadCoverage = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/exams/variants?examId=${encodeURIComponent(exam.id)}`, {
        cache: "no-store",
        headers: authHeaders,
      });
      if (res.ok) {
        const data = (await res.json()) as { totalSlots: number; coverage: Record<string, number>; hasAnyVariant: boolean };
        if (workspaceRef.current.examId === exam.id) setCoverage(data);
      }
    } catch {
      // Coverage badges are best-effort.
    }
  }, [exam.id, authHeaders]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadCoverage();
  }, [loadCoverage]);

  // Switching version/set workspace resets local state so content from one
  // workspace never leaks into another. questions must be nulled so the UI
  // shows "Loading…" while the new workspace data is fetched.
  useEffect(() => {
    draftGenerationRef.current += 1;
    setQuestions(null);
    setDrafts({});
    setDetectionCleared(false);
    setDetectWarnings({});
    setDetectExistingMap({});
    setSavingSlot(null);
    setImageUploadingSlot(null);
    setSaveAllBusy(false);
    setAnswerKeyBusy(false);
    setRefreshing(false);
    setError(null);
    setNotice(null);
    setAnswerKeyMsg(null);
    setAnswerKeyError(null);
    setAnswerKeyOcrBusy(null);
    setAddKeyNum("");
    // NOTE: bulkTexts / answerKeyTexts / answerKeyMaps persist per workspace tab.
     
  }, [activeTab, exam.id]);


  const totalSlots = useMemo(() => {
    const qCount = Number(exam.questionCount ?? exam.totalQuestions ?? 0);
    if (Number.isFinite(qCount) && qCount > 0) return Math.floor(qCount);
    if (questions) return questions.length;
    return 0;
  }, [exam.questionCount, exam.totalQuestions, questions]);

  const completedCount = useMemo(() => {
    if (!questions) return 0;
    return questions.filter(isCompleted).length;
  }, [questions]);

  // Local drafts for inline editing — UNSAVED until "Save Questions" is clicked.
  // Typing, detecting, answering and image uploads only touch these drafts.
  // Effective total: never truncate pasted detection. If admin pastes 20/50/100,
  // preview shows all, even if exam was configured for 10. Extra slots are
  // kept as unsaved drafts and auto-created on Save via resolveOrCreateSlot.
  const effectiveTotalSlots = useMemo(() => {
    if (detectionCleared) return 0;
    const draftMax = Object.keys(drafts).length ? Math.max(...Object.keys(drafts).map(Number)) + 1 : 0;
    const qLen = questions?.length ?? 0;
    return Math.max(totalSlots, draftMax, qLen);
  }, [totalSlots, drafts, questions, detectionCleared]);

  const displaySlots = useMemo(() => {
    if (detectionCleared) return [];
    if (!questions) return [];
    const effective = effectiveTotalSlots;
    const list: Array<{ index: number; q: ExamQuestion | null }> = [];
    for (let i = 0; i < effective; i += 1) {
      const q = i < questions.length ? questions[i] : null;
      list.push({ index: i, q });
    }
    if (effective === 0) {
      return questions.map((q, i) => ({ index: i, q }));
    }
    return list;
  }, [questions, effectiveTotalSlots, detectionCleared]);

  const progressText =
    effectiveTotalSlots > 0
      ? `${completedCount}/${effectiveTotalSlots} Questions Completed`
      : `${completedCount} questions`;

  useEffect(() => {
    // Seed drafts from saved questions when they load (never overwrite edits in progress)
    // Keep detected drafts beyond totalSlots (effective) — don't prune, so 20/50/100 all show.
    // Skipped entirely after "Remove All" so cleared slots never repopulate.
    if (!questions || detectionCleared) return;
    setDrafts((prev) => {
      const merged: Record<number, SlotDraft> = { ...prev };
      for (let i = 0; i < totalSlots; i++) {
        if (!merged[i]) {
          const q = i < questions.length ? questions[i] : null;
          merged[i] = { ...draftFromQuestion(q), sourceNumber: i + 1 };
        } else if (merged[i].sourceNumber == null) {
          merged[i] = { ...merged[i], sourceNumber: i + 1 };
        }
      }
      return merged;
    });
     
  }, [questions, totalSlots, detectionCleared]);

  // Number of slots with unsaved changes (powers the Save button label).
  const dirtyCount = useMemo(() => {
    if (!questions) return 0;
    let n = 0;
    for (const k of Object.keys(drafts)) {
      const i = Number(k);
      const q = i < questions.length ? questions[i] : null;
      if (isDraftDirty(drafts[i], q)) n += 1;
    }
    return n;
  }, [drafts, questions]);

  // NOTE: there is intentionally NO blur auto-save. All edits stay in `drafts`
  // until the admin explicitly clicks "Save Questions".

  async function handleDetect() {
    setError(null);
    setNotice(null);
    setDetectionCleared(false);
    setDetectWarnings({});
    setDetectExistingMap({});
    // Capture workspace at call time for the status message below.
    // Detection never refetches — saves merge into local state instead.
    const detectVersion = langVersion;
    const detectSet = setLabel;
    if (!bulkText.trim()) {
      setError("Paste your questions first.");
      return;
    }
    // Keep incomplete questions visible with their warnings rather than
    // silently dropping them and shifting every subsequent slot/answer key.
    const useParsed = parsePastedMcqs(bulkText).filter((p) =>
      p.originalNumber != null || p.question.trim().length > 0 || p.options.some((o) => o.trim()),
    );
    if (useParsed.length === 0 || useParsed.every((p) => p.options.filter((o) => o.trim()).length < 2 && p.question.trim().length < 3)) {
      setError("No questions detected. Check the format (numbered questions with A–D options).");
      return;
    }
    if (totalSlots === 0) {
      setError("Set Total Questions on the exam first.");
      return;
    }
    setDetectBusy(true);
    try {
      const count = useParsed.length;

      // Track which slots already had content (questions added before detection)
      const existingMap: Record<number, boolean> = {};
      for (let i = 0; i < count; i++) {
        const slot = i < displaySlots.length ? displaySlots[i] : null;
        const hadContent = slot?.q?.id !== null && slot?.q?.id !== undefined &&
          (slot?.q?.question?.trim().length ?? 0) >= 3;
        if (hadContent) existingMap[i] = true;
      }
      setDetectExistingMap(existingMap);

      // Build warnings per slot (for those with issues)
      const warnings: Record<number, string[]> = {};
      for (let i = 0; i < count; i++) {
        const p = useParsed[i];
        if (p.issues.length > 0) warnings[i] = p.issues;
        // special: if correctIndex null, issue already includes verification warning
      }
      setDetectWarnings(warnings);

      // Detected questions stay UNSAVED drafts until "Save Questions" is clicked.
      // Fully replace drafts — clear ALL old drafts first, then set only the newly detected ones.
      // Saved images on overwritten slots are preserved in the drafts. All detected are kept,
      // even beyond configured totalSlots — Save will auto-create slots via resolveOrCreateSlot.
      const newDrafts: Record<number, SlotDraft> = {};
      for (let i = 0; i < count; i++) {
        const p = useParsed[i];
        const ci = p.correctIndex !== null && p.correctIndex >= 0 && p.correctIndex < 4 ? p.correctIndex : -1;
        const existingSlot = i < displaySlots.length ? displaySlots[i] : null;
        newDrafts[i] = {
          question: p.question,
          options: p.options.slice(0, 4) as string[],
          correctIndex: ci >= 0 ? ci : -1,
          explanation: p.explanation ?? "",
          questionImage: existingSlot?.q?.questionImage ?? null,
          sourceNumber: questionNumberForIndex(p.originalNumber, i),
        };
      }
      draftGenerationRef.current += 1;
      setDrafts(newDrafts);

      // No database writes here — the admin reviews and clicks Save Questions.
      let msg = `Detected ${useParsed.length} question${useParsed.length === 1 ? "" : "s"} — filled Q01–Q${pad(count)} in ${detectVersion} Set ${detectSet} (unsaved — review, then click Save Questions).`;
      if (count > totalSlots) msg += ` Note: ${count} detected exceeds configured ${totalSlots} slots — extra ${count - totalSlots} will auto-create new slots on Save.`;
      const noAnswerCount = useParsed.slice(0, count).filter((p) => p.correctIndex === null).length;
      if (noAnswerCount > 0) msg += ` ${noAnswerCount} question${noAnswerCount === 1 ? "" : "s"} have no confident answer — please verify before saving.`;
      const reviewCount = Object.keys(warnings).length;
      if (reviewCount > 0) msg += ` ${reviewCount} need review.`;
      const existingCount = Object.keys(existingMap).length;
      if (existingCount > 0) msg += ` ${existingCount} already had saved content — saving will overwrite those slots.`;
      setNotice(msg);
      setTimeout(() => setNotice(null), 8000);
      // Auto-scroll question list to top so detected questions are visible
      scrollContainerRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Detection failed.");
    } finally {
      setDetectBusy(false);
    }
  }

  // ── Separate Answer Key workflow ──────────────────────────────────────────
  // Detect / OCR / edit a standalone key, then Apply by QUESTION NUMBER
  // (never array position) onto the detected drafts.

  /** Original question number → draft slot index (first wins). */
  function draftNumberMap(): Map<number, number> {
    const map = new Map<number, number>();
    const indices = Object.keys(drafts).map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
    for (const i of indices) {
      const n = drafts[i]?.sourceNumber ?? i + 1;
      if (!map.has(n)) map.set(n, i);
    }
    return map;
  }

  function normalizeKeyLabel(raw: string): string {
    const t = raw.trim();
    if (/^[A-Ea-e]$/.test(t)) return t.toUpperCase();
    return t;
  }

  function handleDetectAnswerKey(raw?: string) {
    setAnswerKeyError(null);
    setAnswerKeyMsg(null);
    const text = (raw ?? answerKeyText).trim();
    if (!text) {
      setAnswerKeyError("Paste your answer key first (e.g. 1-A, 2-B …).");
      return;
    }
    const r = parseStandaloneAnswerKey(text);
    if (r.entries.size === 0) {
      setAnswerKeyError("No answers detected. Use formats like 1-A, 1. A, 1 A, or 1A 2B 3C.");
      return;
    }
    if (raw !== undefined) setAnswerKeyText(raw);
    const map: Record<number, string> = {};
    r.entries.forEach((label, qNum) => {
      // Normalize every label (A–E, ক–ঙ, 1–5, i–v) to an A–E letter so the
      // preview dropdowns can display and edit every entry uniformly.
      const idx = answerKeyLabelToIndex(label);
      map[qNum] = idx !== null && idx >= 0 && idx <= 4 ? String.fromCharCode(65 + idx) : normalizeKeyLabel(label);
    });
    setAnswerKeyMaps((prev) => ({ ...prev, [activeTab]: map }));
    setAnswerKeyDupes((prev) => ({ ...prev, [activeTab]: r.duplicates }));
    const dup = r.duplicates.length > 0 ? ` Duplicates ignored (first kept): ${r.duplicates.map((n) => `Q${n}`).join(", ")}.` : "";
    setAnswerKeyMsg(`Answers Detected: ${r.entries.size} — review below, then click Apply Answer Key.${dup}`);
  }

  /** Upload answer-key image(s) → vision OCR → raw text → same standalone parser.
   *  Processes pages sequentially so progress (Page x/y) stays visible. */
  async function handleAnswerKeyOcr(files: File[]) {
    setAnswerKeyError(null);
    setAnswerKeyMsg(null);
    const valid = files.filter((f) => f.type.startsWith("image/"));
    if (valid.length === 0) {
      setAnswerKeyError("Please select image file(s).");
      return;
    }
    if (valid.length > 10) {
      setAnswerKeyError("Too many images (max 10 per batch).");
      return;
    }
    const workspace = workspaceRef.current;
    const generation = draftGenerationRef.current;
    const operation = ++ocrOperationRef.current;
    setAnswerKeyBusy(true);
    const collected: string[] = [];
    try {
      for (let i = 0; i < valid.length; i += 1) {
         
        setAnswerKeyOcrBusy(`Processing questions… Page ${i + 1}/${valid.length}`);
        const fd = new FormData();
        fd.append("images", valid[i]);
         
        const res = await fetch("/api/admin/exams/answer-key-ocr", {
          method: "POST",
          headers: { ...authHeaders },
          body: fd,
        });
        const data = (await res.json().catch(() => null)) as { texts?: string[]; error?: string } | null;
        if (workspaceRef.current !== workspace || draftGenerationRef.current !== generation || ocrOperationRef.current !== operation) return;
        if (!res.ok) throw new Error(data?.error ?? "OCR failed.");
        const pageText = (data?.texts ?? []).join("\n").trim();
        if (pageText) collected.push(pageText);
        setAnswerKeyOcrBusy(`Processing questions… Page ${i + 1}/${valid.length} — Detected ${parseStandaloneAnswerKey(collected.join("\n")).entries.size} answers so far`);
      }
      if (collected.length === 0) {
        setAnswerKeyError("OCR returned no text — please paste the key manually.");
        return;
      }
      const combined = (answerKeyText.trim() ? answerKeyText.trim() + "\n" : "") + collected.join("\n");
      setAnswerKeyText(combined);
      handleDetectAnswerKey(combined);
    } catch (e) {
      if (workspaceRef.current === workspace && draftGenerationRef.current === generation && ocrOperationRef.current === operation) {
        setAnswerKeyError(e instanceof Error ? e.message : "Answer-key OCR failed.");
      }
    } finally {
      if (ocrOperationRef.current === operation) {
        setAnswerKeyBusy(false);
        setAnswerKeyOcrBusy(null);
        if (answerKeyFileRef.current) answerKeyFileRef.current.value = "";
      }
    }
  }

  function handleAnswerKeyChange(qNum: number, label: string) {
    if (!label) {
      // Clear answer
      setAnswerKeyMaps((prev) => {
        const next = { ...(prev[activeTab] ?? {}) };
        delete next[qNum];
        return { ...prev, [activeTab]: next };
      });
      return;
    }
    setAnswerKeyMaps((prev) => ({ ...prev, [activeTab]: { ...(prev[activeTab] ?? {}), [qNum]: label } }));
  }

  function handleAnswerKeyAdd() {
    setAnswerKeyError(null);
    const n = parseInt(addKeyNum.trim(), 10);
    if (!Number.isFinite(n) || n <= 0 || n > 1000) {
      setAnswerKeyError("Enter a valid question number to add.");
      return;
    }
    if (answerKeyLabelToIndex(addKeyLabel) === null) {
      setAnswerKeyError("Select a valid answer label.");
      return;
    }
    setAnswerKeyMaps((prev) => ({ ...prev, [activeTab]: { ...(prev[activeTab] ?? {}), [n]: addKeyLabel } }));
    setAddKeyNum("");
  }

  function handleClearAnswerKey() {
    setAnswerKeyMaps((prev) => ({ ...prev, [activeTab]: {} }));
    setAnswerKeyDupes((prev) => ({ ...prev, [activeTab]: [] }));
    setAnswerKeyMsg(null);
    setAnswerKeyError(null);
  }

  /** Apply the detected key onto drafts by QUESTION NUMBER with full validation. */
  function handleApplyAnswerKey() {
    setAnswerKeyError(null);
    setAnswerKeyMsg(null);
    const entries = Object.entries(answerKeyMap);
    if (entries.length === 0) {
      setAnswerKeyError("Detect an answer key first.");
      return;
    }
    const draftIndices = Object.keys(drafts).map(Number).filter((n) => Number.isFinite(n));
    if (draftIndices.length === 0) {
      setAnswerKeyError("Detect questions first, then apply the answer key.");
      return;
    }
    const numToDraft = draftNumberMap();
    const draftNums = new Set<number>(draftIndices.map((i) => drafts[i]?.sourceNumber ?? i + 1));
    let applied = 0;
    const missing: number[] = [];
    const extra: number[] = [];
    const invalid: string[] = [];
    const updates: Record<number, number> = {};
    for (const [qNumStr, label] of entries) {
      const qNum = Number(qNumStr);
      const slotIdx = numToDraft.get(qNum);
      if (slotIdx === undefined) {
        extra.push(qNum);
        continue;
      }
      const optIdx = answerKeyLabelToIndex(label);
      const opts = drafts[slotIdx]?.options ?? [];
      const available = opts.filter((o) => o.trim()).length;
      if (optIdx === null || optIdx < 0 || optIdx >= opts.length || !opts[optIdx]?.trim()) {
        const have = available > 0 ? `has only ${available} option${available === 1 ? "" : "s"} (A${available > 1 ? `–${String.fromCharCode(64 + available)}` : ""})` : "has no options";
        invalid.push(`Q${qNum} → ${label} invalid (question ${have})`);
        continue;
      }
      updates[slotIdx] = optIdx;
      applied += 1;
    }
    draftNums.forEach((n) => {
      if (!(n in answerKeyMap)) missing.push(n);
    });
    missing.sort((a, b) => a - b);
    extra.sort((a, b) => a - b);

    if (applied > 0) {
      setDrafts((prev) => {
        const next = { ...prev };
        for (const [slotStr, optIdx] of Object.entries(updates)) {
          const slot = Number(slotStr);
          if (next[slot]) next[slot] = { ...next[slot], correctIndex: optIdx };
        }
        return next;
      });
      // Clear stale "no answer" warnings on slots that now have answers.
      setDetectWarnings((prev) => {
        const next = { ...prev };
        for (const slotStr of Object.keys(updates)) {
          const slot = Number(slotStr);
          const list = next[slot];
          if (!list) continue;
          const filtered = list.filter(
            (w) => w !== "Answer could not be confidently detected — please verify." && w !== "No answer-key entry found for this question — please verify.",
          );
          if (filtered.length === 0) delete next[slot];
          else next[slot] = filtered;
        }
        return next;
      });
    }

    const totalQ = draftIndices.length;
    let msg = `Applied ${applied}/${entries.length} answers to ${totalQ} questions.`;
    if (missing.length > 0) msg += ` Missing answers: ${missing.map((n) => `Q${n}`).join(", ")}.`;
    if (extra.length > 0) msg += ` Extra (no such question): ${extra.map((n) => `Q${n}`).join(", ")}.`;
    if (invalid.length > 0) msg += ` Invalid: ${invalid.join("; ")}.`;
    if (answerKeyDupesForTab.length > 0) msg += ` Duplicates ignored: ${answerKeyDupesForTab.map((n) => `Q${n}`).join(", ")}.`;
    if (missing.length > 0 || extra.length > 0 || invalid.length > 0) msg += " ⚠ Review required before saving.";
    else msg += " All matched ✓ — review the final preview, then Save Questions.";
    setAnswerKeyMsg(msg);
  }

  // Answer-key preview status (recomputed per render — maps are small).
  const answerKeyStatus = useMemo(() => {
    const numToDraft = new Map<number, number>();
    const indices = Object.keys(drafts).map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
    for (const i of indices) {
      const n = drafts[i]?.sourceNumber ?? i + 1;
      if (!numToDraft.has(n)) numToDraft.set(n, i);
    }
    const rows = Object.entries(answerKeyMap)
      .map(([qNumStr, label]) => {
        const qNum = Number(qNumStr);
        const slotIdx = numToDraft.get(qNum);
        if (slotIdx === undefined) return { qNum, label, state: "extra" as const };
        const optIdx = answerKeyLabelToIndex(label);
        const opts = drafts[slotIdx]?.options ?? [];
        if (optIdx === null || optIdx < 0 || optIdx >= opts.length || !opts[optIdx]?.trim()) {
          return { qNum, label, state: "invalid" as const };
        }
        return { qNum, label, state: "matched" as const };
      })
      .sort((a, b) => a.qNum - b.qNum);
    const keyed = new Set(rows.map((r) => r.qNum));
    const draftNums = indices.map((i) => drafts[i]?.sourceNumber ?? i + 1).sort((a, b) => a - b);
    const missing = draftNums.filter((n) => !keyed.has(n));
    const extra = rows.filter((r) => r.state === "extra").map((r) => r.qNum);
    const invalid = rows.filter((r) => r.state === "invalid");
    return { rows, missing, extra, invalid, totalQuestions: indices.length, detected: rows.length };
  }, [answerKeyMap, drafts]);

  /**
   * Explicit "Save Questions" — the ONLY writer to the database on this page.
   * Sends every valid detected/edited draft in ONE bulk request to the
   * existing storage (exam_question_variants via /api/admin/exams/questions).
   * Saves question text, options, correct answer, permanent Question ID
   * (slot order) and attached image. Invalid/empty slots are skipped and
   * reported, never written. Local state is merged (no refetch) so the page
   * never reloads on save.
   */
  async function handleSaveAll() {
    setError(null);
    setNotice(null);
    const saveVersion = langVersion;
    const saveSet = setLabel;
    const workspace = workspaceRef.current;
    const generation = draftGenerationRef.current;
    const operation = ++saveOperationRef.current;
    const marksPerQ = Number(exam.marksPerQuestion ?? 1) || 1;
    const indices = Object.keys(drafts).map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
    if (indices.length === 0) {
      setError("Nothing to save — detect or type questions first.");
      return;
    }
    type BulkItem = {
      slotIndex: number;
      id: number | null;
      order: number;
      question: string;
      options: string[];
      correctIndex: number;
      explanation: string | null;
      marks: number;
      questionImage: string | null;
    };
    const items: BulkItem[] = [];
    const skipped: string[] = [];
    for (const i of indices) {
      const d = drafts[i];
      if (!d) continue;
      const qText = d.question.trim();
      const hasAny = qText.length > 0 || d.options.some((o) => o.trim()) || !!d.questionImage;
      if (!hasAny) continue; // blank slot — leave saved data (if any) untouched
      // Keep only non-empty options (storage rejects empty strings) and
      // remap the correct answer onto the filtered list.
      const kept: string[] = [];
      let remapped = -1;
      d.options.forEach((o, oi) => {
        if (!o.trim()) return;
        if (oi === d.correctIndex) remapped = kept.length;
        kept.push(o);
      });
      if ((qText.length < 3 && !d.questionImage) || kept.length < 2 || remapped < 0) {
        skipped.push(`Q${pad(i + 1)}`);
        continue;
      }
      const existing = i < displaySlots.length ? (displaySlots[i]?.q ?? null) : null;
      items.push({
        slotIndex: i,
        id: existing?.id ?? null,
        order: i + 1,
        question: qText,
        options: kept,
        correctIndex: remapped,
        explanation: d.explanation.trim() ? d.explanation : null,
        marks: existing?.marks ?? marksPerQ,
        questionImage: d.questionImage,
      });
    }
    if (items.length === 0) {
      setError(
        skipped.length > 0
          ? `Nothing valid to save — please review: ${skipped.join(", ")}.`
          : "Nothing to save — detect or type questions first.",
      );
      return;
    }
    const confirmedItems: BulkItem[] = [];
    const rejectedNotes: string[] = [];
    setSaveAllBusy(true);
    setSaveProgress({ done: 0, total: items.length });
    try {
      // One bulk request per 200 items (server batch cap) to existing storage.
      let saved = 0;
      for (let start = 0; start < items.length; start += 200) {
        const chunk = items.slice(start, start + 200);
         
        const res = await fetch("/api/admin/exams/questions", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify({
            examId: exam.id,
            version: saveVersion,
            set: saveSet,
            questions: chunk.map(({ slotIndex: _slot, ...rest }) => rest),
          }),
        });
        const data = (await res.json().catch(() => null)) as { error?: string; saved?: number; savedIds?: number[]; errors?: { index: number; error: string }[] } | null;
        if (!res.ok) throw new Error(data?.error ?? "Failed to save questions.");
        const rejected = new Set((data?.errors ?? []).map((failure) => failure.index));
        if ([...rejected].some((index) => !Number.isInteger(index) || index < 0 || index >= chunk.length)) throw new Error("Unexpected save response — Refresh to verify saved questions.");
        // Keep the permanent slot IDs the server acknowledged (aligned to the chunk order).
        const ackIds = Array.isArray(data?.savedIds) ? data.savedIds : [];
        const confirmed = chunk.flatMap((item, index) => {
          if (rejected.has(index)) return [];
          const ackId = Number(ackIds[index]);
          return [Number.isSafeInteger(ackId) && ackId > 0 ? { ...item, id: ackId } : item];
        });
        if (typeof data?.saved !== "number" || data.saved !== confirmed.length) throw new Error("Unexpected saved count — Refresh to verify saved questions.");
        confirmedItems.push(...confirmed);
        saved += data.saved;
        for (const failure of data.errors ?? []) {
          const note = `Q${pad(chunk[failure.index].slotIndex + 1)} (${failure.error})`;
          skipped.push(note);
          rejectedNotes.push(note);
        }
        // Object identity also catches switching away and back to the same tab.
        if (workspaceRef.current !== workspace || draftGenerationRef.current !== generation) return;
        if (saveOperationRef.current === operation) {
          setSaveProgress({ done: Math.min(start + chunk.length, items.length), total: items.length });
        }
      }
      void loadCoverage();
      onChanged?.();
      let msg = `Saved ${saved} question${saved === 1 ? "" : "s"} to ${saveVersion} Set ${saveSet}.`;
      if (skipped.length > 0) msg += ` Skipped (need review): ${skipped.join(", ")}.`;
      setNotice(msg);
      // A partially accepted batch must not read as a clean success.
      if (rejectedNotes.length > 0) setError(`Not saved — rejected by the server: ${rejectedNotes.join(", ")}.`);
      setTimeout(() => setNotice(null), 8000);
      scrollContainerRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      if (workspaceRef.current === workspace && draftGenerationRef.current === generation) {
        const partial = confirmedItems.length > 0 ? `${confirmedItems.length} questions saved before the failure. ` : "";
        setError(partial + (e instanceof Error ? e.message : "Save failed."));
      }
    } finally {
      // Only server-confirmed items become the saved baseline, even when a
      // later batch fails. Preserve any edits made during the request.
      if (confirmedItems.length > 0 && workspaceRef.current === workspace && draftGenerationRef.current === generation) {
        setQuestions((prev) => {
          const next = [...(prev ?? [])];
          for (const item of confirmedItems) {
            while (next.length <= item.slotIndex) next.push(null as unknown as ExamQuestion);
            const existing = next[item.slotIndex];
            next[item.slotIndex] = {
              id: existing?.id ?? item.id ?? null,
              examId: exam.id,
              subject: existing?.subject || exam.subject || "",
              question: item.question,
              questionImage: item.questionImage,
              options: [...item.options],
              correctIndex: item.correctIndex,
              explanation: item.explanation,
              marks: existing?.marks ?? item.marks ?? 1,
              isActive: true,
              hasVariant: true,
            };
          }
          return next;
        });
        setDrafts((prev) => {
          const next = { ...prev };
          for (const item of confirmedItems) {
            if (prev[item.slotIndex] !== drafts[item.slotIndex]) continue;
            next[item.slotIndex] = {
              ...prev[item.slotIndex],
              question: item.question,
              options: [...item.options, ...EMPTY_OPTIONS].slice(0, 4),
              correctIndex: item.correctIndex,
              explanation: item.explanation ?? "",
              questionImage: item.questionImage,
            };
          }
          return next;
        });
      }
      if (saveOperationRef.current === operation) {
        setSavingSlot(null);
        setSaveAllBusy(false);
        setSaveProgress(null);
      }
    }
  }

  /**
   * "Remove All" — clears the current workspace view (displayed slots,
   * drafts, warnings, paste area) AND deletes the saved variant cells for
   * this version/set from the database, so Refresh no longer brings them
   * back. Base slots stay; other versions/sets are untouched.
   */
  async function handleRemoveAll() {
    if (!window.confirm("Remove all questions for this Version/Set (including saved)?")) return;
    // Invalidate any in-flight load()/refresh so saved rows can't repopulate the cleared view.
    loadVersionRef.current += 1;
    draftGenerationRef.current += 1;
    setError(null);
    setDetectionCleared(true);
    setDetectWarnings({});
    setDetectExistingMap({});
    setDrafts({});
    setBulkTexts((prev) => ({ ...prev, [activeTab]: "" }));
    setAnswerKeyTexts((prev) => ({ ...prev, [activeTab]: "" }));
    setAnswerKeyMaps((prev) => ({ ...prev, [activeTab]: {} }));
    setAnswerKeyDupes((prev) => ({ ...prev, [activeTab]: [] }));
    setAnswerKeyMsg(null);
    setAnswerKeyError(null);
    // Empty detection state: clear displayed slots + question count (0).
    setQuestions([]);
    setSavingSlot(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    try {
      const res = await fetch("/api/admin/exams/questions", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ examId: exam.id, version: langVersion, set: setLabel, clearAll: true }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? "Failed to clear saved questions.");
      }
      void loadCoverage();
      onChanged?.();
      setNotice("All questions for this Version/Set removed (drafts + saved).");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Remove failed.");
      setNotice("Detection cleared locally — saved questions may still return on Refresh.");
    }
    setTimeout(() => setNotice(null), 5000);
  }

  /** Remove one slot.
   *  - Extra detected slots (beyond Total Questions, never saved): the card
   *    is removed from the list and later extras shift up.
   *  - Fixed slots (within Total Questions): the position must stay (exam
   *    config drives the count), so content is cleared instead — saved
   *    variant cells for this version/set are deleted from the database. */
  async function handleRemoveSlot(slotIndex: number) {
    const slot = slotIndex < displaySlots.length ? displaySlots[slotIndex] : null;
    const q = slot?.q ?? null;
    const savedId = q?.id;
    const isExtra = slotIndex >= totalSlots && (savedId === null || savedId === undefined);
    const hasSavedVariant = !isExtra && (q?.hasVariant === true || ((q?.question?.trim().length ?? 0) >= 3 && savedId !== null && savedId !== undefined));
    if (hasSavedVariant && savedId !== null && savedId !== undefined) {
      if (!window.confirm(`Remove Q${pad(slotIndex + 1)} (including saved)?`)) return;
    }
    if (isExtra) {
      // True removal: drop the draft and compact later extras so the card disappears.
      const shiftMap = (prev: Record<number, string[]>): Record<number, string[]> => {
        const next: Record<number, string[]> = {};
        for (const [k, v] of Object.entries(prev)) {
          const i = Number(k);
          if (i < totalSlots || i < slotIndex) next[i] = v;
          else if (i > slotIndex) next[i - 1] = v;
        }
        return next;
      };
      setDetectWarnings((prev) => shiftMap(prev));
      setDetectExistingMap((prev) => {
        const next: Record<number, boolean> = {};
        for (const [k, v] of Object.entries(prev)) {
          const i = Number(k);
          if (i < totalSlots || i < slotIndex) next[i] = v;
          else if (i > slotIndex) next[i - 1] = v;
        }
        return next;
      });
      setDrafts((prev) => {
        const next: Record<number, SlotDraft> = {};
        for (const [k, v] of Object.entries(prev)) {
          const i = Number(k);
          if (i < totalSlots || i < slotIndex) next[i] = v;
          else if (i > slotIndex) next[i - 1] = v;
        }
        return next;
      });
      return;
    }
    setDetectWarnings((prev) => {
      if (!(slotIndex in prev)) return prev;
      const next = { ...prev };
      delete next[slotIndex];
      return next;
    });
    setDetectExistingMap((prev) => {
      if (!(slotIndex in prev)) return prev;
      const next = { ...prev };
      delete next[slotIndex];
      return next;
    });
    if (hasSavedVariant && savedId !== null && savedId !== undefined) {
      try {
        const res = await fetch("/api/admin/exams/questions", {
          method: "DELETE",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify({ id: savedId, version: langVersion, set: setLabel }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(data?.error ?? "Failed to delete saved question.");
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Remove failed.");
        return;
      }
      setQuestions((prev) => {
        if (!prev) return prev;
        const next = [...prev];
        if (slotIndex < next.length && next[slotIndex]) {
          next[slotIndex] = { ...next[slotIndex], question: "", options: [], correctIndex: null, explanation: null, questionImage: null, hasVariant: false };
        }
        return next;
      });
      void loadCoverage();
      onChanged?.();
    }
    setDrafts((prev) => {
      const next = { ...prev };
      next[slotIndex] = emptyDraft();
      return next;
    });
  }

  /** Global Refresh (top button — the only refresh control on this page).
   * Fetches the latest saved data, then displays it. Never clears anything
   * beforehand: the current list and counters stay visible during the fetch,
   * drafts are replaced only after fresh data arrives, and a failed fetch
   * keeps everything as it was. */
  async function handleRefresh() {
    const v = langVersion;
    const s = setLabel;
    const token = ++loadVersionRef.current;
    const workspace = workspaceRef.current;
    const generation = draftGenerationRef.current;
    const url = `/api/admin/exams/questions?examId=${encodeURIComponent(exam.id)}&version=${v}&set=${s}`;
    setRefreshing(true);
    setError(null);
    try {
      // Single retry on network-level failure (fetch itself throwing).
      let res: Response | null = null;
      let networkError: unknown = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
           
          res = await fetch(url, { cache: "no-store", headers: authHeaders });
          networkError = null;
          break;
        } catch (e) {
          networkError = e;
          res = null;
        }
      }
      if (!res) throw networkError ?? new Error("network request failed");
      if (!res.ok) {
        // Read the server's message for the debug log (never blank the UI).
        const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
        const detail = `Refresh GET ${url} → HTTP ${res.status}${errBody?.error ? `: ${errBody.error}` : ""}`;
         
        console.error("[ExamPaperEditor]", detail);
        if (res.status === 401 || res.status === 403) {
          throw new Error("SESSION_EXPIRED");
        }
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json().catch(() => null)) as { questions?: unknown } | null;
      if (!data || !Array.isArray(data.questions)) {
         
        console.error("[ExamPaperEditor]", `Refresh GET ${url} → unexpected response shape`, data);
        throw new Error("BAD_RESPONSE");
      }
      if (token !== loadVersionRef.current) return;
      if (workspaceRef.current !== workspace || draftGenerationRef.current !== generation) return;
      draftGenerationRef.current += 1;
      const fresh = data.questions as ExamQuestion[];
      setQuestions(fresh);
      setDetectionCleared(false);
      const next: Record<number, SlotDraft> = {};
      for (let i = 0; i < Math.max(totalSlots, fresh.length); i++) {
        next[i] = { ...draftFromQuestion(i < fresh.length ? fresh[i] : null), sourceNumber: i + 1 };
      }
      setDrafts(next);
      setDetectWarnings({});
      setDetectExistingMap({});
      setNotice(null);
      void loadCoverage();
    } catch (e) {
      if (token !== loadVersionRef.current || workspaceRef.current !== workspace || draftGenerationRef.current !== generation) return;
      // Keep everything visible — report what actually happened.
       
      console.error("[ExamPaperEditor] refresh failed:", e);
      if (e instanceof Error && e.message === "SESSION_EXPIRED") {
        setError("Session expired — please reload the page and sign in again, then retry Refresh.");
      } else {
        setError("Refresh failed — showing current data. Please check your connection and try again.");
      }
    } finally {
      if (token === loadVersionRef.current) setRefreshing(false);
    }
  }

  async function handleCorrectChange(slotIndex: number, newIdx: number) {
    // Draft-only: selecting an answer never writes to the database and never
    // reloads anything. It is saved when "Save Questions" is clicked.
    // Stored detection warnings are kept — the content-derived "Answer not
    // selected" issue clears itself on the next render.
    setDrafts((prev) => {
      const cur = prev[slotIndex];
      if (!cur) return prev;
      return { ...prev, [slotIndex]: { ...cur, correctIndex: newIdx } };
    });
  }

  async function handleImageUpload(file: File, slotIndex: number) {
    // Draft-only: the file is uploaded to storage for preview, but the URL is
    // kept in the unsaved draft. It reaches the database via Save Questions.
    if (!bearer) {
      setError("Not authorized — sign in as admin.");
      return;
    }
    const workspace = workspaceRef.current;
    const generation = draftGenerationRef.current;
    const operation = ++imageOperationRef.current;
    setImageUploadingSlot(slotIndex);
    setError(null);
    try {
      const query = new URLSearchParams({ dir: "exams", name: file.name });
      const res = await fetch(`/api/uploads?${query.toString()}`, {
        method: "POST",
        headers: { 
          Authorization: bearer as string,
          "Content-Type": file.type || "application/octet-stream"
        },
        body: file,
      });
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (workspaceRef.current !== workspace || draftGenerationRef.current !== generation || imageOperationRef.current !== operation) return;
      if (!res.ok || !data.url) throw new Error(data.error || "Upload failed.");
      const url = data.url;
      setDrafts((prev) => {
        const cur = prev[slotIndex] ?? emptyDraft();
        return { ...prev, [slotIndex]: { ...cur, questionImage: url } };
      });
      setNotice("Image attached (unsaved — click Save Questions to keep it).");
      setTimeout(() => setNotice(null), 4000);
    } catch (e) {
      if (workspaceRef.current === workspace && draftGenerationRef.current === generation && imageOperationRef.current === operation) {
        setError(e instanceof Error ? e.message : "Image upload failed.");
      }
    } finally {
      if (imageOperationRef.current === operation) {
        setImageUploadingSlot(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    }
  }

  /** Remove the attached image from the unsaved draft (saved data untouched until Save). */
  function handleRemoveImage(slotIndex: number) {
    setDrafts((prev) => {
      const cur = prev[slotIndex];
      if (!cur) return prev;
      return { ...prev, [slotIndex]: { ...cur, questionImage: null } };
    });
  }

  const headerBlock = (
    <div className={embedded ? "rounded-2xl border border-[#dbeafe] bg-white p-4 shadow-sm admin-dark:border-[#1e3a65] admin-dark:bg-[#0f2547] sm:p-5" : "border-b border-[#dbeafe] bg-white shadow-sm admin-dark:border-[#1e3a65] admin-dark:bg-[#0f2547]"}>
      <div className={embedded ? "flex flex-col gap-3" : "mx-auto max-w-4xl flex-col gap-3 px-4 py-4 sm:px-6 sm:py-5"}>
        {!embedded && (
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-lg font-extrabold leading-tight text-[#0b1e3a] admin-dark:text-white sm:text-xl">{exam.title}</h2>
              <p className="mt-1 text-xs font-semibold text-slate-500 admin-dark:text-slate-400">Question Management</p>
            </div>
            <button type="button" onClick={onClose} className={buttonSecondaryClass} aria-label="Close">Close</button>
          </div>
        )}

        {/* Language Version × Set workspaces — same permanent IDs and slot order in all four */}
        <div className="space-y-2 rounded-xl border border-[#dbeafe] bg-[#f8fbff] p-3 admin-dark:border-[#1e3a65] admin-dark:bg-[#0b1e3a]/40">
          <p className="text-xs font-extrabold uppercase tracking-widest text-[#0b1e3a] admin-dark:text-white">Question Version</p>
          <div className="grid grid-cols-2 gap-2">
            {(["bangla", "english"] as LangVersion[]).map((v) => {
              const count = coverage?.coverage[`${v}:${setLabel}`];
              const active = langVersion === v;
              return (
                <button
                  key={v}
                  type="button"
                  onClick={() => setLangVersion(v)}
                  className={`rounded-xl border px-3 py-2.5 text-left transition ${active ? "border-[#1a3a78] bg-[#1a3a78] text-white shadow-md" : "border-[#dbeafe] bg-white text-[#0b1e3a] hover:border-[#93c5fd] admin-dark:border-[#1e3a65] admin-dark:bg-[#0f2547] admin-dark:text-zinc-100"}`}
                >
                  <span className="block text-sm font-extrabold capitalize">{v} Version</span>
                  <span className={`mt-0.5 block text-[11px] font-semibold ${active ? "text-white/80" : "text-slate-500"}`}>
                    {v === "bangla" ? "Bangla / English / mixed content" : "English content only"}
                    {typeof count === "number" && coverage ? ` · ${count}/${coverage.totalSlots} filled` : ""}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="text-xs font-extrabold uppercase tracking-widest text-[#0b1e3a] admin-dark:text-white">Set</p>
          <div className="grid grid-cols-2 gap-2">
            {(["A", "B"] as SetLabel[]).map((s) => {
              const count = coverage?.coverage[`${langVersion}:${s}`];
              const active = setLabel === s;
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSetLabel(s)}
                  className={`rounded-xl border px-3 py-2.5 text-left transition ${active ? "border-emerald-600 bg-emerald-600 text-white shadow-md" : "border-[#dbeafe] bg-white text-[#0b1e3a] hover:border-emerald-400 admin-dark:border-[#1e3a65] admin-dark:bg-[#0f2547] admin-dark:text-zinc-100"}`}
                >
                  <span className="block text-sm font-extrabold">Set {s}</span>
                  <span className={`mt-0.5 block text-[11px] font-semibold ${active ? "text-white/80" : "text-slate-500"}`}>
                    {typeof count === "number" && coverage ? `${count}/${coverage.totalSlots} filled` : "Separate question source"}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="text-[11px] leading-relaxed text-slate-500 admin-dark:text-slate-400">
            Editing <span className="font-extrabold capitalize">{langVersion} Version · Set {setLabel}</span> — same permanent Question IDs (Q01..Q{String(totalSlots).padStart(2, "0")}) and order in all four workspaces. No auto-translation between versions. Students are auto-assigned Set A or B server-side and see a randomized order.
          </p>
        </div>

        {/* Paste area — separate per version/set workspace */}
        <div className="space-y-2">
          <p className="text-sm font-extrabold text-[#0b1e3a] admin-dark:text-white">Paste your questions — <span className="capitalize">{langVersion} Version · Set {setLabel}</span></p>
          <textarea
            value={bulkText}
            onChange={(e) => setBulkText(e.target.value)}
            placeholder={`Paste ${langVersion === "bangla" ? "Bangla / English / mixed" : "English"} questions for Set ${setLabel}`}
            rows={6}
            className="max-h-[40vh] min-h-[100px] w-full resize-y rounded-xl border border-[#dbeafe] bg-[#f8fbff] p-3.5 text-sm leading-relaxed text-[#0b1e3a] placeholder:text-slate-400 focus:border-[#93c5fd] focus:outline-none focus:ring-2 focus:ring-[#bfdbfe] admin-dark:border-[#1e3a65] admin-dark:bg-[#0f2547] admin-dark:text-zinc-100 admin-dark:placeholder:text-slate-500"
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={detectBusy || busy || saveAllBusy}
              onClick={() => void handleDetect()}
              className={`${buttonPrimaryClass} w-full sm:w-auto`}
            >
              {detectBusy ? "Detecting…" : `Detect Questions → ${langVersion === "bangla" ? "Bangla" : "English"} Set ${setLabel}`}
            </button>
            <button
              type="button"
              disabled={detectBusy || busy || saveAllBusy}
              onClick={() => void handleSaveAll()}
              className="w-full rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-extrabold text-white shadow hover:bg-emerald-700 disabled:opacity-40 sm:w-auto"
              title="Permanently save all detected/edited questions, answers and images"
            >
              {saveAllBusy && saveProgress
                ? `Saving… ${saveProgress.done}/${saveProgress.total}`
                : saveAllBusy
                  ? "Saving…"
                  : `Save Questions${dirtyCount > 0 ? ` (${dirtyCount} unsaved)` : ""}`}
            </button>
            <button
              type="button"
              disabled={detectBusy || busy || saveAllBusy}
              onClick={() => void handleRemoveAll()}
              className="w-full rounded-xl border border-red-200 bg-white px-5 py-2.5 text-sm font-bold text-red-600 hover:bg-red-50 disabled:opacity-40 sm:w-auto admin-dark:border-red-900/40 admin-dark:bg-transparent admin-dark:text-red-300 admin-dark:hover:bg-red-500/10"
              title="Remove all questions for this Version/Set (drafts + saved)"
            >
              Remove All
            </button>
          </div>
          {saveAllBusy && saveProgress && saveProgress.total > 0 && (
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={saveProgress.total}
              aria-valuenow={saveProgress.done}
              aria-label="Saving questions"
              className="space-y-1"
            >
              <div className="h-2 w-full overflow-hidden rounded-full bg-emerald-100 admin-dark:bg-emerald-900/40">
                <div
                  className="h-full rounded-full bg-emerald-600 transition-[width] duration-300"
                  style={{ width: `${Math.round((saveProgress.done / saveProgress.total) * 100)}%` }}
                />
              </div>
              <p className="text-[11px] font-bold text-emerald-700 admin-dark:text-emerald-300">
                Saving… {saveProgress.done}/{saveProgress.total} ({Math.round((saveProgress.done / saveProgress.total) * 100)}%)
              </p>
            </div>
          )}
          <p className="text-[11px] leading-relaxed text-slate-400">
            Detected questions stay unsaved until <span className="font-bold">Save Questions</span> is clicked. Leaving this page without saving discards them.
          </p>
        </div>

        {/* ── ANSWER KEY — Included with questions (default) or Separate ── */}
        <div className="space-y-2 rounded-xl border border-[#dbeafe] bg-[#f8fbff] p-3 admin-dark:border-[#1e3a65] admin-dark:bg-[#0b1e3a]/40">
          <p className="text-sm font-extrabold text-[#0b1e3a] admin-dark:text-white">
            Answer Key — <span className="capitalize">{langVersion} Version · Set {setLabel}</span>
          </p>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Answer source">
            {(["included", "separate"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={answerSource === mode}
                onClick={() => setAnswerSource(mode)}
                className={`rounded-xl border px-3 py-2 text-xs font-extrabold transition ${answerSource === mode ? "border-[#1a3a78] bg-[#1a3a78] text-white shadow-md" : "border-[#dbeafe] bg-white text-[#0b1e3a] hover:border-[#93c5fd] admin-dark:border-[#1e3a65] admin-dark:bg-[#0f2547] admin-dark:text-zinc-100"}`}
              >
                {mode === "included" ? "Detect Questions + Answers Together" : "Questions Only + Separate Answer Key"}
              </button>
            ))}
          </div>

          {answerSource === "separate" && (
            <div className="space-y-2 pt-1">
              <textarea
                value={answerKeyText}
                onChange={(e) => setAnswerKeyText(e.target.value)}
                placeholder={`Paste answer key — one per line or compact:\n1-A\n2-B\n3-C\n…or: 1. A  2. B  3. C\n…or: 1-A, 2-B, 3-C\n…or: 1A 2B 3C`}
                rows={4}
                className="max-h-[30vh] min-h-[80px] w-full resize-y rounded-xl border border-[#dbeafe] bg-white p-3 text-sm leading-relaxed text-[#0b1e3a] placeholder:text-slate-400 focus:border-[#93c5fd] focus:outline-none focus:ring-2 focus:ring-[#bfdbfe] admin-dark:border-[#1e3a65] admin-dark:bg-[#0f2547] admin-dark:text-zinc-100 admin-dark:placeholder:text-slate-500"
              />
              <input
                ref={answerKeyFileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
                multiple
                className="hidden"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  if (files.length > 0) void handleAnswerKeyOcr(files);
                }}
              />
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={answerKeyBusy || detectBusy || saveAllBusy}
                  onClick={() => handleDetectAnswerKey()}
                  className={`${buttonPrimaryClass} w-full sm:w-auto`}
                >
                  {answerKeyBusy ? "Detecting…" : "Detect Answer Key"}
                </button>
                <button
                  type="button"
                  disabled={answerKeyBusy || detectBusy || saveAllBusy}
                  onClick={() => answerKeyFileRef.current?.click()}
                  className={`${buttonSecondaryClass} w-full sm:w-auto`}
                  title="Upload answer-key image(s) — transcribed via vision, then parsed"
                >
                  {answerKeyOcrBusy ? answerKeyOcrBusy : "Upload Answer Key Image"}
                </button>
                {Object.keys(answerKeyMap).length > 0 && (
                  <>
                    <button
                      type="button"
                      disabled={answerKeyBusy || detectBusy || saveAllBusy}
                      onClick={handleApplyAnswerKey}
                      className="w-full rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-extrabold text-white shadow hover:bg-emerald-700 disabled:opacity-40 sm:w-auto"
                      title="Match answers to questions by question number"
                    >
                      Apply Answer Key
                    </button>
                    <button
                      type="button"
                      disabled={answerKeyBusy || detectBusy || saveAllBusy}
                      onClick={handleClearAnswerKey}
                      className="w-full rounded-xl border border-red-200 bg-white px-4 py-2.5 text-sm font-bold text-red-600 hover:bg-red-50 disabled:opacity-40 sm:w-auto admin-dark:border-red-900/40 admin-dark:bg-transparent admin-dark:text-red-300"
                    >
                      Clear Key
                    </button>
                  </>
                )}
              </div>
              {answerKeyError && (
                <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-bold text-red-600 admin-dark:border-red-900/40 admin-dark:bg-red-500/10 admin-dark:text-red-300">{answerKeyError}</p>
              )}
              {answerKeyMsg && (
                <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700 admin-dark:border-emerald-900/30 admin-dark:bg-emerald-500/10 admin-dark:text-emerald-300">{answerKeyMsg}</p>
              )}

              {answerKeyStatus.rows.length > 0 && (
                <div className="rounded-xl border border-[#dbeafe] bg-white p-3 admin-dark:border-[#1e3a65] admin-dark:bg-[#0f2547]">
                  <p className="text-xs font-extrabold text-[#0b1e3a] admin-dark:text-white">
                    Answer Key Preview — Total Questions: {answerKeyStatus.totalQuestions} · Answers Detected: {answerKeyStatus.detected}
                    {answerKeyStatus.missing.length > 0 && <span className="text-amber-600"> · Missing: {answerKeyStatus.missing.map((n) => `Q${n}`).join(", ")}</span>}
                  </p>
                  {(answerKeyStatus.extra.length > 0 || answerKeyStatus.invalid.length > 0 || answerKeyDupesForTab.length > 0) && (
                    <p className="mt-1 text-[11px] font-bold leading-relaxed text-amber-700 admin-dark:text-amber-300">
                      {answerKeyStatus.extra.length > 0 && <span>⚠ Extra (no such question): {answerKeyStatus.extra.map((n) => `Q${n}`).join(", ")}. </span>}
                      {answerKeyStatus.invalid.length > 0 && <span>⚠ Invalid: {answerKeyStatus.invalid.map((r) => `Q${r.qNum}→${r.label}`).join(", ")}. </span>}
                      {answerKeyDupesForTab.length > 0 && <span>⚠ Duplicates ignored: {answerKeyDupesForTab.map((n) => `Q${n}`).join(", ")}.</span>}
                    </p>
                  )}
                  <ul className="mt-2 grid max-h-56 grid-cols-2 gap-1.5 overflow-y-auto sm:grid-cols-3">
                    {answerKeyStatus.rows.map((row) => (
                      <li
                        key={row.qNum}
                        className={`flex items-center gap-1.5 rounded-lg border px-2 py-1.5 ${row.state === "matched" ? "border-emerald-200 bg-emerald-50/60 admin-dark:border-emerald-900/40 admin-dark:bg-emerald-500/5" : row.state === "invalid" ? "border-red-200 bg-red-50/60 admin-dark:border-red-900/40 admin-dark:bg-red-500/5" : "border-amber-200 bg-amber-50/60 admin-dark:border-amber-900/40 admin-dark:bg-amber-500/5"}`}
                      >
                        <span className="shrink-0 text-[11px] font-extrabold text-[#0b1e3a] admin-dark:text-zinc-100">Q{row.qNum}</span>
                        <select
                          value={row.label}
                          onChange={(e) => handleAnswerKeyChange(row.qNum, e.target.value)}
                          aria-label={`Answer for question ${row.qNum}`}
                          className="min-w-0 flex-1 rounded-md border border-[#dbeafe] bg-white px-1 py-0.5 text-[11px] font-extrabold text-[#0b1e3a] focus:border-[#93c5fd] focus:outline-none admin-dark:border-[#1e3a65] admin-dark:bg-[#0b1e3a] admin-dark:text-zinc-100"
                        >
                          {["A", "B", "C", "D", "E"].map((opt) => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => handleAnswerKeyChange(row.qNum, "")}
                          aria-label={`Clear answer for question ${row.qNum}`}
                          title="Clear answer"
                          className="shrink-0 rounded px-1 text-[11px] font-bold text-slate-400 hover:text-red-600"
                        >
                          ×
                        </button>
                        <span className="shrink-0 text-[11px]" title={row.state === "matched" ? "Matched" : row.state === "invalid" ? "Invalid — check options" : "No such question"}>
                          {row.state === "matched" ? "✓" : "⚠"}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <input
                      value={addKeyNum}
                      onChange={(e) => setAddKeyNum(e.target.value)}
                      inputMode="numeric"
                      placeholder="Q#"
                      aria-label="Question number to add"
                      className="w-16 rounded-lg border border-[#dbeafe] bg-white px-2 py-1.5 text-xs font-bold text-[#0b1e3a] focus:border-[#93c5fd] focus:outline-none admin-dark:border-[#1e3a65] admin-dark:bg-[#0b1e3a] admin-dark:text-zinc-100"
                    />
                    <select
                      value={addKeyLabel}
                      onChange={(e) => setAddKeyLabel(e.target.value)}
                      aria-label="Answer label to add"
                      className="rounded-lg border border-[#dbeafe] bg-white px-2 py-1.5 text-xs font-extrabold text-[#0b1e3a] focus:border-[#93c5fd] focus:outline-none admin-dark:border-[#1e3a65] admin-dark:bg-[#0b1e3a] admin-dark:text-zinc-100"
                    >
                      {["A", "B", "C", "D", "E"].map((opt) => (
                        <option key={opt} value={opt}>{opt}</option>
                      ))}
                    </select>
                    <button type="button" onClick={handleAnswerKeyAdd} className={buttonSecondaryClass}>
                      Add missing answer
                    </button>
                  </div>
                </div>
              )}
              <p className="text-[11px] leading-relaxed text-slate-400">
                Matching is by question number (Q1→B), not list position. Apply updates the drafts below — review the final preview, then Save Questions.
              </p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-[#eef4ff] pt-3 admin-dark:border-[#1e3a65]/60">
          <p className="text-xs font-extrabold text-slate-600 admin-dark:text-slate-300">{progressText} <span className="font-semibold capitalize">({langVersion} Set {setLabel})</span></p>
          <button type="button" disabled={busy || refreshing} onClick={() => void handleRefresh()} className={buttonSecondaryClass} title="Refresh">{refreshing ? "Refreshing…" : "↻ Refresh"}</button>
        </div>
      </div>
    </div>
  );

  const innerPaper = (
    <div className="mt-4">
      {/* Detection banner for embedded mode */}
      {(error || notice) && (
        <div className="mb-4 space-y-2">
          {error && <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-bold text-red-600 admin-dark:border-red-900/40 admin-dark:bg-red-500/10 admin-dark:text-red-300">{error}</p>}
          {notice && <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700 admin-dark:border-emerald-900/30 admin-dark:bg-emerald-500/10 admin-dark:text-emerald-300">{notice}</p>}
          {Object.keys(detectExistingMap).length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-bold leading-tight text-amber-700 admin-dark:border-amber-800/50 admin-dark:bg-amber-900/20 admin-dark:text-amber-300">
              ⚠ Already-added questions overwritten: {Object.keys(detectExistingMap).map((k) => `Q${pad(Number(k) + 1)}`).join(", ")}
            </div>
          )}
        </div>
      )}
      <div className={embedded ? "" : "mx-auto max-w-4xl px-3 py-6 sm:px-6"}>
        {questions === null ? (
          <p className={`${cardClass} p-6 text-center text-sm text-slate-500`}>Loading paper…</p>
        ) : detectionCleared ? (
          <div className={`${cardClass} p-6 text-center`}>
            <p className="text-sm font-bold text-[#0b1e3a] admin-dark:text-zinc-100">Detection cleared.</p>
            <p className="mt-1 text-xs text-slate-500">Paste a new question set, then Detect.</p>
          </div>
        ) : totalSlots === 0 ? (
          <div className={`${cardClass} p-6 text-center`}>
            <p className="text-sm font-bold text-[#0b1e3a] admin-dark:text-zinc-100">No slots configured.</p>
            <p className="mt-1 text-xs text-slate-500">Set Total Questions on the exam to generate Q01..QNN slots.</p>
          </div>
        ) : (
          <ol className="space-y-4">
            {displaySlots.map(({ index, q }) => {
              const slotNumber = index + 1;
              const draft = drafts[index] ?? draftFromQuestion(q);
              // Ensure 4 options
              const opts = [...draft.options];
              while (opts.length < 4) opts.push("");
              const isSaving = savingSlot === index;
              const warnings = mergedSlotWarnings(detectWarnings[index], draft);
              const imageUrl = draft.questionImage ?? q?.questionImage ?? null;

              return (
                <li
                  key={q?.id ?? `slot-${index}`}
                  style={{ contentVisibility: "auto", containIntrinsicSize: "auto 320px" }}
                  className={`rounded-2xl border bg-white p-4 shadow-sm sm:p-5 ${warnings && warnings.length > 0 ? "border-amber-300 admin-dark:border-amber-700" : "border-[#dbeafe] admin-dark:border-[#1e3a65]"} admin-dark:bg-[#112544]`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-extrabold tracking-widest text-[#0b1e3a] admin-dark:text-zinc-100">
                      Q{pad(slotNumber)}
                      {q?.id !== null && q?.id !== undefined && (
                        <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold tracking-normal text-slate-500 admin-dark:bg-[#0f2547] admin-dark:text-slate-400" title="Permanent Question ID — identical across versions, sets and students">
                          ID {q.id}
                        </span>
                      )}
                    </p>
                    <div className="flex shrink-0 items-center gap-2">
                      {warnings && warnings.length > 0 && (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-extrabold text-amber-700 admin-dark:bg-amber-900/30 admin-dark:text-amber-300">Needs review</span>
                      )}
                      <button
                        type="button"
                        onClick={() => void handleRemoveSlot(index)}
                        className="rounded-lg border border-red-200 bg-white px-2 py-0.5 text-[10px] font-bold text-red-600 hover:bg-red-50 admin-dark:border-red-900/40 admin-dark:bg-transparent admin-dark:text-red-300"
                        title={index >= totalSlots && (q?.id === null || q?.id === undefined) ? `Remove Q${pad(slotNumber)} from the list` : `Clear Q${pad(slotNumber)} content for this Version/Set`}
                      >
                        {index >= totalSlots && (q?.id === null || q?.id === undefined) ? "Remove" : "Clear"}
                      </button>
                    </div>
                  </div>

                  {/* Question text — edits stay unsaved until Save Questions */}
                  <div className="mt-2">
                    <textarea
                      value={draft.question}
                      onChange={(e) => setDrafts((prev) => ({ ...prev, [index]: { ...draft, question: e.target.value, options: opts.slice(0, 4) } }))}
                      placeholder=""
                      rows={2}
                      className="min-h-[48px] w-full resize-y rounded-xl border border-transparent bg-[#f8fbff] p-3 text-sm font-semibold leading-relaxed text-[#0b1e3a] placeholder:text-slate-400 hover:border-[#dbeafe] focus:border-[#93c5fd] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#bfdbfe] admin-dark:bg-[#0f2547] admin-dark:text-zinc-100 admin-dark:placeholder:text-slate-500 admin-dark:focus:bg-[#0f2547]"
                    />
                    {imageUrl && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={imageUrl} alt="Question image" className="mt-3 max-h-48 w-auto rounded-xl border border-neutral-200 object-contain admin-dark:border-zinc-700" />
                    )}
                    {isSaving && <p className="mt-1 text-[11px] font-bold text-slate-400">Saving…</p>}
                  </div>

                  {/* Options — directly editable */}
                  <div className="mt-3 space-y-2">
                    {opts.slice(0, 4).map((opt, oi) => {
                      const isCorrect = draft.correctIndex === oi;
                      return (
                        <div
                          key={oi}
                          className={`flex items-center gap-2 rounded-xl border px-3 py-2 transition ${isCorrect ? "border-[#2f6bce] bg-[#eff6ff] admin-dark:border-[#2f6bce] admin-dark:bg-[#1a3a78]/30" : "border-[#e2e8f0] bg-[#f8fbff] hover:border-[#93c5fd] admin-dark:border-[#1e3a65] admin-dark:bg-[#0f2547]"}`}
                        >
                          <button
                            type="button"
                            aria-label={`Mark option ${String.fromCharCode(65 + oi)} as correct`}
                            onClick={() => void handleCorrectChange(index, oi)}
                            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 text-[11px] font-extrabold ${isCorrect ? "border-[#1a3a78] bg-[#1a3a78] text-white admin-dark:border-[#3b82f6] admin-dark:bg-[#3b82f6]" : "border-slate-300 bg-white text-slate-500 admin-dark:border-zinc-600 admin-dark:bg-[#112544]"}`}
                          >
                            {isCorrect ? "●" : "○"}
                          </button>
                          <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-extrabold ${isCorrect ? "bg-[#1a3a78] text-white admin-dark:bg-[#3b82f6]" : "bg-white text-slate-500 border border-slate-200 admin-dark:bg-[#1e3a65] admin-dark:text-slate-300"}`}>
                            {String.fromCharCode(65 + oi)}
                          </span>
                          <input
                            value={opt}
                            onChange={(e) => {
                              const nextOpts = [...opts];
                              nextOpts[oi] = e.target.value;
                              setDrafts((prev) => ({ ...prev, [index]: { ...draft, options: nextOpts.slice(0, 4) } }));
                            }}
                            placeholder=""
                            className="min-w-0 flex-1 bg-transparent text-sm font-semibold text-slate-700 placeholder:text-slate-400 focus:outline-none admin-dark:text-zinc-200 admin-dark:placeholder:text-slate-500"
                          />
                        </div>
                      );
                    })}
                  </div>

                  {warnings && warnings.length > 0 && (
                    <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 admin-dark:border-amber-800/50 admin-dark:bg-amber-900/20">
                      {warnings.map((w, wi) => (
                        <p key={wi} className="text-[11px] font-bold leading-tight text-amber-700 admin-dark:text-amber-300">
                          ⚠ {w}
                        </p>
                      ))}
                    </div>
                  )}

                  {/* Explanation — editable per question */}
                  <div className="mt-3">
                    <label className="mb-1 block text-[11px] font-bold uppercase tracking-widest text-slate-500 admin-dark:text-slate-400">
                      Explanation / ব্যাখ্যা
                    </label>
                    <textarea
                      rows={2}
                      value={draft.explanation}
                      onChange={(e) => {
                        setDrafts((prev) => ({ ...prev, [index]: { ...draft, explanation: e.target.value } }));
                      }}
                      placeholder="ব্যাখ্যা বা Explanation লিখুন (ঐচ্ছিক)"
                      className="w-full rounded-lg border border-[#dbeafe] bg-[#f8fbff] px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400 focus:border-[#2f6bce] focus:ring-2 focus:ring-[#2f6bce]/10 admin-dark:border-[#1e3a65] admin-dark:bg-[#132a4f] admin-dark:text-slate-200 admin-dark:placeholder:text-slate-500 admin-dark:focus:border-[#2f5aa0]"
                    />
                  </div>

                  {/* Image upload — per question (unsaved until Save Questions) */}
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={imageUploadingSlot === index}
                      onClick={() => {
                        if (fileInputRef.current) {
                          fileInputRef.current.setAttribute("data-slot", String(index));
                          fileInputRef.current.click();
                        }
                      }}
                      className="rounded-lg border border-[#dbeafe] bg-white px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-[#eff6ff] disabled:opacity-40 admin-dark:border-[#1e3a65] admin-dark:bg-[#0f2547] admin-dark:text-slate-300"
                    >
                      {imageUploadingSlot === index ? "Uploading…" : imageUrl ? "Replace Image" : "Image Upload"}
                    </button>
                    {imageUrl && (
                      <>
                        <span className="max-w-[220px] truncate text-xs text-slate-500 admin-dark:text-slate-400">{imageUrl.slice(0, 40)}…</span>
                        <button
                          type="button"
                          onClick={() => handleRemoveImage(index)}
                          className="rounded-lg border border-red-200 bg-white px-2 py-1 text-xs font-bold text-red-600 hover:bg-red-50 admin-dark:border-red-900/40 admin-dark:bg-transparent admin-dark:text-red-300"
                        >
                          Remove
                        </button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );

  const hiddenFileInput = (
    <input
      ref={fileInputRef}
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
      className="hidden"
      onChange={(e) => {
        const file = e.target.files?.[0];
        const slotAttr = e.target.getAttribute("data-slot");
        const slotIndex = slotAttr ? Number(slotAttr) : -1;
        if (file && slotIndex >= 0) void handleImageUpload(file, slotIndex);
      }}
    />
  );

  if (embedded) {
    return (
      <div className="space-y-4">
        {hiddenFileInput}
        {headerBlock}
        {innerPaper}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#f1f5f9] admin-dark:bg-[#0b1628]" role="dialog" aria-modal="true">
      {/* Single scroll container — headerBlock scrolls away, detection banner sticks */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto overscroll-contain">
        {hiddenFileInput}
        {headerBlock}

        {/* Sticky detection banner — stays visible while scrolling questions */}
        {(error || notice) && (
          <div className="sticky top-0 z-20 space-y-2 bg-[#f1f5f9] px-4 pt-3 sm:px-6 admin-dark:bg-[#0b1628]">
            {error && <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-bold text-red-600 shadow-md admin-dark:border-red-900/40 admin-dark:bg-red-500/10 admin-dark:text-red-300">{error}</p>}
            {notice && <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700 shadow-md admin-dark:border-emerald-900/30 admin-dark:bg-emerald-500/10 admin-dark:text-emerald-300">{notice}</p>}
            {Object.keys(detectExistingMap).length > 0 && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-bold leading-tight text-amber-700 shadow-md admin-dark:border-amber-800/50 admin-dark:bg-amber-900/20 admin-dark:text-amber-300">
                ⚠ Already-added questions overwritten: {Object.keys(detectExistingMap).map((k) => `Q${pad(Number(k) + 1)}`).join(", ")}
              </div>
            )}
          </div>
        )}

        {/* Questions list */}
        <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
          {questions === null ? (
            <p className={`${cardClass} p-6 text-center text-sm text-slate-500`}>Loading paper…</p>
          ) : detectionCleared ? (
            <div className={`${cardClass} p-6 text-center`}>
              <p className="text-sm font-bold text-[#0b1e3a] admin-dark:text-zinc-100">Detection cleared.</p>
              <p className="mt-1 text-xs text-slate-500">Paste a new question set, then Detect.</p>
            </div>
          ) : totalSlots === 0 ? (
            <div className={`${cardClass} p-6 text-center`}>
              <p className="text-sm font-bold text-[#0b1e3a] admin-dark:text-zinc-100">No slots configured.</p>
              <p className="mt-1 text-xs text-slate-500">Set Total Questions on the exam to generate Q01..QNN slots.</p>
            </div>
          ) : (
            <ol className="space-y-4">
              {displaySlots.map(({ index, q }) => {
                const slotNumber = index + 1;
                const draft = drafts[index] ?? draftFromQuestion(q);
                const opts = [...draft.options];
                while (opts.length < 4) opts.push("");
                const isSaving = savingSlot === index;
                const warnings = mergedSlotWarnings(detectWarnings[index], draft);
                const imageUrl = draft.questionImage ?? q?.questionImage ?? null;

                return (
                  <li
                    key={q?.id ?? `slot-${index}`}
                    style={{ contentVisibility: "auto", containIntrinsicSize: "auto 320px" }}
                    className={`rounded-2xl border bg-white p-4 shadow-sm sm:p-5 ${warnings && warnings.length > 0 ? "border-amber-300 admin-dark:border-amber-700" : "border-[#dbeafe] admin-dark:border-[#1e3a65]"} admin-dark:bg-[#112544]`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-extrabold tracking-widest text-[#0b1e3a] admin-dark:text-zinc-100">
                        Q{pad(slotNumber)}
                        {q?.id !== null && q?.id !== undefined && (
                          <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold tracking-normal text-slate-500 admin-dark:bg-[#0f2547] admin-dark:text-slate-400" title="Permanent Question ID — identical across versions, sets and students">
                            ID {q.id}
                          </span>
                        )}
                      </p>
                      <div className="flex shrink-0 items-center gap-2">
                        {warnings && warnings.length > 0 && (
                          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-extrabold text-amber-700 admin-dark:bg-amber-900/30 admin-dark:text-amber-300">Needs review</span>
                        )}
                        <button
                          type="button"
                          onClick={() => void handleRemoveSlot(index)}
                          className="rounded-lg border border-red-200 bg-white px-2 py-0.5 text-[10px] font-bold text-red-600 hover:bg-red-50 admin-dark:border-red-900/40 admin-dark:bg-transparent admin-dark:text-red-300"
                          title={index >= totalSlots && (q?.id === null || q?.id === undefined) ? `Remove Q${pad(slotNumber)} from the list` : `Clear Q${pad(slotNumber)} content for this Version/Set`}
                        >
                          {index >= totalSlots && (q?.id === null || q?.id === undefined) ? "Remove" : "Clear"}
                        </button>
                      </div>
                    </div>

                    <div className="mt-2">
                      <textarea
                        value={draft.question}
                        onChange={(e) => setDrafts((prev) => ({ ...prev, [index]: { ...draft, question: e.target.value, options: opts.slice(0, 4) } }))}
                        placeholder=""
                        rows={2}
                        className="min-h-[48px] w-full resize-y rounded-xl border border-transparent bg-[#f8fbff] p-3 text-sm font-semibold leading-relaxed text-[#0b1e3a] placeholder:text-slate-400 hover:border-[#dbeafe] focus:border-[#93c5fd] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#bfdbfe] admin-dark:bg-[#0f2547] admin-dark:text-zinc-100 admin-dark:placeholder:text-slate-500 admin-dark:focus:bg-[#0f2547]"
                      />
                      {imageUrl && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={imageUrl} alt="Question image" className="mt-3 max-h-48 w-auto rounded-xl border border-neutral-200 object-contain admin-dark:border-zinc-700" />
                      )}
                      {isSaving && <p className="mt-1 text-[11px] font-bold text-slate-400">Saving…</p>}
                    </div>

                    <div className="mt-3 space-y-2">
                      {opts.slice(0, 4).map((opt, oi) => {
                        const isCorrect = draft.correctIndex === oi;
                        return (
                          <div
                            key={oi}
                            className={`flex items-center gap-2 rounded-xl border px-3 py-2 transition ${isCorrect ? "border-[#2f6bce] bg-[#eff6ff] admin-dark:border-[#2f6bce] admin-dark:bg-[#1a3a78]/30" : "border-[#e2e8f0] bg-[#f8fbff] hover:border-[#93c5fd] admin-dark:border-[#1e3a65] admin-dark:bg-[#0f2547]"}`}
                          >
                            <button
                              type="button"
                              aria-label={`Mark option ${String.fromCharCode(65 + oi)} as correct`}
                              onClick={() => void handleCorrectChange(index, oi)}
                              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 text-[11px] font-extrabold ${isCorrect ? "border-[#1a3a78] bg-[#1a3a78] text-white admin-dark:border-[#3b82f6] admin-dark:bg-[#3b82f6]" : "border-slate-300 bg-white text-slate-500 admin-dark:border-zinc-600 admin-dark:bg-[#112544]"}`}
                            >
                              {isCorrect ? "●" : "○"}
                            </button>
                            <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-extrabold ${isCorrect ? "bg-[#1a3a78] text-white admin-dark:bg-[#3b82f6]" : "bg-white text-slate-500 border border-slate-200 admin-dark:bg-[#1e3a65] admin-dark:text-slate-300"}`}>
                              {String.fromCharCode(65 + oi)}
                            </span>
                            <input
                              value={opt}
                              onChange={(e) => {
                                const nextOpts = [...opts];
                                nextOpts[oi] = e.target.value;
                                setDrafts((prev) => ({ ...prev, [index]: { ...draft, options: nextOpts.slice(0, 4) } }));
                              }}
                              placeholder=""
                              className="min-w-0 flex-1 bg-transparent text-sm font-semibold text-slate-700 placeholder:text-slate-400 focus:outline-none admin-dark:text-zinc-200 admin-dark:placeholder:text-slate-500"
                            />
                          </div>
                        );
                      })}
                    </div>

                    {warnings && warnings.length > 0 && (
                      <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 admin-dark:border-amber-800/50 admin-dark:bg-amber-900/20">
                        {warnings.map((w, wi) => (
                          <p key={wi} className="text-[11px] font-bold leading-tight text-amber-700 admin-dark:text-amber-300">
                            ⚠ {w}
                          </p>
                        ))}
                      </div>
                    )}

                    {/* Image upload — per question (unsaved until Save Questions) */}
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={imageUploadingSlot === index}
                        onClick={() => {
                          if (fileInputRef.current) {
                            fileInputRef.current.setAttribute("data-slot", String(index));
                            fileInputRef.current.click();
                          }
                        }}
                        className="rounded-lg border border-[#dbeafe] bg-white px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-[#eff6ff] disabled:opacity-40 admin-dark:border-[#1e3a65] admin-dark:bg-[#0f2547] admin-dark:text-slate-300"
                      >
                        {imageUploadingSlot === index ? "Uploading…" : imageUrl ? "Replace Image" : "Image Upload"}
                      </button>
                      {imageUrl && (
                        <>
                          <span className="max-w-[220px] truncate text-xs text-slate-500 admin-dark:text-slate-400">{imageUrl.slice(0, 40)}…</span>
                          <button
                            type="button"
                            onClick={() => handleRemoveImage(index)}
                            className="rounded-lg border border-red-200 bg-white px-2 py-1 text-xs font-bold text-red-600 hover:bg-red-50 admin-dark:border-red-900/40 admin-dark:bg-transparent admin-dark:text-red-300"
                          >
                            Remove
                          </button>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </div>
      <div className="shrink-0 border-t border-[#dbeafe] bg-white p-3 text-center admin-dark:border-[#1e3a65] admin-dark:bg-[#112544]">
        <button type="button" onClick={onClose} className={buttonSecondaryClass}>Close</button>
      </div>
    </div>
  );
}
