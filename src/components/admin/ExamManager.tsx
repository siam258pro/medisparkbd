"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AccessLoading, AccessMessage } from "@/components/auth/AccessGuard";
import AdminCenterLoader from "@/components/admin/AdminCenterLoader";
import {
  useAdminGate,
  hasPublicExamAccess,
  noticeClass,
  cardClass,
  inputClass,
  labelClass,
  buttonPrimaryClass,
  buttonSecondaryClass,
  buttonDangerClass,
  type Notice,
} from "@/components/admin/admin-ui";
import ExamPaperEditor from "@/components/admin/ExamPaperEditor";
import ExamSetAutoSync from "@/components/admin/ExamSetAutoSync";
import ExamRulesEditor from "@/components/admin/ExamRulesEditor";
import { URL_MESSAGE, isValidHttpUrl } from "@/lib/form-validation";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MediaUploadField } from "@/components/admin/MediaUploadField";
import { examCategoryLabel, toDhakaInputValue, type ExamCategory } from "@/lib/public-exams";
import { examToPublic } from "@/lib/public-exam-view";
import ExamCard from "@/components/ExamCard";
import {
  matchMedicalPracticeSubject,
  OTHER_PRACTICE_SUBJECT_KEY,
} from "@/lib/public-exam-structure";

export type Exam = {
  id: string;
  title: string;
  description: string | null;
  bannerUrl: string | null;
  kind: "public" | "practice" | "enrolled";
  examMode: "live" | "practice";
  batchId: string;
  subject: string;
  courseType: "Academic" | "Admission";
  durationMinutes: number;
  totalMarks: number;
  negativeMarks: number;
  /** Per-exam Admin setting: wrong answers cost negativePerWrong when ON. */
  negativeEnabled: boolean;
  negativePerWrong: number;
  /** Per-exam Admin setting: repeat attempt of THIS exam loses marks. */
  secondTimerEnabled: boolean;
  secondTimerDeduction: number;
  questionCount: number;
  status: "draft" | "published" | "closed";
  scheduledAt: string | null;
  endsAt: string | null;
  answerKey: Record<string, number> | null;
  courseIds: string[];
  chapterId: string | null;
  sortOrder: number;
  /** Public Exam Control category (Course Control id). */
  categoryId: string | null;
  /** Featured public exams auto-appear in the homepage slider. */
  featured: boolean;
  /** Flow 5 exam category (null/"" = legacy exam, old Exam flow). */
  examFormat: "topic-wise" | "paper-final" | "subject-final" | "final-model" | null;
  /** Flow 5 topic-wise subject key (one of the 8 fixed subjects). */
  topicSubject: string | null;
  /** Unified access scope — derived from kind. */
  scope: "PUBLIC" | "COURSE";
  /** Selected rule template key (medical/academic/university). */
  ruleTemplate: string | null;
};

/** When set, the manager is scoped to one Course Control category. */
export type FixedCategory = { id: string; name: string };

/** When set, the manager is scoped to one chapter/subject context. */
export type FixedChapter = { id: string; name: string };

/** When set, the manager is scoped to one course (Flow 4 Exam Batch). */
export type FixedCourse = { slug: string; name: string };

const EMPTY = {
  id: "",
  title: "",
  bannerUrl: "",
  negativeEnabled: false,
  negativePerWrong: "0.25",
  secondTimerEnabled: false,
  secondTimerDeduction: "3",
  kind: "public" as Exam["kind"],
  examMode: "live" as "live" | "practice",
  batchId: "hsc-28",
  subject: "",
  chapterId: "",
  courseType: "Academic" as "Academic" | "Admission",
  durationMinutes: "30",
  negativeMarks: "0.25",
  totalMarks: "",
  status: "draft" as "draft" | "published" | "closed",
  scheduledAt: "",
  endsAt: "",
  ruleTemplate: "academic" as string,
  questionCount: "30",
  marksPerQuestion: "1",
  examFormat: "" as "" | "topic-wise" | "paper-final" | "subject-final" | "final-model",
  topicSubject: "",
};

function generateExamId(title?: string): string {
  const base =
    title
      ?.toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 20) || "exam";
  const rand = Math.random().toString(36).slice(2, 6);
  const ts = Date.now().toString(36).slice(-4);
  return `${base}-${ts}${rand}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 64);
}

function formatExamTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true });
  } catch {
    return "—";
  }
}

function flow4Phase(exam: { scheduledAt: string | null; endsAt: string | null; status?: string }): "upcoming" | "live" | "archived" | "practice" | "no-window" {
  const now = Date.now();
  const s = exam.scheduledAt ? new Date(exam.scheduledAt).getTime() : NaN;
  const e = exam.endsAt ? new Date(exam.endsAt).getTime() : NaN;
  const hasS = Number.isFinite(s);
  const hasE = Number.isFinite(e);
  if ((exam as { status?: string }).status === "closed") {
    return "archived";
  }
  if (!hasS && !hasE) return "no-window";
  if (hasS && now < s) return "upcoming";
  if (hasE && now > e) return "archived";
  return "live";
}

function flow4PhaseBadge(phase: ReturnType<typeof flow4Phase>): { label: string; className: string } {
  if (phase === "upcoming") return { label: "Upcoming", className: "bg-amber-500/10 text-amber-700 ring-amber-500/20 admin-dark:bg-amber-500/10 admin-dark:text-amber-400" };
  if (phase === "live") return { label: "Live", className: "bg-emerald-500/10 text-emerald-700 ring-emerald-500/20 admin-dark:bg-emerald-500/10 admin-dark:text-emerald-400" };
  if (phase === "practice" || phase === "archived") return { label: "Archived", className: "bg-violet-500/10 text-violet-700 ring-violet-500/20 admin-dark:bg-violet-500/10 admin-dark:text-violet-400" };
  return { label: "Live", className: "bg-sky-500/10 text-sky-700 ring-sky-500/20" };
}

function detectTemplateForCategory(cat: FixedCategory | null | undefined): string {
  if (!cat) return "academic";
  const token = `${cat.name}`.toLowerCase();
  if (/medical/.test(token)) return "medical";
  if (/varsity|universit/.test(token)) return "university";
  if (/ssc|hsc|academic/.test(token)) return "academic";
  const label = examCategoryLabel(cat).toLowerCase();
  if (/medical/.test(label)) return "medical";
  if (/university|varsity/.test(label)) return "university";
  return "academic";
}

type CourseOption = { slug: string; name: string };
type ChapterOption = { id: string; name: string };

// Render cap — full filtered lists can be large; show first N + refine hint.
const EXAM_LIST_LIMIT = 100;

export default function ExamManager({
  title,
  description,
  kindFilter,
  allowEnrolled = false,
  fixedCategory,
  fixedChapter,
  fixedCourse,
  fixedFormat,
  fixedTopicSubject,
  controlledMode,
  controlledSubjectKey,
  publicCategoryKey,
  hideModeTabs = false,
  onExamsChange,
}: {
  title: string;
  description: string;
  /** One kind or several (comma-separated in the API query). */
  kindFilter?: "public" | "practice" | "enrolled" | ("public" | "practice" | "enrolled")[];
  /** Show the "Enrolled" kind + course assignment picker. */
  allowEnrolled?: boolean;
  /** Public Exam Control mode — only this category's public exams. */
  fixedCategory?: FixedCategory;
  /** Course Content Control mode — only this chapter's exams. */
  fixedChapter?: FixedChapter;
  /** Flow 4 Exam Batch mode — only this course's enrolled exams. */
  fixedCourse?: FixedCourse;
  /** Course Content Control exam-flow mode — only this Flow-5 category (format lock). */
  fixedFormat?: "topic-wise" | "paper-final" | "subject-final" | "final-model";
  /** Topic-wise subject lock (one of the 8 fixed subjects) — implies topic-wise. */
  fixedTopicSubject?: string;
  /**
   * Public Exam Control structure — Category → Live Exam | Practice Exam.
   * When set, the parent drives filtering (segmented filter + subject
   * navigation) and the internal mode tabs are hidden.
   */
  controlledMode?: "live" | "practice";
  /**
   * Practice subject filter: a medical subject key (or "other") for the
   * medical category, an exact subject name otherwise. Null = all subjects.
   */
  controlledSubjectKey?: string | null;
  /** Public Exam category key of the surrounding page (subject matching). */
  publicCategoryKey?: ExamCategory | null;
  hideModeTabs?: boolean;
  /** Emits the loaded exams so the parent can build subject cards/counts. */
  onExamsChange?: (exams: Exam[]) => void;
}) {
  const gate = useAdminGate();
  const router = useRouter();
  const [exams, setExams] = useState<Exam[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [categoryOptions, setCategoryOptions] = useState<FixedCategory[]>([]);
  const [formCategoryId, setFormCategoryId] = useState("");
  const [form, setForm] = useState(EMPTY);
  const [courseIds, setCourseIds] = useState<string[]>([]);
  const [courseOptions, setCourseOptions] = useState<CourseOption[]>([]);
  const [chapterOptions, setChapterOptions] = useState<ChapterOption[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingSortOrder, setEditingSortOrder] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [questionsExam, setQuestionsExam] = useState<Exam | null>(null);
  const [syncExam, setSyncExam] = useState<Exam | null>(null);
  const [modeFilter, setModeFilter] = useState<"all" | "live" | "practice">(
    // Public Exam Control structure defaults to the Live Exam tab.
    fixedCategory ? "live" : "all",
  );
  const [phaseFilter, setPhaseFilter] = useState<"all" | "upcoming" | "live" | "closed" | "archived" | "practice">("all");

  // Monotonic request id — a slow earlier response can never overwrite the
  // result of a newer load (filter change / retry / save).
  const requestRef = useRef(0);
  // eslint-safe parent callback: unmemoized onExamsChange must not retrigger.
  const onExamsChangeRef = useRef(onExamsChange);
  useEffect(() => {
    onExamsChangeRef.current = onExamsChange;
  }, [onExamsChange]);
  const lastEmittedExamsRef = useRef<Exam[] | null>(null);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    // Enter LOADING: clear any previous error and reset data to null so a
    // retry never renders a stale `[]` as a false "No exams yet" while the
    // new request is still in flight. Only a 200-confirmed `[]` may render
    // the genuine empty state below.
    setLoadError(false);
    setExams(null);
    try {
      const params = new URLSearchParams();
      if (fixedCategory) {
        // Database/API-level isolation — only this category's exams, both
        // live-mode (kind public) and practice exams (legacy kind practice
        // or exam_mode practice) so the Live/Practice structure matches the
        // Main Website. Course (enrolled) exams stay excluded.
        params.set("kind", "public,practice");
        params.set("categoryId", fixedCategory.id);
        if (fixedChapter) params.set("chapterId", fixedChapter.id);
      } else if (fixedCourse) {
        // Flow 4 Exam Batch — enrolled exams assigned to this course.
        params.set("kind", "enrolled");
        params.set("courseId", fixedCourse.slug);
      } else if (fixedChapter) {
        params.set("chapterId", fixedChapter.id);
        const kinds = Array.isArray(kindFilter) ? kindFilter : kindFilter ? [kindFilter] : [];
        if (kinds.length > 0) params.set("kind", kinds.join(","));
      } else {
        const kinds = Array.isArray(kindFilter) ? kindFilter : kindFilter ? [kindFilter] : [];
        if (kinds.length > 0) params.set("kind", kinds.join(","));
      }
      const query = params.toString();
      const response = await fetch(`/api/admin/exams${query ? `?${query}` : ""}`, {
        cache: "no-store",
        headers: gate.headers,
      });
      if (!response.ok) throw new Error("failed");
      const data = (await response.json()) as { exams?: Exam[] };
      // A superseded (slow earlier) response must never overwrite newer state.
      if (requestRef.current !== requestId) return;
      setExams(data.exams ?? []);
    } catch {
      if (requestRef.current !== requestId) return;
      // ERROR keeps exams as null (never `[]`) so the UI shows Try Again —
      // never a false empty state.
      setLoadError(true);
    }
  }, [kindFilter, fixedCategory, fixedChapter, fixedCourse, gate.headers]);

  useEffect(() => {
    if (gate.ready) void Promise.resolve().then(load);
  }, [gate.ready, load]);

  // Let the Public Exam Control parent build subject cards/counts from the
  // same loaded exams (no duplicate fetching). Guarded by identity so an
  // unmemoized parent callback can never cause a loop.
  useEffect(() => {
    if (exams && lastEmittedExamsRef.current !== exams) {
      lastEmittedExamsRef.current = exams;
      onExamsChangeRef.current?.(exams);
    }
  }, [exams]);

  // Course Control categories — required for public exams created outside a
  // category page so they never end up invisible in Public Exam Control.
  useEffect(() => {
    if (!gate.ready) return;
    let cancelled = false;
    fetch("/api/course-categories", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : { categories: [] }))
      .then((data: { categories?: FixedCategory[] }) => {
        if (!cancelled) setCategoryOptions(data.categories ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [gate.ready]);

  // Course options for the enrolled-exam assignment picker.
  useEffect(() => {
    if (!gate.ready || !allowEnrolled) return;
    fetch("/api/admin/course-subjects", { cache: "no-store", headers: gate.headers })
      .then((response) => response.json())
      .then((data: { courses?: CourseOption[] }) => setCourseOptions(data.courses ?? []))
      .catch(() => setCourseOptions([]));
  }, [gate.ready, allowEnrolled]); // eslint-disable-line react-hooks/exhaustive-deps -- gate.headers is stable

  // Chapter options — exams attach to a chapter for the course-content Exam card.
  useEffect(() => {
    if (!gate.ready) return;
    fetch("/api/admin/chapters", { cache: "no-store", headers: gate.headers })
      .then((response) => response.json())
      .then((data: { chapters?: ChapterOption[] }) => setChapterOptions(data.chapters ?? []))
      .catch(() => setChapterOptions([]));
  }, [gate.ready]); // eslint-disable-line react-hooks/exhaustive-deps -- gate.headers is stable

  if (!gate.ready) {
    return gate.denied ? (
      <AccessMessage title="Administrators only" message="Exam management is restricted to authorized administrators." actionLabel="Back to Admin Home" actionHref="/admin" />
    ) : (
      <AccessLoading label="Loading exams…" />
    );
  }

  // Public Exam Control inheritance (Category → exam list): when scoped to
  // one Public Exam Control category, require the SAME managePublicExam |
  // manageExams entry permission as the parent category page and the exam
  // APIs. Admin always passes; a moderator/teacher holding either permission
  // keeps full management access (list, add, edit, delete, questions);
  // anyone without both is denied here instead of hitting per-action
  // failures deeper in the flow. Other ExamManager contexts (Course Content
  // Control chapters, enrolled batches, legacy pages) keep their own gates.
  if (fixedCategory && !hasPublicExamAccess(gate)) {
    return (
      <AccessMessage
        title="No Permission"
        message="Public Exam Control access is required to manage this category's exams. Contact an Admin to grant it."
        actionLabel="Back to Admin Home"
        actionHref="/admin"
      />
    );
  }

  // Unified Exam System — Course exams use the SAME complete form/engine as
  // Public exams. Only the access scope differs: PUBLIC (fixedCategory) vs
  // COURSE (fixedCourse / fixedChapter → enrolled students of that course).
  const isCourseScope = !fixedCategory && (Boolean(fixedCourse) || Boolean(fixedChapter));
  const useUnifiedForm = Boolean(fixedCategory) || isCourseScope;

  function startCreate() {
    if (fixedCategory) {
      const tpl = detectTemplateForCategory(fixedCategory);
      const isSecond = tpl === "medical";
      setForm({
        ...EMPTY,
        id: generateExamId(),
        ruleTemplate: tpl,
        questionCount: "30",
        marksPerQuestion: "1",
        secondTimerEnabled: isSecond,
        secondTimerDeduction: isSecond ? "3" : "0",
      });
    } else if (isCourseScope) {
      // Course exam — same complete system as Public Exam Control, but COURSE
      // scope: auto-assigned to this course (or chapter chain), enrolled-only.
      // Exam-flow pages additionally lock the Flow-5 category + subject.
      const tpl = "academic";
      setForm({
        ...EMPTY,
        id: generateExamId(),
        kind: "enrolled",
        ruleTemplate: tpl,
        questionCount: "30",
        marksPerQuestion: "1",
        secondTimerEnabled: false,
        secondTimerDeduction: "0",
        chapterId: fixedChapter ? fixedChapter.id : "",
        examFormat: fixedFormat ?? "",
        topicSubject: fixedTopicSubject ?? "",
      });
    } else {
      setForm(EMPTY);
    }
    setCourseIds(fixedCourse ? [fixedCourse.slug] : []);
    setFormCategoryId("");
    setEditingId(null);
    setEditingSortOrder(null);
    setShowForm(true);
    setNotice(null);
  }

  function startEdit(exam: Exam) {
    const tpl =
      (exam as unknown as { ruleTemplate?: string | null }).ruleTemplate ??
      detectTemplateForCategory(fixedCategory ?? null);
    const qc = (exam as unknown as { questionCount?: number }).questionCount ?? exam.questionCount ?? 30;
    const mpq = (exam as unknown as { marksPerQuestion?: number | null }).marksPerQuestion ?? 1;
    setForm({
      id: exam.id,
      title: exam.title,
      bannerUrl: exam.bannerUrl ?? "",
      negativeEnabled: exam.negativeEnabled ?? exam.negativeMarks > 0,
      negativePerWrong: String(exam.negativePerWrong ?? 0.25),
      secondTimerEnabled: Boolean(exam.secondTimerEnabled),
      secondTimerDeduction: String(exam.secondTimerDeduction ?? 3),
      kind: exam.kind,
      examMode: (exam.examMode ?? "live") as "live" | "practice",
      batchId: exam.batchId || "hsc-28",
      subject: exam.subject,
      chapterId: fixedChapter ? fixedChapter.id : (exam.chapterId ?? ""),
      courseType: exam.courseType,
      durationMinutes: String(exam.durationMinutes),
      negativeMarks: String(exam.negativeMarks),
      totalMarks: exam.totalMarks ? String(exam.totalMarks) : "",
      status: exam.status,
      scheduledAt: toDhakaInputValue(exam.scheduledAt),
      endsAt: toDhakaInputValue(exam.endsAt),
      ruleTemplate: tpl || "academic",
      questionCount: String(qc || 30),
      marksPerQuestion: String(mpq ?? 1),
      examFormat: (exam.examFormat ?? "") as typeof EMPTY.examFormat,
      topicSubject: exam.topicSubject ?? "",
    });
    setCourseIds(exam.courseIds ?? []);
    setFormCategoryId(exam.categoryId ?? "");
    setEditingSortOrder(exam.sortOrder ?? null);
    setEditingId(exam.id);
    setShowForm(true);
    setNotice(null);
  }

  async function save() {
    // Unified scope — COURSE pages force enrolled + the linked course (admin
    // never picks); PUBLIC pages force public + the fixed category.
    const effectiveKind = fixedCategory ? "public" : isCourseScope ? "enrolled" : form.kind;
    const effectiveCourseIds = fixedCourse ? [fixedCourse.slug] : courseIds;
    // Unified-form pages (Public + Course) share one validation path.
    if (!useUnifiedForm && form.kind === "enrolled" && courseIds.length === 0 && !form.chapterId) {
      setNotice({ kind: "error", text: "Assign at least one course to an enrolled exam." });
      return;
    }
    // Title required in all modes.
    if (!form.title.trim()) {
      setNotice({ kind: "error", text: "Exam Title is required." });
      return;
    }
    // Flow 5: topic-wise course exams must belong to exactly one subject
    // so the Topic-wise → Subject → Exams branch never mixes subjects.
    const effectiveFormat = fixedFormat ?? (form as unknown as { examFormat?: string }).examFormat;
    const effectiveTopicSubject = fixedTopicSubject ?? (form as unknown as { topicSubject?: string }).topicSubject;
    if (!fixedCategory && effectiveKind === "enrolled" && effectiveFormat === "topic-wise" && !effectiveTopicSubject?.trim()) {
      setNotice({ kind: "error", text: "Select a subject for this Topic-wise exam." });
      return;
    }
    // Keep the exam's category stable: fixed inside a category page.
    // In flat lists a public exam MUST have a Course Control category —
    // otherwise it would be invisible in Public Exam Control forever.
    const existing = exams?.find((item) => item.id === editingId);
    const categoryId = fixedCategory
      ? fixedCategory.id
      : form.kind === "public"
        ? formCategoryId || existing?.categoryId || ""
        : existing?.categoryId ?? "";
    if (!fixedCategory && !isCourseScope && form.kind === "public" && !categoryId) {
      setNotice({ kind: "error", text: "Select a category for this public exam." });
      return;
    }
    // Unified-form validation — same complete system for Public + Course.
    if (useUnifiedForm) {
      if (!form.subject.trim()) {
        setNotice({ kind: "error", text: "Subject is required." });
        return;
      }
      const qc = Number((form as unknown as Record<string, unknown>).questionCount);
      if (!Number.isInteger(qc) || qc <= 0 || qc > 500) {
        setNotice({ kind: "error", text: "Total Questions must be between 1 and 500." });
        return;
      }
      const mpq = Number((form as unknown as Record<string, unknown>).marksPerQuestion);
      if (!Number.isFinite(mpq) || mpq <= 0) {
        setNotice({ kind: "error", text: "Marks Per Question must be a positive number." });
        return;
      }
      if (mpq > 100) {
        setNotice({ kind: "error", text: "Marks Per Question looks too large (max 100)." });
        return;
      }
      if (form.title.trim().length < 3 || form.title.trim().length > 200) {
        setNotice({ kind: "error", text: "Exam title must be 3–200 characters." });
        return;
      }
      const dur = Number(form.durationMinutes);
      if (!Number.isFinite(dur) || dur < 1 || dur > 600) {
        setNotice({ kind: "error", text: "Duration must be 1–600 minutes." });
        return;
      }
      if (form.scheduledAt && form.endsAt && new Date(form.scheduledAt).getTime() >= new Date(form.endsAt).getTime()) {
        setNotice({ kind: "error", text: "End time must be after the start time." });
        return;
      }
      if (form.bannerUrl && !isValidHttpUrl(form.bannerUrl)) {
        setNotice({ kind: "error", text: `Banner URL: ${URL_MESSAGE}` });
        return;
      }
    }
    const chapterId = fixedChapter ? fixedChapter.id : form.chapterId;
    // Auto-generate ID for unified-form pages when missing.
    let examId = form.id.trim().toLowerCase();
    if (useUnifiedForm && !examId) {
      examId = generateExamId(form.title);
    }
    if (!examId) {
      setNotice({ kind: "error", text: "Exam ID is required." });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      // Unified payload — same complete Public Exam system for both scopes.
      // Only scope + linkage differ: PUBLIC → category lock, COURSE → course lock.
      let payload: Record<string, unknown>;
      if (useUnifiedForm) {
        const qc = Math.floor(Number((form as unknown as Record<string, unknown>).questionCount) || 0);
        const mpqNum = Number((form as unknown as Record<string, unknown>).marksPerQuestion) || 1;
        const total = qc * mpqNum;
        const tpl = (form as unknown as Record<string, unknown>).ruleTemplate as string;
        const isPublicScope = Boolean(fixedCategory);
        payload = {
          id: examId,
          title: form.title.trim(),
          scope: isPublicScope ? "PUBLIC" : "COURSE",
          kind: isPublicScope ? "public" : "enrolled",
          examMode: (form as unknown as { examMode?: string }).examMode || "live",
          batchId: form.batchId,
          subject: form.subject.trim(),
          courseType: form.courseType,
          durationMinutes: Number(form.durationMinutes) || 30,
          status: form.status,
          scheduledAt: form.scheduledAt ? new Date(form.scheduledAt).toISOString() : null,
          endsAt: form.endsAt ? new Date(form.endsAt).toISOString() : null,
          bannerUrl: form.bannerUrl || null,
          chapterId,
          categoryId: isPublicScope ? categoryId : (existing?.categoryId ?? null),
          courseIds: isPublicScope ? [] : fixedCourse ? [fixedCourse.slug] : (existing?.courseIds ?? courseIds),
          ruleTemplate: tpl || (isPublicScope ? detectTemplateForCategory(fixedCategory!) : "academic"),
          questionCount: qc,
          marksPerQuestion: mpqNum,
          totalMarks: total,
          // Course-exam Flow-5 locks ride along so branches never mix; new
          // chapter/legacy course exams keep NULL (legacy flow) via existing.
          ...(isPublicScope
            ? {}
            : {
                examFormat: fixedFormat ?? existing?.examFormat ?? null,
                topicSubject: (fixedFormat === "topic-wise" || (existing?.examFormat ?? null) === "topic-wise")
                  ? (fixedTopicSubject ?? existing?.topicSubject ?? null)
                  : null,
              }),
          // Second Timer Penalty — editable, default 3 when enabled (student chooses First/Second on Rules page)
          secondTimerEnabled: form.secondTimerEnabled,
          secondTimerDeduction: Number(form.secondTimerDeduction) || 3,
          negativeMarks: 0,
          ...(editingSortOrder !== null ? { sortOrder: editingSortOrder } : {}),
        };
      } else {
        payload = {
          ...form,
          kind: effectiveKind,
          id: examId,
          ...(editingSortOrder !== null ? { sortOrder: editingSortOrder } : {}),
          chapterId,
          courseIds: effectiveKind === "enrolled" ? effectiveCourseIds : [],
          categoryId,
          bannerUrl: form.bannerUrl,
          negativeEnabled: form.negativeEnabled,
          negativePerWrong: Number(form.negativePerWrong) || 0.25,
          secondTimerEnabled: form.secondTimerEnabled,
          secondTimerDeduction: Number(form.secondTimerDeduction) || 3,
          negativeMarks: form.negativeEnabled ? Number(form.negativePerWrong) || 0.25 : 0,
          durationMinutes: Number(form.durationMinutes) || 30,
          totalMarks: form.totalMarks ? Number(form.totalMarks) : undefined,
          scheduledAt: form.scheduledAt ? new Date(form.scheduledAt).toISOString() : null,
          endsAt: form.endsAt ? new Date(form.endsAt).toISOString() : null,
        };
      }
      const response = await fetch("/api/admin/exams", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...gate.headers },
        body: JSON.stringify(payload),
      });
      const data = (await response.json().catch(() => null)) as { error?: string; exam?: Exam } | null;
      if (!response.ok) {
        setNotice({ kind: "error", text: data?.error ?? "Failed to save." });
        return;
      }
      const wasNew = !editingId;
      setShowForm(false);
      await load();
      setNotice({ kind: "success", text: `Exam “${data?.exam?.title ?? form.title}” saved.` });
      // After creating an exam, auto-create Q01..QNN slots already handled server-side via ensureQuestionSlots.
      // Open the Questions tab directly so admin sees all generated slots without clicking Add 30 times.
      if (wasNew && data?.exam?.id) {
        router.push(`/admin/exams/${encodeURIComponent(data.exam.id)}/manage?tab=questions`);
      }
    } finally {
      setBusy(false);
    }
  }

  async function toggleStatus(exam: Exam) {
    const next =
      exam.status === "published" ? "draft" : "published";
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/admin/exams", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...gate.headers },
        body: JSON.stringify({ id: exam.id, status: next }),
      });
      const data = (await response.json().catch(() => null)) as
        | { error?: string; exams?: Exam[] }
        | null;
      if (!response.ok) {
        setNotice({ kind: "error", text: data?.error ?? "Failed to update." });
        return;
      }
      if (data?.exams) setExams(data.exams);
      setNotice({
        kind: "success",
        text:
          next === "published"
            ? `“${exam.title}” published — visible to students.`
            : `“${exam.title}” unpublished.`,
      });
    } finally {
      setBusy(false);
    }
  }

  // Featured ON/OFF — the homepage slider picks up published featured
  // public exams automatically from the same exam data (single source of
  // truth). Saves through the normal exam upsert with the full payload.
  async function toggleFeatured(exam: Exam) {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/admin/exams", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...gate.headers },
        body: JSON.stringify({ ...exam, featured: !exam.featured }),
      });
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        setNotice({ kind: "error", text: data?.error ?? "Failed to update." });
        return;
      }
      await load();
      setNotice({
        kind: "success",
        text: !exam.featured
          ? `“${exam.title}” marked Featured — it will appear in the homepage slider once published.`
          : `“${exam.title}” removed from the homepage slider.`,
      });
    } finally {
      setBusy(false);
    }
  }

  async function duplicate(id: string) {
    if (!window.confirm("Duplicate this exam with its questions and rules?")) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/admin/exams/duplicate", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...gate.headers },
        // One operation key per confirmed click so a replayed request cannot create a second copy.
        body: JSON.stringify({ id, requestId: crypto.randomUUID() }),
      });
      const data = (await response.json().catch(() => null)) as { error?: string; exam?: Exam } | null;
      if (!response.ok) {
        setNotice({ kind: "error", text: data?.error ?? "Failed to duplicate." });
        return;
      }
      await load();
      setNotice({ kind: "success", text: `“${data?.exam?.title ?? id}” duplicated.` });
    } finally {
      setBusy(false);
    }
  }

  async function toggleArchive(exam: Exam) {
    const isArchived = exam.status === "closed";
    if (!window.confirm(isArchived ? `Unarchive “${exam.title}”?` : `Archive “${exam.title}”? Archived exams become closed and hidden from students.`)) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/admin/exams/archive", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...gate.headers },
        body: JSON.stringify({ id: exam.id, archived: !isArchived }),
      });
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        setNotice({ kind: "error", text: data?.error ?? "Failed to update." });
        return;
      }
      await load();
      setNotice({ kind: "success", text: isArchived ? `“${exam.title}” unarchived.` : `“${exam.title}” archived.` });
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string, name: string) {
    if (!window.confirm(`Delete Exam?\n\nThis exam and its associated questions will be permanently removed. This action cannot be undone.\n\nDelete “${name}”?`)) return;
    setBusy(true);
    try {
      const response = await fetch("/api/admin/exams", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", ...gate.headers },
        body: JSON.stringify({ id }),
      });
      if (!response.ok) {
        setNotice({ kind: "error", text: "Failed to delete." });
        return;
      }
      await load();
      setNotice({ kind: "success", text: `“${name}” deleted.` });
    } finally {
      setBusy(false);
    }
  }

  async function move(visibleIndex: number, direction: -1 | 1) {
    if (!exams || busy) return;
    // Reorder the VISIBLE (filtered) list — not the raw `exams` array.
    // The old code swapped by raw index, so with Live/Practice or phase
    // filters active it swapped with a hidden exam and the UI looked dead.
    const visible = filteredByMode ?? exams;
    const target = visibleIndex + direction;
    if (target < 0 || target >= visible.length) return;
    const nextVisible = [...visible];
    [nextVisible[visibleIndex], nextVisible[target]] = [nextVisible[target]!, nextVisible[visibleIndex]!];
    // Merge back into the full list: hidden exams stay in place, visible
    // exams permute among the visible slots. Persist the full order so the
    // global sort_order stays consistent.
    const visibleIds = new Set(visible.map((item) => item.id));
    const queue = [...nextVisible];
    const nextExams = exams.map((item) =>
      visibleIds.has(item.id) ? queue.shift()! : item,
    );
    const prev = exams;
    setExams(nextExams);
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/admin/exams", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...gate.headers },
        body: JSON.stringify({ order: nextExams.map((item) => item.id) }),
      });
      if (!response.ok) {
        setExams(prev);
        setNotice({ kind: "error", text: "Failed to reorder." });
        return;
      }
      await load();
      setNotice({ kind: "success", text: "Exam order updated." });
    } catch {
      setExams(prev);
      setNotice({ kind: "error", text: "Failed to reorder." });
    } finally {
      setBusy(false);
    }
  }

  // ALL enrolled (private/course) exams use LIVE→PRACTICE temporal lifecycle.
  // Public exams use static examMode. When showing enrolled exams, filter
  // by derived phase (Upcoming/Live/Practice) instead of static Live/Practice.
  const hasEnrolledExams = Array.isArray(kindFilter)
    ? kindFilter.includes("enrolled")
    : kindFilter === "enrolled";
  // Static Live vs Practice — legacy `kind = "practice"` rows count as
  // practice even when their exam_mode column kept the "live" default.
  const examIsPractice = (exam: Exam) =>
    exam.examMode === "practice" || exam.kind === "practice";
  // Parent-controlled (segmented filter + subject navigation) or internal.
  const effectiveMode: "all" | "live" | "practice" =
    controlledMode ?? modeFilter;
  const filteredByMode = (() => {
    if (!exams) return null;
    // Course Content Control exam-flow lock — one Flow-5 category (and
    // optionally one topic-wise subject) so branches never mix.
    const scoped = fixedFormat || fixedTopicSubject
      ? exams.filter((e) => {
          const fmt = (e.examFormat ?? "") as string;
          if (fixedFormat && fmt !== fixedFormat) return false;
          if (fixedTopicSubject && (e.topicSubject ?? "") !== fixedTopicSubject) return false;
          return true;
        })
      : exams;
    if (hasEnrolledExams) {
      return scoped.filter((e) => {
        if (phaseFilter === "all") return true;
        const ph = flow4Phase(e);
        if (phaseFilter === "practice") return ph === "practice" || ph === "archived";
        return ph === phaseFilter;
      });
    }
    const byMode = scoped.filter((e) =>
      effectiveMode === "all"
        ? true
        : effectiveMode === "practice"
          ? examIsPractice(e)
          : !examIsPractice(e),
    );
    // Practice subject layer (Public Exam Control structure) — only narrows
    // the Practice tab; Live and management controls are untouched.
    if (
      effectiveMode === "practice" &&
      controlledSubjectKey &&
      publicCategoryKey
    ) {
      return byMode.filter((e) => {
        if (publicCategoryKey === "medical-admission") {
          const matched = matchMedicalPracticeSubject(e.subject);
          return controlledSubjectKey === OTHER_PRACTICE_SUBJECT_KEY
            ? !matched
            : matched === controlledSubjectKey;
        }
        return e.subject === controlledSubjectKey;
      });
    }
    return byMode;
  })();

  const filteredCount = filteredByMode?.length ?? 0;

  return (
    <section className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-10">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-extrabold tracking-tight text-[#0b1e3a] admin-dark:text-white">{title}</h2>
          <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-slate-500 admin-dark:text-slate-400">{description}</p>
        </div>
        <button type="button" onClick={startCreate} className={buttonPrimaryClass}>+ New Exam</button>
      </header>

      {/* Public Exam Control: Live Exam | Practice Exam segmented filter
          (default: Live). Hidden when the parent drives the structure. */}
      {fixedCategory && !hideModeTabs && exams !== null && !loadError && (
        <div className="mt-5 flex gap-2 overflow-x-auto pb-1 scrollbar-thin">
          {(["live", "practice"] as const).map((m) => {
            const label = m === "live" ? "Live Exam" : "Practice Exam";
            const active = effectiveMode === m;
            return (
              <button
                key={m}
                type="button"
                onClick={() => setModeFilter(m)}
                className={`shrink-0 rounded-full px-4 py-2 text-xs font-extrabold uppercase tracking-wide transition ${
                  active
                    ? "bg-[#0b1e3a] text-white shadow admin-dark:bg-white admin-dark:text-[#0b1e3a]"
                    : "bg-white text-slate-600 ring-1 ring-[#dbeafe] hover:bg-[#f1f5f9] admin-dark:bg-[#112544] admin-dark:text-slate-300 admin-dark:ring-[#1e3a65]"
                }`}
              >
                {label}
              </button>
            );
          })}
          <span className="ml-2 self-center whitespace-nowrap text-xs font-semibold text-slate-400">
            {filteredByMode ? `${filteredByMode.length} exam${filteredByMode.length === 1 ? "" : "s"}` : ""}
          </span>
        </div>
      )}

      {/* Enrolled exams: show Upcoming / Live / Closed / Archived phase tabs */}
      {hasEnrolledExams && exams !== null && !loadError && (
        <div className="mt-5 flex gap-2 overflow-x-auto pb-1 scrollbar-thin">
          {(["all", "upcoming", "live", "closed", "archived"] as const).map((ph) => {
            const label = ph === "all" ? "All Exams" : ph === "upcoming" ? "Upcoming" : ph === "live" ? "Live" : ph === "closed" ? "Closed" : "Archived";
            const active = phaseFilter === ph;
            return (
              <button
                key={ph}
                type="button"
                onClick={() => setPhaseFilter(ph)}
                className={`shrink-0 rounded-full px-4 py-2 text-xs font-extrabold uppercase tracking-wide transition ${
                  active
                    ? "bg-[#0b1e3a] text-white shadow admin-dark:bg-white admin-dark:text-[#0b1e3a]"
                    : "bg-white text-slate-600 ring-1 ring-[#dbeafe] hover:bg-[#f1f5f9] admin-dark:bg-[#112544] admin-dark:text-slate-300 admin-dark:ring-[#1e3a65]"
                }`}
              >
                {label}
              </button>
            );
          })}
          <span className="ml-2 self-center whitespace-nowrap text-xs font-semibold text-slate-400">
            {filteredByMode ? `${filteredByMode.length} exam${filteredByMode.length === 1 ? "" : "s"}` : ""}
          </span>
        </div>
      )}

      {loadError ? (
        <div className={`${cardClass} mt-5 p-8 text-center`}>
          <p className="text-sm font-semibold text-slate-700 admin-dark:text-zinc-200">
            Could not load exams.
          </p>
          <button
            type="button"
            onClick={() => void load()}
            className={`${buttonPrimaryClass} mt-4`}
          >
            Try Again
          </button>
        </div>
      ) : exams === null ? (
        <AdminCenterLoader label="Loading exams…" />
      ) : (filteredByMode?.length ?? 0) === 0 ? (
        <p className={`${cardClass} mt-5 p-8 text-center text-sm text-slate-500`}>
          {exams.length === 0 ? "No exams yet." : (fixedFormat || fixedTopicSubject) ? "No exams in this category yet — create the first one with + New Exam." : hasEnrolledExams ? `No ${phaseFilter === "upcoming" ? "Upcoming" : phaseFilter === "live" ? "Live" : phaseFilter === "closed" ? "Closed" : phaseFilter === "archived" ? "Archived" : "exams"} found.` : `No ${effectiveMode === "live" ? "Live Exams" : effectiveMode === "practice" ? "Practice Exams" : "exams"} found.`}
        </p>
      ) : (
        <ul className="mt-5 space-y-3">
          {filteredByMode!.slice(0, EXAM_LIST_LIMIT).map((exam, fIdx) => {
            const phase = hasEnrolledExams ? flow4Phase(exam) : null;
            const phaseBadge = phase ? flow4PhaseBadge(phase) : null;
            const publicExam = examToPublic(exam);
            const adminControls = (
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-ink/10 pt-3">
                <button type="button" onClick={() => setQuestionsExam(exam)} className={`${buttonPrimaryClass} min-w-[88px] shrink-0 px-4 py-2 text-xs`} title="Open Question Management">Questions</button>
                <button type="button" onClick={() => setSyncExam(exam)} className={`${buttonSecondaryClass} min-w-[88px] shrink-0 px-4 py-2 text-xs`} title="Bilingual Set A/B auto-sync (Bangla master)">Sets BN/EN</button>
                <button type="button" onClick={() => startEdit(exam)} className={`${buttonSecondaryClass} min-w-[80px] shrink-0 px-4 py-2 text-xs`} title="Edit exam information">Manage</button>
                <button type="button" disabled={busy} onClick={() => void toggleFeatured(exam)} className={`${exam.featured ? buttonPrimaryClass : buttonSecondaryClass} min-w-[88px] shrink-0 px-4 py-2 text-xs`} title={exam.featured ? "Featured — click to unfeature" : "Not featured — click to feature"}>{exam.featured ? "Featured" : "Feature"}</button>
                <button type="button" disabled={busy} onClick={() => void toggleStatus(exam)} className={`${buttonSecondaryClass} min-w-[96px] shrink-0 px-4 py-2 text-xs`} title={exam.status === "published" ? "Unpublish exam" : "Publish exam"}>{exam.status === "published" ? "Unpublished" : "Publish"}</button>
                <button type="button" onClick={() => void remove(exam.id, exam.title)} disabled={busy} aria-label={`Delete ${exam.title}`} className="min-w-[80px] shrink-0 rounded-xl border border-red-200 bg-[#fef2f2] px-4 py-2 text-xs font-bold text-red-600 transition hover:border-red-300 hover:bg-red-50 hover:text-red-700 active:bg-red-100 disabled:opacity-50 admin-dark:border-red-900/30 admin-dark:bg-red-500/10 admin-dark:text-red-400 admin-dark:hover:border-red-800/50 admin-dark:hover:bg-red-500/20" title="Delete exam permanently">Delete</button>
                <span className="flex shrink-0 gap-1" role="group" aria-label={`Reorder ${exam.title}`}>
                  <button
                    type="button"
                    disabled={busy || fIdx === 0}
                    onClick={() => void move(fIdx, -1)}
                    title="Move Up"
                    aria-label={`Move ${exam.title} up`}
                    className="rounded-xl border border-ink/15 bg-white px-3 py-2 text-xs font-black text-[#0b1e3a] transition hover:border-[#93c5fd] disabled:cursor-not-allowed disabled:opacity-30 admin-dark:border-[#1e3a65] admin-dark:bg-[#112544] admin-dark:text-white"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    disabled={busy || fIdx === Math.min(filteredByMode!.length, EXAM_LIST_LIMIT) - 1}
                    onClick={() => void move(fIdx, 1)}
                    title="Move Down"
                    aria-label={`Move ${exam.title} down`}
                    className="rounded-xl border border-ink/15 bg-white px-3 py-2 text-xs font-black text-[#0b1e3a] transition hover:border-[#93c5fd] disabled:cursor-not-allowed disabled:opacity-30 admin-dark:border-[#1e3a65] admin-dark:bg-[#112544] admin-dark:text-white"
                  >
                    ↓
                  </button>
                </span>
              </div>
            );
            return (
              <li key={exam.id} className={`${cardClass} p-4 sm:p-5`}>
                {/* Admin header row — exam name + admin badges */}
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="min-w-0 flex-1 truncate text-base font-bold leading-tight text-[#0b1e3a] admin-dark:text-zinc-100">{exam.title}</h3>
                  {phaseBadge && (
                    <span className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wide ring-1 ${phaseBadge.className}`}>
                      {phaseBadge.label}
                    </span>
                  )}
                  <span className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wide ${exam.status === "published" ? "bg-emerald-500/10 text-emerald-700 ring-1 ring-emerald-500/20 admin-dark:bg-emerald-500/10 admin-dark:text-emerald-400" : exam.status === "closed" ? "bg-red-500/10 text-red-600 ring-1 ring-red-500/20" : "bg-zinc-500/10 text-slate-600 ring-1 ring-zinc-500/20 admin-dark:bg-zinc-500/10 admin-dark:text-slate-400"}`}>{exam.status === "published" ? "Published" : exam.status === "draft" ? "Draft" : exam.status}</span>
                  <span className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wide ring-1 ${(exam.examMode ?? "live") === "live" ? "bg-sky-500/10 text-sky-700 ring-sky-500/20 admin-dark:bg-sky-500/10 admin-dark:text-sky-400" : "bg-violet-500/10 text-violet-700 ring-violet-500/20 admin-dark:bg-violet-500/10 admin-dark:text-violet-400"}`}>{(exam.examMode ?? "live") === "live" ? "Live Exam" : "Practice Exam"}</span>
                  {exam.featured && <span title="Featured in the homepage slider" className="shrink-0 rounded-full bg-amber-500/10 px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wide text-amber-700 ring-1 ring-amber-500/20">★ Featured</span>}
                  {exam.examFormat && <span title={exam.examFormat === "topic-wise" && exam.topicSubject ? `Topic-wise · ${exam.topicSubject}` : "Course Flow 4 exam category"} className="shrink-0 rounded-full bg-indigo-500/10 px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wide text-indigo-700 ring-1 ring-indigo-500/20 admin-dark:bg-indigo-500/10 admin-dark:text-indigo-300">{exam.examFormat === "topic-wise" ? "Topic-wise" : exam.examFormat === "paper-final" ? "Paper Final" : exam.examFormat === "subject-final" ? "Subject Final" : "Final Model"}</span>}
                </div>
                {/* Unified Exam Card body */}
                <div className="mt-3">
                  <ExamCard exam={publicExam} manage={adminControls} />
                </div>
              </li>
            );
          })}
          </ul>
      )}
      {filteredByMode && filteredByMode.length > EXAM_LIST_LIMIT && (
        <p className="mt-3 text-center text-xs font-semibold text-slate-500">
          Showing first {EXAM_LIST_LIMIT} of {filteredByMode.length} — refine search to narrow results.
        </p>
      )}

      {/* Public Exam Category: bottom [+ Add Exam] removed — only top + New Exam remains (spec). Keep bottom button for Course Content Control chapter exams only. */}
      {fixedChapter && !fixedCategory && (
        <div className="mt-5">
          <button type="button" onClick={startCreate} className={`${buttonPrimaryClass} w-full py-3`}>
            + Add Exam
          </button>
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6" role="dialog" aria-modal="true">
          <div className={`${cardClass} max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-b-none p-5 sm:rounded-2xl sm:p-6`}>
            <h3 className="text-lg font-extrabold text-[#0b1e3a] admin-dark:text-zinc-100">
              {editingId ? "Edit Exam" : "New Exam"}
            </h3>
            <form
              className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              {useUnifiedForm ? (
                <>
                  {/* Unified Exam form — SAME complete Public Exam system for both
                      scopes. PUBLIC (fixedCategory) locks the category; COURSE
                      (fixedCourse / fixedChapter) locks the course/chapter and
                      stays enrolled-only. All other fields are identical. */}
                  <div className="sm:col-span-2">
                    <label className={labelClass} htmlFor="ex-title">Exam Title</label>
                    <input id="ex-title" className={inputClass} value={form.title} placeholder="e.g. Medical Admission Model Test 01"
                      onChange={(event) => setForm({ ...form, title: event.target.value })} />
                    {fixedCategory ? (
                      <p className="mt-1 text-[11px] text-slate-500 admin-dark:text-slate-400">Category: <span className="font-bold">{examCategoryLabel(fixedCategory)}</span> (fixed — auto-assigned)</p>
                    ) : fixedCourse ? (
                      <p className="mt-1 text-[11px] text-slate-500 admin-dark:text-slate-400">Course: <span className="font-bold">{fixedCourse.name}</span> (fixed — enrolled students only)</p>
                    ) : fixedChapter ? (
                      <p className="mt-1 text-[11px] text-slate-500 admin-dark:text-slate-400">Chapter: <span className="font-bold">{fixedChapter.name}</span> (fixed — enrolled students only)</p>
                    ) : null}
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="ex-id">Exam ID — auto-generated</label>
                    <input id="ex-id" className={`${inputClass} bg-slate-50`} value={form.id} disabled placeholder="auto-generated" />
                    <p className="mt-1 text-[11px] text-slate-500 admin-dark:text-slate-400">{editingId ? "Existing ID (not editable)." : "Auto-generated ID will be used to create question slots Q01..QNN."}</p>
                  </div>
                  <div className="sm:col-span-2">
                    <MediaUploadField
                      id="ex-banner"
                      label="Exam Banner — upload"
                      directory="exams"
                      accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
                      preview
                      value={form.bannerUrl}
                      onChange={(url) => setForm({ ...form, bannerUrl: url })}
                    />
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="ex-status">Status</label>
                    <select id="ex-status" className={inputClass} value={form.status}
                      onChange={(event) => setForm({ ...form, status: event.target.value as "draft" | "published" | "closed" })}>
                      <option value="draft">Draft</option>
                      <option value="published">Published</option>
                      <option value="closed">Closed</option>
                    </select>
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="ex-batch">Batch</label>
                    <select id="ex-batch" className={inputClass} value={form.batchId}
                      onChange={(event) => setForm({ ...form, batchId: event.target.value })}>
                      <option value="">Any</option>
                      <option value="hsc-28">HSC 28</option>
                      <option value="hsc-27">HSC 27</option>
                      <option value="hsc-26">HSC 26</option>
                      <option value="ssc-28">SSC 28</option>
                      <option value="ssc-27">SSC 27</option>
                      <option value="ssc-26">SSC 26</option>
                    </select>
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="ex-subject">Subject</label>
                    <input id="ex-subject" className={inputClass} value={form.subject} placeholder="e.g. Biology"
                      onChange={(event) => setForm({ ...form, subject: event.target.value })} />
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="ex-course-type">Course Type</label>
                    <select id="ex-course-type" className={inputClass} value={form.courseType}
                      onChange={(event) => setForm({ ...form, courseType: event.target.value as "Academic" | "Admission" })}>
                      <option value="Academic">Academic</option>
                      <option value="Admission">Admission</option>
                    </select>
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="ex-mode">Exam Mode</label>
                    <select id="ex-mode" className={inputClass} value={(form as unknown as { examMode: string }).examMode ?? "live"}
                      onChange={(event) => setForm({ ...form, examMode: event.target.value } as unknown as typeof form)}>
                      <option value="live">Live Exam</option>
                      <option value="practice">Practice Exam</option>
                    </select>
                    <p className="mt-1 text-[11px] text-slate-500">Separate from Published/Draft and schedule.</p>
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="ex-chapter">Chapter</label>
                    {fixedChapter ? (
                      <>
                        <input id="ex-chapter" className={inputClass} value={fixedChapter.name} disabled />
                        <p className="mt-1 text-[11px] text-slate-500">Fixed to this chapter — auto-assigned.</p>
                      </>
                    ) : (
                      <select id="ex-chapter" className={inputClass} value={form.chapterId}
                        onChange={(event) => setForm({ ...form, chapterId: event.target.value })}>
                        <option value="">None</option>
                        {chapterOptions.map((chapter) => (
                          <option key={chapter.id} value={chapter.id}>{chapter.name}</option>
                        ))}
                      </select>
                    )}
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="ex-duration">Duration (minutes)</label>
                    <input id="ex-duration" type="number" min="1" max="600" className={inputClass} value={form.durationMinutes} placeholder="e.g. 30"
                      onChange={(event) => setForm({ ...form, durationMinutes: event.target.value })} />
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="ex-rules">Rules</label>
                    <select id="ex-rules" className={inputClass} value={(form as unknown as { ruleTemplate: string }).ruleTemplate}
                      onChange={(event) => {
                        const v = event.target.value;
                        const isSecond = v === "medical";
                        setForm({
                          ...form,
                          ruleTemplate: v,
                          secondTimerEnabled: isSecond,
                          secondTimerDeduction: isSecond ? (form.secondTimerDeduction && Number(form.secondTimerDeduction) > 0 ? form.secondTimerDeduction : "3") : "0",
                        } as unknown as typeof form);
                      }}>
                      <option value="academic">Academic Rules</option>
                      <option value="medical">Medical Rules</option>
                      <option value="university">University Rules</option>
                    </select>
                    <p className="mt-1 text-[11px] text-slate-500">
                      {(form as unknown as { ruleTemplate: string }).ruleTemplate === "medical" && "Medical: negative marking + second-timer penalty."}
                      {(form as unknown as { ruleTemplate: string }).ruleTemplate === "university" && "University: negative marking, no second-timer."}
                      {(form as unknown as { ruleTemplate: string }).ruleTemplate === "academic" && "Academic: no negative marking, no second-timer."}
                      {" "}Edit texts in <a href="/admin/exam-rules" className="font-bold text-primary-600 underline">Exam Rules</a>.
                    </p>
                  </div>
                  <div className="sm:col-span-2 rounded-xl border border-neutral-200 p-3 admin-dark:border-zinc-700">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs font-extrabold uppercase tracking-wide text-slate-700 admin-dark:text-zinc-200">
                        Second Timer Penalty
                      </span>
                      <label className="flex cursor-pointer items-center gap-2 text-xs font-bold text-zinc-600 admin-dark:text-zinc-300">
                        <input
                          type="checkbox"
                          checked={form.secondTimerEnabled}
                          onChange={(event) => setForm({ ...form, secondTimerEnabled: event.target.checked })}
                        />
                        {form.secondTimerEnabled ? "ON" : "OFF"}
                      </label>
                    </div>
                    <div className="mt-2 flex items-center gap-3">
                      <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
                        Penalty Marks
                      </span>
                      <input
                        aria-label="Second timer penalty marks"
                        type="number"
                        min="0"
                        step="0.5"
                        disabled={!form.secondTimerEnabled}
                        className={`${inputClass} w-28 disabled:opacity-50`}
                        value={form.secondTimerDeduction}
                        onChange={(event) => setForm({ ...form, secondTimerDeduction: event.target.value })}
                        placeholder="3"
                      />
                      <span className="text-[11px] text-slate-500">marks (suggested 3) — deducted if Second Timer selected</span>
                    </div>
                    <p className="mt-1 text-[11px] text-slate-500">
                      When enabled, student chooses First Timer (no penalty) or Second Timer (−{form.secondTimerDeduction || 3} marks) on Rules page.
                    </p>
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="ex-qcount">Total Questions</label>
                    <input id="ex-qcount" type="number" min="1" max="500" className={inputClass} value={(form as unknown as { questionCount: string }).questionCount} placeholder="e.g. 30"
                      onChange={(event) => setForm({ ...form, questionCount: event.target.value } as unknown as typeof form)} />
                    <p className="mt-1 text-[11px] text-slate-500">Q01..Q{String((form as unknown as { questionCount: string }).questionCount || "0").padStart(2, "0")} slots will be auto-created.</p>
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="ex-mpq">Marks Per Question</label>
                    <input id="ex-mpq" type="number" min="0.5" max="100" step="0.5" className={inputClass} value={(form as unknown as { marksPerQuestion: string }).marksPerQuestion} placeholder="e.g. 1"
                      onChange={(event) => setForm({ ...form, marksPerQuestion: event.target.value } as unknown as typeof form)} />
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="ex-total">Total Marks — auto calculated</label>
                    <input id="ex-total" className={`${inputClass} bg-slate-50`} value={String((Number((form as unknown as { questionCount: string }).questionCount) || 0) * (Number((form as unknown as { marksPerQuestion: string }).marksPerQuestion) || 0))} disabled />
                    <p className="mt-1 text-[11px] text-slate-500">{(form as unknown as { questionCount: string }).questionCount || 0} × {(form as unknown as { marksPerQuestion: string }).marksPerQuestion || 0} = {String((Number((form as unknown as { questionCount: string }).questionCount) || 0) * (Number((form as unknown as { marksPerQuestion: string }).marksPerQuestion) || 0))} marks</p>
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="ex-schedule">Start Time</label>
                    <input id="ex-schedule" type="datetime-local" className={inputClass} value={form.scheduledAt}
                      onChange={(event) => setForm({ ...form, scheduledAt: event.target.value })} />
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="ex-ends">End Time</label>
                    <input id="ex-ends" type="datetime-local" className={inputClass} value={form.endsAt}
                      onChange={(event) => setForm({ ...form, endsAt: event.target.value })} />
                  </div>
                  {/* Rules auto-drive marking — no manual toggles. EditingId still shows ExamRulesEditor for rule text. */}
                  {editingId && (
                    <div className="sm:col-span-2">
                      <ExamRulesEditor examId={editingId} authHeaders={gate.headers} />
                    </div>
                  )}
                </>
              ) : (
                <>
                  {/* Non-Public-Exam form — keep original fields for Course Content Control */}
                  <div>
                    <label className={labelClass} htmlFor="ex-id">ID (lowercase-dash)</label>
                    <input id="ex-id" className={inputClass} value={form.id} disabled={Boolean(editingId)}
                      onChange={(event) => setForm({ ...form, id: event.target.value.toLowerCase() })} />
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="ex-title">Title</label>
                    <input id="ex-title" className={inputClass} value={form.title}
                      onChange={(event) => setForm({ ...form, title: event.target.value })} />
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="ex-kind">Kind</label>
                    <select id="ex-kind" className={inputClass} value={form.kind}
                      onChange={(event) => setForm({ ...form, kind: event.target.value as Exam["kind"] })}>
                      <option value="public">Public</option>
                      <option value="practice">Practice</option>
                      {allowEnrolled && <option value="enrolled">Enrolled (course students)</option>}
                    </select>
                  </div>
                  {form.kind === "public" && (
                    <div>
                      <label className={labelClass} htmlFor="ex-category">Category (Course Control)</label>
                      <select
                        id="ex-category"
                        className={inputClass}
                        value={formCategoryId}
                        onChange={(event) => setFormCategoryId(event.target.value)}
                      >
                        <option value="">Select a category…</option>
                        {categoryOptions.map((category) => (
                          <option key={category.id} value={category.id}>
                            {examCategoryLabel(category)}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  {allowEnrolled && form.kind === "enrolled" && (
                    <div className="sm:col-span-2">
                      <span className={labelClass}>Assign courses (students enrolled in any of these)</span>
                      {courseOptions.length === 0 ? (
                        <p className="mt-1 text-xs text-slate-500">Loading courses…</p>
                      ) : (
                        <div className="mt-2 max-h-44 space-y-1.5 overflow-y-auto rounded-xl border border-neutral-200 p-3 admin-dark:border-zinc-700">
                          {courseOptions.map((course) => (
                            <label key={course.slug} className="flex items-center gap-2 text-sm text-slate-700 admin-dark:text-zinc-200">
                              <input
                                type="checkbox"
                                checked={courseIds.includes(course.slug)}
                                onChange={(event) =>
                                  setCourseIds(
                                    event.target.checked
                                      ? [...courseIds, course.slug]
                                      : courseIds.filter((id) => id !== course.slug),
                                  )
                                }
                              />
                              <span className="truncate">{course.name}</span>
                              <span className="ml-auto shrink-0 text-[10px] font-bold uppercase tracking-wide text-slate-500 admin-dark:text-slate-400">{course.slug}</span>
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {allowEnrolled && form.kind === "enrolled" && (
                    <>
                      <div>
                        <label className={labelClass} htmlFor="ex-format">Course Flow 4 exam category</label>
                        {fixedFormat ? (
                          <p className="mt-1 rounded-xl border border-ink/10 bg-ink/5 px-3.5 py-2.5 text-sm font-bold text-[#0b1e3a] admin-dark:text-white">
                            {fixedFormat === "topic-wise" ? "Topic-wise Exam" : fixedFormat === "paper-final" ? "Paper Final Exam" : fixedFormat === "subject-final" ? "Subject Final Exam" : "Final Model Test"}
                            <span className="ml-2 text-[11px] font-semibold text-slate-500 admin-dark:text-slate-400">(locked for this page)</span>
                          </p>
                        ) : (
                        <select
                          id="ex-format"
                          className={inputClass}
                          value={((form as unknown as { examFormat?: string }).examFormat ?? "") as "" | "topic-wise" | "paper-final" | "subject-final" | "final-model"}
                          onChange={(event) =>
                            setForm({
                              ...form,
                              examFormat: event.target.value as "" | "topic-wise" | "paper-final" | "subject-final" | "final-model",
                              topicSubject: event.target.value === "topic-wise" ? form.topicSubject : "",
                            })
                          }
                        >
                          <option value="">None (legacy Exam flow)</option>
                          <option value="topic-wise">Topic-wise Exam</option>
                          <option value="paper-final">Paper Final Exam</option>
                          <option value="subject-final">Subject Final Exam</option>
                          <option value="final-model">Final Model Test</option>
                        </select>
                        )}
                        <p className="mt-1 text-[11px] text-slate-500 admin-dark:text-slate-400">Only categorized exams appear in Course Flow 4 courses — one category per exam, never mixed.</p>
                      </div>
                      {(form as unknown as { examFormat?: string }).examFormat === "topic-wise" && (
                        <div>
                          <label className={labelClass} htmlFor="ex-topic-subject">Topic subject (1 of 8)</label>
                          {fixedTopicSubject ? (
                            <p className="mt-1 rounded-xl border border-ink/10 bg-ink/5 px-3.5 py-2.5 text-sm font-bold text-[#0b1e3a] admin-dark:text-white">
                              {form.topicSubject || fixedTopicSubject}
                              <span className="ml-2 text-[11px] font-semibold text-slate-500 admin-dark:text-slate-400">(locked for this page)</span>
                            </p>
                          ) : (
                          <select
                            id="ex-topic-subject"
                            className={inputClass}
                            value={form.topicSubject ?? ""}
                            onChange={(event) => setForm({ ...form, topicSubject: event.target.value })}
                          >
                            <option value="">Select a subject…</option>
                            <option value="bio1-botany">Biology 1st Paper — Botany</option>
                            <option value="bio2-zoology">Biology 2nd Paper — Zoology</option>
                            <option value="chem1">Chemistry 1st Paper</option>
                            <option value="chem2">Chemistry 2nd Paper</option>
                            <option value="phy1">Physics 1st Paper</option>
                            <option value="phy2">Physics 2nd Paper</option>
                            <option value="english">English</option>
                            <option value="gk">General Knowledge</option>
                          </select>
                          )}
                        </div>
                      )}
                    </>
                  )}
                  <div className="sm:col-span-2">
                    <MediaUploadField
                      id="ex-banner"
                      label="Exam Banner (shown on the student exam card & rules page)"
                      directory="exams"
                      accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
                      preview
                      value={form.bannerUrl}
                      onChange={(url) => setForm({ ...form, bannerUrl: url })}
                    />
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="ex-status">Status</label>
                    <select id="ex-status" className={inputClass} value={form.status}
                      onChange={(event) =>
                        setForm({ ...form, status: event.target.value as "draft" | "published" | "closed" })
                      }>
                      <option value="draft">Draft</option>
                      <option value="published">Published</option>
                      <option value="closed">Closed</option>
                    </select>
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="ex-batch">Batch</label>
                    <select id="ex-batch" className={inputClass} value={form.batchId}
                      onChange={(event) => setForm({ ...form, batchId: event.target.value })}>
                      <option value="">Any</option>
                      <option value="hsc-28">HSC 28</option>
                      <option value="hsc-27">HSC 27</option>
                      <option value="hsc-26">HSC 26</option>
                      <option value="ssc-28">SSC 28</option>
                      <option value="ssc-27">SSC 27</option>
                      <option value="ssc-26">SSC 26</option>
                    </select>
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="ex-subject">Subject</label>
                    <input id="ex-subject" className={inputClass} value={form.subject}
                      onChange={(event) => setForm({ ...form, subject: event.target.value })} />
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="ex-course-type">Course type</label>
                    <select id="ex-course-type" className={inputClass} value={form.courseType}
                      onChange={(event) =>
                        setForm({ ...form, courseType: event.target.value as "Academic" | "Admission" })
                      }>
                      <option value="Academic">Academic</option>
                      <option value="Admission">Admission</option>
                    </select>
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="ex-chapter">Chapter (course content)</label>
                    {fixedChapter ? (
                      <>
                        <input id="ex-chapter" className={inputClass} value={fixedChapter.name} disabled />
                        <p className="mt-1 text-[11px] text-slate-500">Fixed to this chapter — auto-assigned.</p>
                      </>
                    ) : (
                      <select id="ex-chapter" className={inputClass} value={form.chapterId}
                        onChange={(event) => setForm({ ...form, chapterId: event.target.value })}>
                        <option value="">None</option>
                        {chapterOptions.map((chapter) => (
                          <option key={chapter.id} value={chapter.id}>{chapter.name}</option>
                        ))}
                      </select>
                    )}
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="ex-duration">Duration (minutes)</label>
                    <input id="ex-duration" type="number" min="1" max="600" className={inputClass} value={form.durationMinutes} placeholder="e.g. 30"
                      onChange={(event) => setForm({ ...form, durationMinutes: event.target.value })} />
                  </div>
                  <div className="sm:col-span-2 rounded-xl border border-neutral-200 p-3 admin-dark:border-zinc-700">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs font-extrabold uppercase tracking-wide text-slate-700 admin-dark:text-zinc-200">
                        Negative Marking
                      </span>
                      <label className="flex cursor-pointer items-center gap-2 text-xs font-bold text-zinc-600 admin-dark:text-zinc-300">
                        <input
                          type="checkbox"
                          checked={form.negativeEnabled}
                          onChange={(event) => setForm({ ...form, negativeEnabled: event.target.checked })}
                        />
                        {form.negativeEnabled ? "ON" : "OFF"}
                      </label>
                    </div>
                    <p className="mt-1 text-[11px] text-slate-500">
                      Wrong Answer Penalty: <span className="font-bold">0.25</span> per wrong answer
                      {form.negativeEnabled ? "" : " (no deduction while OFF)"}.
                    </p>
                  </div>
                  <div className="sm:col-span-2 rounded-xl border border-neutral-200 p-3 admin-dark:border-zinc-700">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs font-extrabold uppercase tracking-wide text-slate-700 admin-dark:text-zinc-200">
                        Second Timer Penalty
                      </span>
                      <label className="flex cursor-pointer items-center gap-2 text-xs font-bold text-zinc-600 admin-dark:text-zinc-300">
                        <input
                          type="checkbox"
                          checked={form.secondTimerEnabled}
                          onChange={(event) => setForm({ ...form, secondTimerEnabled: event.target.checked })}
                        />
                        {form.secondTimerEnabled ? "ON" : "OFF"}
                      </label>
                    </div>
                    <div className="mt-2 flex items-center gap-3">
                      <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
                        Second Timer Deduction
                      </span>
                      <input
                        aria-label="Second timer deduction (marks)"
                        type="number"
                        min="0"
                        step="0.5"
                        disabled={!form.secondTimerEnabled}
                        className={`${inputClass} w-28 disabled:opacity-50`}
                        value={form.secondTimerDeduction}
                        onChange={(event) => setForm({ ...form, secondTimerDeduction: event.target.value })}
                      />
                      <span className="text-[11px] text-slate-500">marks (repeat attempt of THIS exam only)</span>
                    </div>
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="ex-marks">Total marks (auto from questions)</label>
                    <input id="ex-marks" type="number" min="0" className={inputClass} value={form.totalMarks}
                      placeholder="Auto" onChange={(event) => setForm({ ...form, totalMarks: event.target.value })} />
                  </div>
                  <div className="sm:col-span-2">
                    <label className={labelClass} htmlFor="ex-schedule">Start time (optional)</label>
                    <input id="ex-schedule" type="datetime-local" className={inputClass} value={form.scheduledAt}
                      onChange={(event) => setForm({ ...form, scheduledAt: event.target.value })} />
                  </div>
                  <div className="sm:col-span-2">
                    <label className={labelClass} htmlFor="ex-ends">End time (optional — exam closes after this)</label>
                    <input id="ex-ends" type="datetime-local" className={inputClass} value={form.endsAt}
                      onChange={(event) => setForm({ ...form, endsAt: event.target.value })} />
                  </div>
                  {editingId && (
                    <ExamRulesEditor examId={editingId} authHeaders={gate.headers} />
                  )}
                </>
              )}
              <div className="sm:col-span-2 flex gap-3">
                <button type="submit" disabled={busy} className={buttonPrimaryClass}>{busy ? "Saving…" : "Save Exam"}</button>
                <button type="button" onClick={() => setShowForm(false)} className={buttonSecondaryClass}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {questionsExam && (
        <ExamPaperEditor
          exam={{
            id: questionsExam.id,
            title: questionsExam.title,
            subject: questionsExam.subject,
            totalMarks: questionsExam.totalMarks,
            durationMinutes: questionsExam.durationMinutes,
            questionCount: questionsExam.questionCount,
            status: questionsExam.status,
            ruleTemplate: (questionsExam as unknown as { ruleTemplate?: string | null }).ruleTemplate ?? null,
            marksPerQuestion: (questionsExam as unknown as { marksPerQuestion?: number | null }).marksPerQuestion ?? null,
          }}
          authHeaders={gate.headers}
          onClose={() => setQuestionsExam(null)}
          onChanged={() => void load()}
        />
      )}

      {syncExam && (
        <ExamSetAutoSync
          exam={{ id: syncExam.id, title: syncExam.title }}
          authHeaders={gate.headers}
          onClose={() => setSyncExam(null)}
        />
      )}

      {notice && <p role="status" className={noticeClass(notice)}>{notice.text}</p>}
    </section>
  );
}
