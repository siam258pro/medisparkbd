"use client";

import { useEffect, useState, useMemo, useRef, useCallback, Fragment } from "react";
import { useAuth } from "@/lib/auth-context";
import { AccessLoading } from "@/components/auth/AccessGuard";
import { parsePastedMcqs } from "@/lib/paste-mcq-parser";
import type { PdfMaterialQuestion } from "@/lib/pdf-materials";
import {
  paginateQuestionsDebug,
  logPaginateDebug,
  type PaginatedPage,
  type PaginateDebugInfo,
  type LineSpacing,
  lineSpacingFactor,
} from "@/components/admin/MaterialPdf/pagination";
import CqPdfGenerator from "@/components/admin/MaterialPdf/CqPdfGenerator";
import ExamSourcePicker from "@/components/admin/MaterialPdf/ExamSourcePicker";
import { capturePageRect, fixHtml2CanvasTextBaseline, sanitizeClonedColorsForHtml2Canvas } from "@/components/admin/MaterialPdf/pdf-capture";
import { useAdminGate } from "@/components/admin/admin-ui";

/** Main generator selection — exactly TWO cards, never a third "setup" card. */
type GeneratorMode = "select" | "mcq" | "cq";

function uid() {
  return `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** A4 preview width in px (210mm @96dpi) — must match the .a4-page inline width. */
const A4_PREVIEW_W = 794;
/** A4 preview height in px (297mm @96dpi) — fallback until measured. */
const A4_PREVIEW_H = 1123;

function mapParserToQuestions(parsed: ReturnType<typeof parsePastedMcqs>, topic = ""): PdfMaterialQuestion[] {
  return parsed.map((p, idx) => {
    let ans = "";
    if (p.correctIndex !== null && p.correctIndex >= 0 && p.correctIndex < 4) {
      ans = String.fromCharCode(65 + p.correctIndex);
    }
    return {
      id: uid(),
      qNumber: idx + 1,
      question: p.question || "",
      options: [...p.options] as [string, string, string, string],
      answer: ans,
      needsReview: p.needsReview,
      issues: p.issues ?? [],
      image: null,
      isStandaloneImage: false,
      topic: topic || undefined,
    };
  });
}

import {
  splitPasteByTopic,
  sanitizeQuestions,
  questionsToPasteText,
} from "@/lib/material-pdf-utils";

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

export default function MaterialPdfGeneratorPage() {
  const { user, authLoading } = useAuth();
  const gate = useAdminGate();
  const authHeaders = useMemo(
    () => (gate.ready ? gate.headers : {}),
    [gate.ready, gate.headers],
  );
  const [mode, setMode] = useState<GeneratorMode>("select");
  const [materialName, setMaterialName] = useState("");
  const [subtitle, setSubtitle] = useState("MCQ Practice Material");
  const [addTopicModalOpen, setAddTopicModalOpen] = useState(false);
  const [newTopicName, setNewTopicName] = useState("");
  const [newTopicAfterQ, setNewTopicAfterQ] = useState<number>(0);
  const [pasteText, setPasteText] = useState("");
  const [questions, setQuestions] = useState<PdfMaterialQuestion[]>([]);
  const [lineSpacing, setLineSpacing] = useState<LineSpacing>("normal");
  const [detection, setDetection] = useState<{ total: number } | null>(null);
  // Server draft (Save as Draft persists; Download PDF removes after success).
  const [draftId, setDraftId] = useState<number | null>(null);
  const [drafts, setDrafts] = useState<{ id: number; title: string; subject: string | null; questionCount: number; updatedAt: string }[]>([]);
  const [draftsLoading, setDraftsLoading] = useState(false);
  const [draftBusy, setDraftBusy] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [draftSaving, setDraftSaving] = useState(false);
  /** Live PDF-build progress (pages done/total). Null when idle. */
  const [buildProgress, setBuildProgress] = useState<{ done: number; total: number } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [pdfBlob, setPdfBlob] = useState<Blob | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfReady, setPdfReady] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const standaloneInputRef = useRef<HTMLInputElement>(null);
  const questionFileRefs = useRef<Map<string, HTMLInputElement>>(new Map());
  const pdfUrlRef = useRef<string | null>(null);
  const [watermarkLogo, setWatermarkLogo] = useState<string | null>(null);
  const [watermarkLoading, setWatermarkLoading] = useState(true);
  const [watermarkSelectedFile, setWatermarkSelectedFile] = useState<File | null>(null);
  const [watermarkPreviewUrl, setWatermarkPreviewUrl] = useState<string | null>(null);
  const [watermarkBusy, setWatermarkBusy] = useState<"save" | "remove" | null>(null);
  const [watermarkNotice, setWatermarkNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const watermarkFileRef = useRef<HTMLInputElement>(null);
  // Watermark appearance controls — applied to the A4 preview, so the
  // generated PDF (captured from the preview) reflects them on every page.
  const [watermarkEnabled, setWatermarkEnabled] = useState(true);
  const [watermarkOpacity, setWatermarkOpacity] = useState(7); // percent
  const [watermarkSize, setWatermarkSize] = useState(280); // px width
  const [watermarkPosition, setWatermarkPosition] = useState<"top" | "center" | "bottom">("center");
  // Mobile scale-to-fit for the fixed-width A4 preview. The .a4-page stays a
  // true 794px for html2canvas capture; only the display wrapper scales.
  const [previewScale, setPreviewScale] = useState(1);
  // True while html2canvas captures — scaling is suspended so the PDF stays full-res.
  const [captureClean, setCaptureClean] = useState(false);
  const pageHeightRefs = useRef<Map<number, number>>(new Map());
  const [pageHeights, setPageHeights] = useState<Record<number, number>>({});

  const recordPageHeight = useCallback((pageNumber: number, el: HTMLElement | null) => {
    if (!el) {
      if (pageHeightRefs.current.delete(pageNumber)) {
        setPageHeights((prev) => {
          if (!(pageNumber in prev)) return prev;
          const next = { ...prev };
          delete next[pageNumber];
          return next;
        });
      }
      return;
    }
    const h = el.offsetHeight;
    if (h > 0 && pageHeightRefs.current.get(pageNumber) !== h) {
      pageHeightRefs.current.set(pageNumber, h);
      setPageHeights((prev) => (prev[pageNumber] === h ? prev : { ...prev, [pageNumber]: h }));
    }
  }, []);

  // Stable per-question file-input callbacks — same pattern as getPageRef.
  // The previous inline `ref={(el) => ...}` recreated the closure every render,
  // forcing React to detach/re-attach every question's hidden input on each
  // keystroke (edit lag that grows with question count).
  const questionFileRefCallbacks = useMemo(
    () =>
      new Map(
        questions.map((question) => [
          question.id,
          (el: HTMLInputElement | null) => {
            if (el) questionFileRefs.current.set(question.id, el);
            else questionFileRefs.current.delete(question.id);
          },
        ]),
      ),
    [questions],
  );

  function sanitizeFileName(name: string): string {
    const raw = (name || "MediSpark-Material").trim();
    // Remove invalid filename chars: < > : " / \ | ? * and control chars, also leading dots
    let s = raw.replace(/[<>:"/\\|?*\x00-\x1F]/g, "").replace(/^\.+/, "");
    // Replace whitespace with underscore, collapse multiple underscores
    s = s.replace(/\s+/g, "_").replace(/__+/g, "_").replace(/^_+|_+$/g, "");
    if (!s) s = "MediSpark-Material";
    // Limit to 60 chars (without extension)
    s = s.slice(0, 60).replace(/_+$/g, "");
    if (!s) s = "MediSpark-Material";
    return s;
  }

  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(t);
    }
  }, [toast]);

  // Revoke Blob URL on unmount or when replaced
  useEffect(() => {
    pdfUrlRef.current = pdfUrl;
  }, [pdfUrl]);

  useEffect(() => {
    return () => {
      if (pdfUrlRef.current) {
        URL.revokeObjectURL(pdfUrlRef.current);
        pdfUrlRef.current = null;
      }
    };
  }, []);

  // Revoke watermark preview URL on unmount or when replaced
  useEffect(() => {
    return () => {
      if (watermarkPreviewUrl) URL.revokeObjectURL(watermarkPreviewUrl);
    };
  }, [watermarkPreviewUrl]);

  // Fetch watermark logo on mount
  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/watermark-logo", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data?.logo?.url) return;
        setWatermarkLogo(data.logo.url);
      })
      .catch(() => {
        // Watermark not available — proceed without it
      })
      .finally(() => {
        if (!cancelled) setWatermarkLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Invalidate generated PDF when preview content changes (requires regeneration).
  // NOTE: lightweight signature (lengths, not full text) — JSON.stringify(questions)
  // every render copies multi-MB image dataUrls and janks the UI.
  const prevPreviewKeyRef = useRef<string>("");
  useEffect(() => {
    const qSig = questions
      .map(
        (q) =>
          `${q.id}:${q.qNumber}:${q.question.length}:${q.options.map((o) => o.length).join(",")}:` +
          `${q.answer}:${q.image ? `${q.image.dataUrl.length}:${q.image.widthPercent ?? 100}` : "-"}:` +
          `${q.topic ?? ""}:${q.isStandaloneImage ? 1 : 0}`,
      )
      .join("|");
    const key = qSig + "#" + materialName + "|" + subtitle + "|" + String(lineSpacing)
      + "|" + (watermarkEnabled ? "wm1" : "wm0") + "|" + watermarkOpacity + "|" + watermarkSize + "|" + watermarkPosition
      + "|" + (watermarkLogo ?? "");
    if (prevPreviewKeyRef.current && prevPreviewKeyRef.current !== key && pdfReady) {
      setPdfReady(false);
      setGenerateError(null);
    }
    prevPreviewKeyRef.current = key;
  }, [questions, materialName, subtitle, lineSpacing, watermarkEnabled, watermarkOpacity, watermarkSize, watermarkPosition, watermarkLogo, pdfReady]);

  // Pagination budget is derived from the real page geometry inside
  // paginateQuestionsDebug (content height − header/title overhead − the
  // page's own answer-box height) — no fixed over-reservation.
  const { pages, debug }: { pages: PaginatedPage[]; debug: PaginateDebugInfo } = useMemo(() => {
    return paginateQuestionsDebug(questions, undefined, lineSpacing, true, {
      titleReserve: materialName.trim().length > 0,
    });
  }, [questions, lineSpacing, materialName]);
  // Stable per-page callback refs. Reusing these callbacks prevents React from
  // detaching and re-attaching every page ref on each editor keystroke.
  const pageRefCallbacks = useMemo(
    () =>
      new Map(
        pages.map((page) => [
          page.pageNumber,
          (el: HTMLElement | null) => recordPageHeight(page.pageNumber, el),
        ]),
      ),
    [pages, recordPageHeight],
  );
  const [paginateDebugOn, setPaginateDebugOn] = useState(false);

  // Prune cached ref callbacks + measured heights for pages/questions that no
  // longer exist (delete/move/edit shrinks the maps instead of leaking them).
  useEffect(() => {
    const livePages = new Set(pages.map((p) => p.pageNumber));
    for (const k of [...pageHeightRefs.current.keys()]) {
      if (!livePages.has(k)) pageHeightRefs.current.delete(k);
    }
    const liveIds = new Set(questions.map((q) => q.id));
    for (const k of [...questionFileRefs.current.keys()]) {
      if (!liveIds.has(k)) {
        questionFileRefs.current.delete(k);
      }
    }
  }, [pages, questions]);

  // Pagination decision log: available height, per-question heights,
  // remaining space at every page break (devtools console).
  useEffect(() => {
    if (paginateDebugOn && questions.length > 0) logPaginateDebug(debug);
  }, [paginateDebugOn, debug, questions.length]);

  // Track the gray preview box width → shrink the A4 display wrapper to fit
  // phones (360px) instead of clipping it. Re-attaches when the preview mounts.
  useEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    let raf = 0;
    const compute = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        const avail = el.clientWidth - 32; // p-4 padding on both sides
        setPreviewScale(avail >= A4_PREVIEW_W ? 1 : Math.max(0.2, avail / A4_PREVIEW_W));
      });
    };
    compute();
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(compute);
      ro.observe(el);
      return () => {
        if (raf) cancelAnimationFrame(raf);
        ro.disconnect();
      };
    }
  }, [questions.length]);

  const handleDetect = () => {
    if (!pasteText.trim()) {
      setToast("Please paste questions first.");
      return;
    }
    // Arrange topic-wise when the pasted text carries Topic: headers.
    const sections = splitPasteByTopic(pasteText);
    let mapped: PdfMaterialQuestion[] = [];
    for (const section of sections) {
      // Same emptiness filter as the exam editor: drop blocks with no
      // number, no question text and no options so junk never becomes
      // phantom cards in the A4 preview.
      const parsed = parsePastedMcqs(section.text).filter(
        (p) =>
          p.originalNumber != null ||
          p.question.trim().length > 0 ||
          p.options.some((o) => o.trim()),
      );
      mapped = mapped.concat(mapParserToQuestions(parsed, section.topic));
    }
    if (mapped.length === 0) {
      setToast("No MCQs detected. Check format.");
      return;
    }
    const sanitized = sanitizeQuestions(mapped);
    const topicCount = new Set(sanitized.map((q) => q.topic ?? "")).size;
    setQuestions(sanitized);
    setDetection({ total: sanitized.filter((q) => !q.isStandaloneImage).length });
    setToast(
      `${sanitized.filter((q) => !q.isStandaloneImage).length} questions detected & formatted (1..${sanitized.filter((q) => !q.isStandaloneImage).length})${topicCount > 1 ? ` • ${topicCount} topics` : ""}`,
    );
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  /** Load questions from an uploaded exam (draft/published) into the A4 preview. */
  const handleExamLoad = (
    loaded: PdfMaterialQuestion[],
    examTitle: string,
    loadMode: "replace" | "append",
  ) => {
    if (loaded.length === 0) {
      setToast("This exam has no usable questions.");
      return;
    }
    // Exam content starts a fresh local session (not linked to a server draft).
    setDraftId(null);
    if (loadMode === "append" && questions.length > 0) {
      const merged = sanitizeQuestions([...questions, ...loaded]);
      setQuestions(merged);
      setDetection({ total: merged.filter((q) => !q.isStandaloneImage).length });
      // Keep the paste box in sync so the appended exam text stays copy-able.
      const appendedText = questionsToPasteText(loaded);
      if (appendedText) {
        setPasteText((prev) => [prev.trim(), appendedText].filter(Boolean).join("\n\n"));
      }
      setToast(`${loaded.length} questions appended from "${examTitle}"`);
    } else {
      // Replace: exam becomes the source of truth — the paste box is synced
      // to the loaded exam text (instead of cleared) so it stays copy-able,
      // and Detect & Format round-trips the same questions. Always adopt the
      // exam title (user can still rename it afterwards).
      setQuestions(loaded);
      setDetection({ total: loaded.filter((q) => !q.isStandaloneImage).length });
      setPasteText(questionsToPasteText(loaded));
      if (examTitle.trim()) setMaterialName(examTitle.trim());
      setToast(`${loaded.length} questions loaded from "${examTitle}" — edit, Save as Draft, then Download`);
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  /** Rename a topic group heading — updates every question in that group. */
  const handleRenameTopic = (oldTopic: string, newTopic: string) => {
    const next = newTopic.trim();
    if (!next || next === oldTopic) return;
    setQuestions((prev) => prev.map((q) => (q.topic === oldTopic ? { ...q, topic: next } : q)));
    setToast("Topic renamed");
  };

  /** Move an entire topic and ALL its associated MCQs up or down. */
  const handleMoveTopic = (topicName: string, dir: -1 | 1) => {
    setQuestions((prev) => {
      const chunks: { topic: string; items: PdfMaterialQuestion[] }[] = [];
      let curChunk: { topic: string; items: PdfMaterialQuestion[] } | null = null;
      for (const q of prev) {
        const t = q.topic ?? "";
        if (!curChunk || curChunk.topic !== t) {
          curChunk = { topic: t, items: [q] };
          chunks.push(curChunk);
        } else {
          curChunk.items.push(q);
        }
      }

      const idx = chunks.findIndex((c) => c.topic === topicName);
      if (idx === -1) return prev;
      const target = idx + dir;
      if (target < 0 || target >= chunks.length) return prev;

      const [moved] = chunks.splice(idx, 1);
      chunks.splice(target, 0, moved);

      const flattened = chunks.flatMap((c) => c.items);
      return sanitizeQuestions(flattened);
    });
    setToast(`Topic "${topicName}" moved ${dir === -1 ? "up" : "down"}`);
  };

  /** Delete a topic header — MCQs are preserved and adopt preceding topic. */
  const handleDeleteTopic = (topicToDelete: string) => {
    setQuestions((prev) => {
      let prevTopic: string | undefined = undefined;
      const next = prev.map((q) => {
        if (q.topic === topicToDelete) {
          return { ...q, topic: prevTopic };
        }
        if (q.topic) {
          prevTopic = q.topic;
        }
        return q;
      });
      return sanitizeQuestions(next);
    });
    setToast(`Topic "${topicToDelete}" removed`);
  };

  /** Add or assign a Topic Header starting after a given question number. */
  const handleAddTopic = (topicName: string, startAfterQNumber: number) => {
    const tName = topicName.trim();
    if (!tName) return;
    setQuestions((prev) => {
      let targetIdx = 0;
      if (startAfterQNumber > 0) {
        const found = prev.findIndex((q) => !q.isStandaloneImage && q.qNumber === startAfterQNumber);
        if (found !== -1) {
          targetIdx = found + 1;
        }
      }
      if (targetIdx >= prev.length && prev.length > 0) return prev;
      const next = [...prev];
      for (let i = targetIdx; i < next.length; i++) {
        next[i] = { ...next[i], topic: tName };
      }
      return sanitizeQuestions(next);
    });
    setToast(`Topic "${tName}" added`);
  };

  const handleUpdate = (id: string, patch: Partial<PdfMaterialQuestion>) => {
    setQuestions((prev) => prev.map((q) => (q.id === id ? { ...q, ...patch } : q)));
  };

  const handleDelete = (id: string) => {
    setQuestions((prev) => sanitizeQuestions(prev.filter((q) => q.id !== id)));
  };

  const handleAnswerChange = (id: string, val: string) => {
    let v = val.trim().toUpperCase();
    // Map Bangla to English for storage
    const bnToEn: Record<string, string> = { ক: "A", খ: "B", গ: "C", ঘ: "D" };
    if (bnToEn[val.trim()]) v = bnToEn[val.trim()];
    const allowed = ["A", "B", "C", "D", ""];
    const final = allowed.includes(v) ? v : "";
    handleUpdate(id, { answer: final });
  };

  const handleStandaloneImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setToast("Please select an image file");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setToast("Image too large (max 8MB)");
      return;
    }
    try {
      const dataUrl = await fileToDataUrl(file);
      const newBlock: PdfMaterialQuestion = {
        id: uid(),
        qNumber: 0,
        question: "",
        options: ["", "", "", ""],
        answer: "",
        needsReview: false,
        issues: [],
        image: { dataUrl, name: file.name, widthPercent: 100 },
        isStandaloneImage: true,
      };
      setQuestions((prev) => [...prev, newBlock]);
      setToast("Image inserted — you can move/resize it");
    } catch {
      setToast("Failed to load image");
    } finally {
      if (standaloneInputRef.current) standaloneInputRef.current.value = "";
    }
  };

  const handleQuestionImageUpload = async (id: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setToast("Please select an image file");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setToast("Image too large (max 8MB)");
      return;
    }
    try {
      const dataUrl = await fileToDataUrl(file);
      handleUpdate(id, { image: { dataUrl, name: file.name, widthPercent: 100 } });
      setToast("Image added to question");
    } catch {
      setToast("Failed to load image");
    } finally {
      const r = questionFileRefs.current.get(id);
      if (r) r.value = "";
    }
  };

  const handleRemoveImage = (id: string) => {
    handleUpdate(id, { image: null });
    setToast("Image removed");
  };

  const handleResizeImage = (id: string, widthPercent: number) => {
    setQuestions((prev) => prev.map((q) => (q.id === id && q.image ? { ...q, image: { ...q.image, widthPercent } } : q)));
  };

  const handleMoveBlock = (id: string, dir: -1 | 1) => {
    setQuestions((prev) => {
      const idx = prev.findIndex((q) => q.id === id);
      if (idx === -1) return prev;
      const target = idx + dir;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(idx, 1);
      next.splice(target, 0, moved);

      // If moved across topic boundary, adapt topic so it joins the new neighbor topic
      if (next[target - 1]?.topic && next[target + 1]?.topic && next[target - 1].topic === next[target + 1].topic) {
        moved.topic = next[target - 1].topic;
      } else if (target === 0 && next[1]?.topic) {
        moved.topic = next[1].topic;
      } else if (target === next.length - 1 && next[target - 1]?.topic) {
        moved.topic = next[target - 1].topic;
      }

      return sanitizeQuestions(next);
    });
  };

  const handleInsertStandaloneAfter = async (afterId: string) => {
    // Trigger file picker and insert after given id
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      if (!file.type.startsWith("image/")) {
        setToast("Please select an image file");
        return;
      }
      const dataUrl = await fileToDataUrl(file);
      const newBlock: PdfMaterialQuestion = {
        id: uid(),
        qNumber: 0,
        question: "",
        options: ["", "", "", ""],
        answer: "",
        needsReview: false,
        issues: [],
        image: { dataUrl, name: file.name, widthPercent: 100 },
        isStandaloneImage: true,
      };
      setQuestions((prev) => {
        const idx = prev.findIndex((q) => q.id === afterId);
        if (idx === -1) return [...prev, newBlock];
        const next = [...prev];
        next.splice(idx + 1, 0, newBlock);
        return next;
      });
      setToast("Image inserted between questions");
    };
    input.click();
  };

  const handleWatermarkFileChange = (file: File | undefined) => {
    setWatermarkNotice(null);
    if (!file) {
      setWatermarkSelectedFile(null);
      setWatermarkPreviewUrl(null);
      return;
    }
    const ext = file.name.includes(".") ? `.${file.name.split(".").pop()?.toLowerCase()}` : "";
    const allowedExts = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"];
    if (ext && !allowedExts.includes(ext as never)) {
      setWatermarkNotice({ kind: "error", text: `Unsupported file type "${ext}". Use PNG, JPG, WEBP or SVG.` });
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setWatermarkNotice({ kind: "error", text: "File is too large. The logo must be 5 MB or smaller." });
      return;
    }
    if (watermarkPreviewUrl) URL.revokeObjectURL(watermarkPreviewUrl);
    setWatermarkSelectedFile(file);
    setWatermarkPreviewUrl(URL.createObjectURL(file));
  };

  const handleWatermarkUpload = async () => {
    if (!watermarkSelectedFile) return;
    setWatermarkBusy("save");
    setWatermarkNotice(null);
    try {
      let token = "";
      if (user) {
        token = await user.getIdToken();
      }
      const formData = new FormData();
      formData.append("logo", watermarkSelectedFile);
      const response = await fetch("/api/admin/watermark-logo", {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: formData,
      });
      const data = (await response.json()) as { error?: string; logo?: { url: string } };
      if (!response.ok) {
        setWatermarkNotice({ kind: "error", text: data.error ?? "Failed to save the watermark logo." });
        return;
      }
      setWatermarkLogo(data.logo?.url ?? null);
      setWatermarkSelectedFile(null);
      setWatermarkPreviewUrl(null);
      if (watermarkFileRef.current) watermarkFileRef.current.value = "";
      setWatermarkNotice({ kind: "success", text: "Watermark logo saved — it will appear on every generated PDF." });
      setToast("Watermark logo saved");
    } catch {
      setWatermarkNotice({ kind: "error", text: "Upload failed — please try again." });
    } finally {
      setWatermarkBusy(null);
    }
  };

  const handleWatermarkRemove = async () => {
    setWatermarkBusy("remove");
    setWatermarkNotice(null);
    try {
      const response = await fetch("/api/admin/watermark-logo", { method: "DELETE" });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        setWatermarkNotice({ kind: "error", text: data.error ?? "Failed to remove the watermark logo." });
        return;
      }
      setWatermarkLogo(null);
      setWatermarkNotice({ kind: "success", text: "Watermark logo removed — future PDFs will have no watermark." });
      setToast("Watermark logo removed");
    } catch {
      setWatermarkNotice({ kind: "error", text: "Remove failed — please try again." });
    } finally {
      setWatermarkBusy(null);
    }
  };

  // Shared core: build PDF Blob client-side (no server round-trip).
  // Reports per-page progress so the Download button shows live %.
  // Each page is captured in isolation (siblings hidden) at 1.5x scale —
  // a full-document 2x capture is a single minutes-long task that freezes
  // the tab ("Page isn't responding"). Yields between pages let the bar paint.
  const buildPdfBlob = async (onProgress?: (done: number, total: number) => void): Promise<Blob> => {
    if (questions.length === 0) throw new Error("No questions to generate.");
    if (!previewRef.current) throw new Error("Preview not ready — please try again.");
    // Suspend mobile display scaling so html2canvas captures the full 794px page.
    setCaptureClean(true);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    let pageEls: HTMLElement[] = [];
    let originalDisplays: string[] = [];
    try {
    const [{ default: jsPDF }, { default: html2canvas }] = await Promise.all([
      import("jspdf"),
      import("html2canvas"),
    ]);
    // Ensure Bangla fonts and images loaded
    if (document.fonts?.ready) await document.fonts.ready;
    const imgs = Array.from(previewRef.current.querySelectorAll("img"));
    await Promise.all(
      imgs.map(
        (img) =>
          new Promise<void>((res) => {
            if ((img as HTMLImageElement).complete) res();
            else {
              (img as HTMLImageElement).onload = () => res();
              (img as HTMLImageElement).onerror = () => res();
            }
          }),
      ),
    );
    await new Promise((r) => setTimeout(r, 300));
    const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });
    pageEls = Array.from(previewRef.current.querySelectorAll<HTMLElement>(".a4-page"));
    if (!pageEls || pageEls.length === 0) throw new Error("Preview not ready");
    // Capture one page at a time with the rest hidden: layout/paint cost
    // drops to a single page and the tab stays responsive. Always restored.
    originalDisplays = pageEls.map((el) => el.style.display);
    onProgress?.(0, pageEls.length);
    // Large builds (e.g. 27 pages): lower capture scale keeps single-page
    // tasks short enough that the tab never hangs; a failed page retries
    // once at scale 1 before failing the whole build.
    const baseScale = pageEls.length > 12 ? 1.25 : 1.5;
    const captureOne = async (el: HTMLElement, scale: number): Promise<HTMLCanvasElement> => {
      const restoreTextBaseline = fixHtml2CanvasTextBaseline(document);
      return html2canvas(el, {
        scale,
        useCORS: true,
        allowTaint: false,
        backgroundColor: "#ffffff",
        logging: false,
        onclone: (clonedDoc) => {
          const style = clonedDoc.createElement("style");
          style.textContent = `@import url('https://fonts.googleapis.com/css2?family=Hind+Siliguri:wght@400;600;700&family=Noto+Sans+Bengali:wght@400;600;700&display=swap');`;
          clonedDoc.head.appendChild(style);
          // html2canvas 1.4.1 cannot parse Tailwind v4 modern colors
          // (oklch/oklab/color-mix from opacity modifiers like bg-white/10).
          // Rewrite them to sRGB in the clone so capture never throws.
          try {
            sanitizeClonedColorsForHtml2Canvas(clonedDoc);
          } catch {}
        },
      }).finally(restoreTextBaseline);
    };
    for (let i = 0; i < pageEls.length; i++) {
      const el = pageEls[i];
      pageEls.forEach((other, j) => {
        other.style.display = j === i ? "" : "none";
      });
      // Settle layout, report progress, then yield so React + browser
      // actually paint the bar before the heavy capture blocks the thread.
      // The longer pause matters for 20+ page builds (hang watchdog).
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      onProgress?.(i, pageEls.length);
      await new Promise((r) => setTimeout(r, 250));
      let canvas: HTMLCanvasElement;
      try {
        canvas = await captureOne(el, baseScale);
      } catch {
        canvas = await captureOne(el, 1);
      }
      const imgData = canvas.toDataURL("image/jpeg", 0.92);
      const pageW = pdf.internal.pageSize.getWidth();
      const pageH = pdf.internal.pageSize.getHeight();
      if (i > 0) pdf.addPage();
      // Preview-faithful placement: exact-A4 fills edge-to-edge; overflow
      // captures shrink uniformly (never stretched, never clipped).
      const rect = capturePageRect(canvas.width, canvas.height, pageW, pageH);
      pdf.addImage(imgData, "JPEG", rect.x, rect.y, rect.w, rect.h, undefined, "FAST");
    }
    onProgress?.(pageEls.length, pageEls.length);
    const blob: Blob = pdf.output("blob");
    if (!blob || blob.size === 0) throw new Error("Generated PDF is empty — please try again.");
    return blob;
    } finally {
      // Always unhide pages (even on failure) so the preview is intact.
      try {
        pageEls.forEach((el, j) => {
          el.style.display = originalDisplays[j] ?? "";
        });
      } catch {}
      setCaptureClean(false);
    }
  };

  const triggerClientDownload = (blob: Blob, fileName: string) => {
    // Always create a fresh object URL from the Blob — ensures download lands on user's device, not server
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.style.display = "none";
    a.rel = "noopener";
    document.body.appendChild(a);
    // iOS Safari fallback: download attribute ignored -> open in new tab
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    if (isIOS) {
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } else {
      a.click();
      setTimeout(() => {
        if (a.parentNode) document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 1000);
    }
  };

  // ── Server drafts (Save as Draft persists, Download removes after success) ──
  type DraftMeta = { id: number; title: string; subject: string | null; questionCount: number; updatedAt: string };

  const loadDrafts = async () => {
    setDraftsLoading(true);
    try {
      const res = await fetch("/api/admin/material-drafts", { cache: "no-store", headers: authHeaders });
      const data = (await res.json().catch(() => null)) as { drafts?: DraftMeta[]; error?: string } | null;
      if (!res.ok) throw new Error(data?.error ?? "Failed to load drafts.");
      setDrafts(Array.isArray(data?.drafts) ? data.drafts : []);
    } catch {
      // Draft list is best-effort — local editing still works.
    } finally {
      setDraftsLoading(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (mode === "mcq" && gate.ready) void loadDrafts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, gate.ready]);

  /** Persist the current preview as a server draft (called by Save as Draft). */
  const saveDraftToServer = async (): Promise<number | null> => {
    try {
      const res = await fetch("/api/admin/material-drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({
          id: draftId,
          title: materialName.trim() || "Untitled Material",
          subtitle,
          lineSpacing,
          questions,
        }),
      });
      const data = (await res.json().catch(() => null)) as { id?: number; error?: string } | null;
      if (!res.ok || !data?.id) throw new Error(data?.error ?? "Draft save failed.");
      setDraftId(data.id);
      void loadDrafts();
      return data.id;
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Draft save failed.");
      return null;
    }
  };

  const handleLoadDraft = async (id: number) => {
    setDraftBusy(`load-${id}`);
    try {
      const res = await fetch(`/api/admin/material-drafts?id=${id}`, { cache: "no-store", headers: authHeaders });
      const data = (await res.json().catch(() => null)) as {
        draft?: {
          id: number;
          title: string;
          subject: string | null;
          payload?: { header?: { title?: string; subject?: string }; questions?: PdfMaterialQuestion[]; lineSpacing?: unknown };
        };
        error?: string;
      } | null;
      if (!res.ok || !data?.draft) throw new Error(data?.error ?? "Failed to load draft.");
      const loaded = sanitizeQuestions(Array.isArray(data.draft.payload?.questions) ? data.draft.payload.questions : []);
      if (loaded.length === 0) throw new Error("Draft has no questions.");
      const header = data.draft.payload?.header;
      const ls = data.draft.payload?.lineSpacing;
      setQuestions(loaded);
      setPasteText(questionsToPasteText(loaded));
      setMaterialName(header?.title?.trim() || data.draft.title || "");
      setSubtitle(header?.subject ?? data.draft.subject ?? "MCQ Practice Material");
      if (ls === "compact" || ls === "normal" || ls === "relaxed" || typeof ls === "number") setLineSpacing(ls);
      setDraftId(data.draft.id);
      setDetection({ total: loaded.filter((q) => !q.isStandaloneImage).length });
      setPdfReady(false);
      setPdfBlob(null);
      setGenerateError(null);
      setToast(`Draft "${data.draft.title}" loaded — edit, Save as Draft again to update it.`);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Failed to load draft.");
    } finally {
      setDraftBusy(null);
    }
  };

  const handleDeleteDraft = async (id: number) => {
    if (!window.confirm("Delete this server draft permanently?")) return;
    setDraftBusy(`delete-${id}`);
    try {
      const res = await fetch("/api/admin/material-drafts", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ id }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(data?.error ?? "Delete failed.");
      if (draftId === id) setDraftId(null);
      setDrafts((prev) => prev.filter((d) => d.id !== id));
      setToast("Draft deleted from server.");
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Delete failed.");
    } finally {
      setDraftBusy(null);
    }
  };

  const handleSaveDraft = async () => {
    if (questions.length === 0) {
      setToast("No questions to save.");
      setGenerateError("No questions to save.");
      return;
    }
    setDraftSaving(true);
    setGenerateError(null);
    try {
      const savedId = await saveDraftToServer();
      if (savedId) {
        setGenerateError(null);
        setToast(`Draft #${savedId} saved on server — edit anytime (paste more, remove any), Download removes it.`);
      }
    } finally {
      setDraftSaving(false);
    }
  };

  const handleDownloadPdf = async () => {
    if (generating || draftSaving) {
      setToast("Please wait…");
      return;
    }
    if (questions.length === 0) {
      setToast("Nothing to download — add questions first.");
      return;
    }
    // Download builds the file on demand from the live preview, ships it,
    // then removes the server draft — only when the download dispatched
    // without errors. ANY failure above keeps the draft for a retry.
    let blobToDownload: Blob | null = pdfBlob && pdfReady ? pdfBlob : null;
    if (!blobToDownload) {
      if (!previewRef.current) {
        setToast("Preview not ready — please try again.");
        return;
      }
      setGenerating(true);
      setGenerateError(null);
      setBuildProgress({ done: 0, total: 1 });
      try {
        blobToDownload = await buildPdfBlob((done, total) => {
          setBuildProgress({ done, total });
        });
        const url = URL.createObjectURL(blobToDownload);
        setPdfBlob(blobToDownload);
        setPdfUrl(url);
        pdfUrlRef.current = url;
        setPdfReady(true);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "PDF generation failed — please try again.";
        setGenerateError(msg);
        setToast(msg);
        return;
      } finally {
        setGenerating(false);
        setBuildProgress(null);
      }
    }
    try {
      const fileName = `${sanitizeFileName(materialName)}.pdf`;
      triggerClientDownload(blobToDownload, fileName);
      if (draftId !== null) {
        try {
          const res = await fetch("/api/admin/material-drafts", {
            method: "DELETE",
            headers: { "Content-Type": "application/json", ...authHeaders },
            body: JSON.stringify({ id: draftId }),
          });
          if (!res.ok) throw new Error("Server removal failed.");
          setDraftId(null);
          void loadDrafts();
          setToast(`PDF downloaded — server draft #${draftId} removed.`);
        } catch {
          setToast("PDF downloaded — but the server draft could not be removed. Delete it manually below.");
        }
      } else {
        setToast("PDF downloaded to your device");
      }
      setGenerateError(null);
    } catch (e) {
      // Download failed → server draft stays untouched for a retry.
      const msg = e instanceof Error ? e.message : "Download failed — please try again.";
      setGenerateError(msg);
      setToast(msg);
    }
  };

  const handleCopyPaste = async () => {
    if (!pasteText.trim()) {
      setToast("Nothing to copy.");
      return;
    }
    try {
      await navigator.clipboard.writeText(pasteText);
      setToast("Paste text copied");
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = pasteText;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        setToast("Paste text copied");
      } catch {
        setToast("Copy failed — select the text manually.");
      }
    }
  };

  const handleClear = () => {
    setQuestions([]);
    setPasteText("");
    setDetection(null);
    setDraftId(null);
    setGenerateError(null);
    setPdfReady(false);
    setPdfBlob(null);
    if (pdfUrl) {
      URL.revokeObjectURL(pdfUrl);
      pdfUrlRef.current = null;
    }
    setPdfUrl(null);
    setToast("Cleared");
  };

  if (authLoading) return <AccessLoading label="Loading Material PDF Generator…" />;

  // ── Main page: ONLY TWO generator cards (MCQ + CQ). No third card. ──
  if (mode === "select") {
    return (
      <div className="min-h-screen bg-[#f1f5f9] admin-dark:bg-[#0a162e]">
        <div className="mx-auto max-w-[1280px] px-3 py-6 sm:px-6 sm:py-8">
          <div className="rounded-2xl border border-[#dbeafe] bg-white p-4 sm:p-6 shadow-sm admin-dark:border-[#1e3a65] admin-dark:bg-[#112544]">
            <p className="text-[11px] font-bold uppercase tracking-widest text-[#234e9f] admin-dark:text-[#93c5fd]">
              Admin Tool • Materials PDF Generator
            </p>
            <h1 className="mt-1 text-xl font-extrabold text-[#0b1e3a] sm:text-2xl admin-dark:text-white">
              Materials PDF Generator
            </h1>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-slate-500 sm:text-sm admin-dark:text-[#8da0c0]">
              Choose a generator — paste questions, Detect &amp; Format, edit the A4 preview, then Save as Draft + Download.
            </p>
          </div>

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => setMode("mcq")}
              className="group rounded-2xl border border-[#dbeafe] bg-white p-6 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-[#234e9f]/50 hover:shadow-md admin-dark:border-[#1e3a65] admin-dark:bg-[#112544] admin-dark:hover:border-[#3b82f6]/60"
            >
              <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#0b1e3a]/5 text-xl font-black text-[#0b1e3a] transition group-hover:bg-[#0b1e3a] group-hover:text-white admin-dark:bg-white/10 admin-dark:text-white admin-dark:group-hover:bg-white admin-dark:group-hover:text-[#0b1e3a]">
                ☰
              </span>
              <span className="mt-4 block text-base font-extrabold text-[#0b1e3a] admin-dark:text-white">
                MCQ PDF Generator
              </span>
              <span className="mt-1 block text-xs leading-relaxed text-slate-500 admin-dark:text-[#8da0c0]">
                Paste 10 / 20 / 50 / 100+ MCQs → Detect &amp; Format → editable two-column A4 preview with images, logo &amp; watermark → Save as Draft + Download.
              </span>
              <span className="mt-4 inline-block rounded-xl bg-[#0b1e3a] px-5 py-2 text-xs font-extrabold text-white admin-dark:bg-[#234e9f]">
                Open MCQ Generator →
              </span>
            </button>

            <button
              type="button"
              onClick={() => setMode("cq")}
              className="group rounded-2xl border border-[#dbeafe] bg-white p-6 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-emerald-600/50 hover:shadow-md admin-dark:border-[#1e3a65] admin-dark:bg-[#112544] admin-dark:hover:border-emerald-500/60"
            >
              <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-600/10 text-xl font-black text-emerald-700 transition group-hover:bg-emerald-600 group-hover:text-white admin-dark:bg-emerald-500/10 admin-dark:text-emerald-300">
                ✎
              </span>
              <span className="mt-4 block text-base font-extrabold text-[#0b1e3a] admin-dark:text-white">
                CQ PDF Generator
              </span>
              <span className="mt-1 block text-xs leading-relaxed text-slate-500 admin-dark:text-[#8da0c0]">
                Paste creative questions (উদ্দীপক + ক / খ / গ / ঘ) → Detect &amp; Format → editable single-column A4 preview → PDF Download.
              </span>
              <span className="mt-4 inline-block rounded-xl bg-emerald-600 px-5 py-2 text-xs font-extrabold text-white hover:bg-emerald-700">
                Open CQ Generator →
              </span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (mode === "cq") {
    return <CqPdfGenerator onBack={() => setMode("select")} />;
  }

  const spacingLabel = typeof lineSpacing === "string" ? lineSpacing : `${lineSpacing}`;
  const lineHeightStyle = lineSpacingFactor(lineSpacing);
  const questionCount = questions.filter((q) => !q.isStandaloneImage).length;
  const imageCount = questions.filter((q) => q.image).length;

  return (
    <div className="min-h-screen bg-[#f1f5f9] admin-dark:bg-[#0a162e]">
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Hind+Siliguri:wght@400;600;700&family=Noto+Sans+Bengali:wght@400;600;700&display=swap'); .bangla{font-family:'Hind Siliguri','Noto Sans Bengali',system-ui,sans-serif} .a4-page *{font-family:'Hind Siliguri','Noto Sans Bengali',system-ui,sans-serif} .a4-page{break-inside:avoid;page-break-inside:avoid} .a4-page .keep-together{break-inside:avoid;page-break-inside:avoid;-webkit-column-break-inside:avoid} .a4-page ol,.a4-page ul{list-style-type:none !important;list-style:none !important;margin-left:0 !important;padding-left:0 !important} .a4-page li::marker{content:none !important} @media print{.a4-page{break-after:page;page-break-after:always;break-inside:avoid;page-break-inside:avoid} .a4-page h1,.a4-page h2,.a4-page .keep-together{overflow:visible !important;height:auto !important;max-height:none !important;white-space:normal !important;text-overflow:clip !important} .a4-page h1,.a4-page h2{line-height:1.5 !important}}`}</style>

      <div className="mx-auto max-w-[1280px] px-3 py-6 sm:px-6 sm:py-8">
        {/* Top Title */}
        <div className="rounded-2xl border border-[#dbeafe] bg-white p-4 sm:p-6 shadow-sm admin-dark:border-[#1e3a65] admin-dark:bg-[#112544]">
          <button
            type="button"
            onClick={() => setMode("select")}
            className="mb-3 rounded-xl border border-[#cbd5e1] bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50 admin-dark:border-[#1e3a65] admin-dark:bg-[#0f2547] admin-dark:text-white"
          >
            ← All Generators
          </button>
          <p className="text-[11px] font-bold uppercase tracking-widest text-[#234e9f] admin-dark:text-[#93c5fd]">
            Admin Tool • MCQ PDF Generator
          </p>
          <h1 className="mt-1 text-xl font-extrabold text-[#0b1e3a] sm:text-2xl admin-dark:text-white">
            MCQ PDF Generator
          </h1>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-slate-500 sm:text-sm admin-dark:text-[#8da0c0]">
            Material Name → Paste MCQs → Detect & Format → Editable A4 Preview → Save as Draft → Download. Two-column A4, never-split MCQ blocks, page-specific উত্তরমালা. Manual image insertion (no OCR).
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <span className="text-xs font-bold text-slate-600 admin-dark:text-[#8da0c0]">
              {questionCount} Questions • {imageCount > 0 ? `${imageCount} Images • ` : ""}{pages.length} Page{pages.length !== 1 ? "s" : ""} • A4 Two-Column
            </span>
            {detection && (
              <span className="rounded-full bg-slate-900 px-3 py-1 text-xs font-bold text-white admin-dark:bg-white admin-dark:text-slate-900">
                {detection.total} Detected
              </span>
            )}
          </div>
        </div>

        {/* 1. Material Name */}
        <div className="mt-6 rounded-2xl border border-[#dbeafe] bg-white p-4 sm:p-6 shadow-sm admin-dark:border-[#1e3a65] admin-dark:bg-[#112544]">
          <label className="text-sm font-extrabold text-[#0b1e3a] admin-dark:text-white">1. Material Name</label>
          <p className="mt-1 text-xs text-slate-500 admin-dark:text-[#8da0c0]">
            This name will appear in the PDF title area (centered below header) if provided.
          </p>
          <input
            value={materialName}
            onChange={(e) => setMaterialName(e.target.value)}
            placeholder="e.g. Biology - Cell - Model Test 01"
            className="bangla mt-3 w-full rounded-xl border border-[#cbd5e1] bg-[#f8fafc] px-4 py-3 text-sm font-semibold text-slate-900 outline-none placeholder:text-slate-400 focus:border-[#234e9f] focus:bg-white admin-dark:border-[#1e3a65] admin-dark:bg-[#0a162e] admin-dark:text-white"
          />
        </div>

        {/* 2. From Uploaded Exam (Draft / Published) */}
        <div className="mt-6 rounded-2xl border border-[#dbeafe] bg-white p-4 sm:p-6 shadow-sm admin-dark:border-[#1e3a65] admin-dark:bg-[#112544]">
          <label className="text-sm font-extrabold text-[#0b1e3a] admin-dark:text-white">
            2. From Uploaded Exam <span className="ml-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-extrabold text-emerald-700 admin-dark:bg-emerald-900/30 admin-dark:text-emerald-300">NEW</span>
          </label>
          <p className="mt-1 text-xs leading-relaxed text-slate-500 admin-dark:text-[#8da0c0]">
            Paste না করে uploaded/added exam থেকেও PDF বানানো যাবে — Draft / Published filter করো, search করে dropdown থেকে exam select করে Load দাও। নিচের A4 preview-এ edit করে Save as Draft দাও।
          </p>
          <div className="mt-3">
            {gate.ready ? (
              <ExamSourcePicker authHeaders={authHeaders} onLoad={handleExamLoad} />
            ) : (
              <p className="text-xs text-slate-400">Checking admin access…</p>
            )}
          </div>
        </div>

        {/* 2b. Server Drafts — Save as Draft stores here, edit later, Download removes */}
        <div className="mt-6 rounded-2xl border border-[#dbeafe] bg-white p-4 sm:p-6 shadow-sm admin-dark:border-[#1e3a65] admin-dark:bg-[#112544]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="text-sm font-extrabold text-[#0b1e3a] admin-dark:text-white">
              Saved Drafts
              {draftId !== null && (
                <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-extrabold text-emerald-700 admin-dark:bg-emerald-900/30 admin-dark:text-emerald-300">
                  Editing draft #{draftId}
                </span>
              )}
            </label>
            <button
              type="button"
              onClick={() => void loadDrafts()}
              disabled={draftsLoading}
              className="rounded-xl border border-[#cbd5e1] bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-40 admin-dark:border-[#1e3a65] admin-dark:bg-[#0f2547] admin-dark:text-white"
            >
              {draftsLoading ? "Loading…" : "↻ Refresh"}
            </button>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-slate-500 admin-dark:text-[#8da0c0]">
            Save as Draft stores your work on the server — load it later to paste more questions, remove any, and save again. Downloading removes the draft only after a successful download.
          </p>
          {draftsLoading && drafts.length === 0 ? (
            <p className="mt-3 text-xs text-slate-400">Loading drafts…</p>
          ) : drafts.length === 0 ? (
            <p className="mt-3 text-xs text-slate-400">No saved drafts yet — Save as Draft to create one.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {drafts.map((d) => (
                <li
                  key={d.id}
                  className={`flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2 ${d.id === draftId ? "border-emerald-400 bg-emerald-50/60 admin-dark:border-emerald-700 admin-dark:bg-emerald-900/20" : "border-[#e2e8f0] bg-[#f8fafc] admin-dark:border-[#1e3a65] admin-dark:bg-[#0a162e]"}`}
                >
                  <span className="min-w-0 flex-1 text-xs font-bold text-[#0b1e3a] admin-dark:text-white">
                    #{d.id} {d.title}
                    <span className="ml-2 font-semibold text-slate-500 admin-dark:text-slate-400">
                      {d.questionCount} Qs • {new Date(d.updatedAt).toLocaleString()}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleLoadDraft(d.id)}
                    disabled={draftBusy !== null}
                    className="rounded-lg bg-[#0b1e3a] px-3 py-1 text-[11px] font-bold text-white hover:bg-[#123060] disabled:opacity-40 admin-dark:bg-[#234e9f]"
                  >
                    {draftBusy === `load-${d.id}` ? "Loading…" : "Load"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDeleteDraft(d.id)}
                    disabled={draftBusy !== null}
                    className="rounded-lg border border-red-200 bg-white px-3 py-1 text-[11px] font-bold text-red-600 hover:bg-red-50 disabled:opacity-40 admin-dark:border-red-900/40 admin-dark:bg-transparent admin-dark:text-red-300"
                  >
                    {draftBusy === `delete-${d.id}` ? "Deleting…" : "Delete"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* 4. Watermark Logo */}
        <div className="mt-6 rounded-2xl border border-[#dbeafe] bg-white p-4 sm:p-6 shadow-sm admin-dark:border-[#1e3a65] admin-dark:bg-[#112544]">
          <label className="text-sm font-extrabold text-[#0b1e3a] admin-dark:text-white">4. Watermark Logo</label>
          <p className="mt-1 text-xs leading-relaxed text-slate-500 admin-dark:text-[#8da0c0]">
            Upload a watermark logo once — it is saved permanently and automatically appears as a centered, transparent background mark on every generated PDF page. Upload once, use on every PDF.
          </p>
          {watermarkNotice && (
            <div
              className={`mt-3 rounded-xl px-4 py-2.5 text-xs font-semibold ${
                watermarkNotice.kind === "success"
                  ? "border border-emerald-200 bg-emerald-50 text-emerald-700 admin-dark:border-emerald-900/40 admin-dark:bg-emerald-900/20 admin-dark:text-emerald-300"
                  : "border border-red-200 bg-red-50 text-red-700 admin-dark:border-red-900/40 admin-dark:bg-red-900/20 admin-dark:text-red-300"
              }`}
            >
              {watermarkNotice.text}
            </div>
          )}
          <div className="mt-3 flex flex-wrap items-start gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <input
                ref={watermarkFileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                className="hidden"
                onChange={(e) => handleWatermarkFileChange(e.target.files?.[0])}
              />
              <button
                type="button"
                onClick={() => watermarkFileRef.current?.click()}
                disabled={watermarkBusy === "save"}
                className="rounded-xl bg-[#0b1e3a] px-5 py-2.5 text-sm font-extrabold text-white shadow hover:bg-[#123060] disabled:opacity-40 admin-dark:bg-[#234e9f]"
              >
                {watermarkLogo ? "Replace Logo" : "Upload Logo"}
              </button>
              {watermarkLogo && (
                <button
                  type="button"
                  onClick={handleWatermarkRemove}
                  disabled={watermarkBusy === "remove"}
                  className="rounded-xl border border-red-200 bg-white px-4 py-2.5 text-sm font-bold text-red-700 hover:bg-red-50 disabled:opacity-40 admin-dark:border-red-900/40 admin-dark:bg-zinc-900 admin-dark:text-red-300 admin-dark:hover:bg-red-900/20"
                >
                  Remove Logo
                </button>
              )}
              {watermarkSelectedFile && (
                <button
                  type="button"
                  onClick={handleWatermarkUpload}
                  disabled={watermarkBusy === "save"}
                  className="rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-extrabold text-white shadow hover:bg-emerald-700 disabled:opacity-40"
                >
                  {watermarkLogo ? "Replace" : "Upload"}
                </button>
              )}
            </div>
            {watermarkLogo && (
              <div className="rounded-xl border border-[#cbd5e1] bg-white p-2 admin-dark:border-[#1e3a65] admin-dark:bg-zinc-900">
                <span className="text-[10px] font-bold text-slate-500 admin-dark:text-slate-400">Logo Preview</span>
                <img
                  src={watermarkLogo}
                  alt="Watermark preview"
                  className="mt-1 block h-14 w-auto max-w-[180px] object-contain"
                  crossOrigin="anonymous"
                />
              </div>
            )}
            {watermarkPreviewUrl && (
              <div className="rounded-xl border border-[#cbd5e1] bg-white p-2 admin-dark:border-[#1e3a65] admin-dark:bg-zinc-900">
                <span className="text-[10px] font-bold text-slate-500 admin-dark:text-slate-400">Selected</span>
                <img
                  src={watermarkPreviewUrl}
                  alt="Selected watermark"
                  className="mt-1 block h-14 w-auto max-w-[180px] object-contain"
                />
              </div>
            )}
            {watermarkLoading && (
              <span className="self-center text-xs text-slate-400 admin-dark:text-slate-500">Loading watermark setting…</span>
            )}
            <span className="ml-auto self-center text-xs text-slate-500 admin-dark:text-slate-400">
              {watermarkLogo ? "Watermark active — will appear on all PDFs" : "No watermark — PDFs generate without watermark"}
            </span>
          </div>
          {/* Watermark appearance — applied to every PDF page via the A4 preview */}
          <div className="mt-4 grid gap-3 rounded-xl border border-[#dbeafe] bg-[#f8fafc] p-3 sm:grid-cols-2 lg:grid-cols-4 admin-dark:border-[#1e3a65] admin-dark:bg-[#0a162e]">
            <label className="flex items-center gap-2 text-xs font-bold text-slate-700 admin-dark:text-white">
              <input
                type="checkbox"
                checked={watermarkEnabled}
                onChange={(e) => setWatermarkEnabled(e.target.checked)}
                className="h-4 w-4 accent-[#0b1e3a]"
              />
              Watermark: {watermarkEnabled ? "ON" : "OFF"}
            </label>
            <label className="flex items-center gap-2 text-xs font-bold text-slate-700 admin-dark:text-white">
              Opacity
              <input
                type="range"
                min={2}
                max={30}
                value={watermarkOpacity}
                onChange={(e) => setWatermarkOpacity(parseInt(e.target.value, 10))}
                className="h-1 w-24 accent-[#0b1e3a]"
              />
              <span className="w-10 text-slate-500 admin-dark:text-slate-400">{watermarkOpacity}%</span>
            </label>
            <label className="flex items-center gap-2 text-xs font-bold text-slate-700 admin-dark:text-white">
              Size
              <input
                type="range"
                min={140}
                max={420}
                step={10}
                value={watermarkSize}
                onChange={(e) => setWatermarkSize(parseInt(e.target.value, 10))}
                className="h-1 w-24 accent-[#0b1e3a]"
              />
              <span className="w-14 text-slate-500 admin-dark:text-slate-400">{watermarkSize}px</span>
            </label>
            <label className="flex items-center gap-2 text-xs font-bold text-slate-700 admin-dark:text-white">
              Position
              <select
                value={watermarkPosition}
                onChange={(e) => setWatermarkPosition(e.target.value as "top" | "center" | "bottom")}
                className="rounded-lg border border-[#cbd5e1] bg-white px-2 py-1 text-xs font-bold text-[#0b1e3a] outline-none admin-dark:border-[#1e3a65] admin-dark:bg-[#0f2547] admin-dark:text-white"
              >
                <option value="top">Top</option>
                <option value="center">Center</option>
                <option value="bottom">Bottom</option>
              </select>
            </label>
          </div>
        </div>

        {/* 2. Paste MCQs + 3. Detect & Format */}
        <div className="mt-6 rounded-2xl border border-[#dbeafe] bg-white p-4 sm:p-6 shadow-sm admin-dark:border-[#1e3a65] admin-dark:bg-[#112544]">
          <label className="text-sm font-extrabold text-[#0b1e3a] admin-dark:text-white">3. Paste MCQs (alternative)</label>
          <p className="mt-1 text-xs leading-relaxed text-slate-500 admin-dark:text-[#8da0c0]">
            Paste 10 / 20 / 50 / 100+ MCQs at once. Any numbering (25, 31, 47…) will be auto-renumbered to 1,2,3… Bangla + English mixed, Unicode fully supported.
          </p>
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder={`Paste your questions

Example:
25. Which is the powerhouse of the cell?
A. Nucleus
B. Mitochondria
C. Ribosome
D. Golgi body
Answer: B

31. মানবদেহে লোহিত রক্তকণিকার আয়ুষ্কাল কত দিন?
A. 60 দিন
B. 90 দিন
C. 120 দিন
D. 150 দিন
উত্তর: গ

...`}
            className="bangla mt-3 min-h-[280px] w-full resize-y rounded-xl border border-[#cbd5e1] bg-[#f8fafc] p-4 text-sm leading-relaxed text-slate-800 outline-none placeholder:text-slate-400 focus:border-[#234e9f] focus:bg-white admin-dark:border-[#1e3a65] admin-dark:bg-[#0a162e] admin-dark:text-white"
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={handleDetect}
              disabled={!pasteText.trim()}
              className="rounded-xl bg-[#0b1e3a] px-6 py-2.5 text-sm font-extrabold text-white shadow hover:bg-[#123060] disabled:opacity-40 admin-dark:bg-[#234e9f]"
            >
              Detect & Format
            </button>
            <button
              onClick={handleClear}
              className="rounded-xl border border-[#cbd5e1] bg-white px-4 py-2.5 text-sm font-bold text-slate-700 hover:bg-slate-50 admin-dark:border-[#1e3a65] admin-dark:bg-[#0f2547] admin-dark:text-white"
            >
              Clear
            </button>
            <button
              onClick={handleCopyPaste}
              disabled={!pasteText.trim()}
              className="rounded-xl border border-[#cbd5e1] bg-white px-4 py-2.5 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-40 admin-dark:border-[#1e3a65] admin-dark:bg-[#0f2547] admin-dark:text-white"
            >
              Copy
            </button>
            <span className="ml-auto self-center text-xs text-slate-500 admin-dark:text-slate-400">
              {pasteText.length} chars • Auto renumber 1..N • Detects Ans: / উত্তর: / Correct Answer:
            </span>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-slate-500 admin-dark:text-slate-400">
            Supported answers: <code className="rounded bg-slate-100 px-1">Answer: B</code> <code className="rounded bg-slate-100 px-1">Ans: B</code>{" "}
            <code className="rounded bg-slate-100 px-1">Correct Answer: (B)</code> <code className="rounded bg-slate-100 px-1">Ans. B</code>{" "}
            <code className="rounded bg-slate-100 px-1">উত্তর: খ</code> <code className="rounded bg-slate-100 px-1">উত্তর: গ</code> — if missing, answer stays blank and you can set manually in preview.
          </p>
        </div>

        {/* 5. Editable A4 Preview */}
        {questions.length > 0 && (
          <div className="mt-6 rounded-2xl border border-[#dbeafe] bg-white p-4 sm:p-6 shadow-sm admin-dark:border-[#1e3a65] admin-dark:bg-[#112544]">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-extrabold text-[#0b1e3a] admin-dark:text-white">Editable A4 Preview</h2>
                <p className="mt-1 text-xs text-slate-500 admin-dark:text-[#8da0c0]">
                  Real-time A4 preview = exact PDF layout. Click any question/option to edit. Add images — they stay together with their question and never overflow. Changing text/image updates pagination instantly. Page-specific উত্তরমালা at bottom.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setNewTopicName("");
                    setNewTopicAfterQ(0);
                    setAddTopicModalOpen(true);
                  }}
                  className="rounded-xl bg-[#0b1e3a] px-4 py-1.5 text-xs font-bold text-white shadow hover:bg-[#123060] admin-dark:bg-[#234e9f]"
                >
                  + Add Topic
                </button>
                <button
                  onClick={() => standaloneInputRef.current?.click()}
                  className="rounded-xl bg-emerald-600 px-4 py-1.5 text-xs font-bold text-white hover:bg-emerald-700"
                >
                  + Add Image
                </button>
                <input ref={standaloneInputRef} type="file" accept="image/*" className="hidden" onChange={handleStandaloneImageUpload} />
                <button
                  onClick={handleClear}
                  className="rounded-xl border border-[#cbd5e1] bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50 admin-dark:border-[#1e3a65] admin-dark:bg-[#0f2547] admin-dark:text-white"
                >
                  Reset
                </button>
                <button
                  onClick={() => setPaginateDebugOn((v) => !v)}
                  title="Show pagination debug overlay + console log (available height, per-question heights, remaining space at each break)"
                  className={`rounded-xl px-3 py-1.5 text-xs font-bold ${paginateDebugOn ? "bg-amber-500 text-white" : "border border-[#cbd5e1] bg-white text-slate-700 hover:bg-slate-50 admin-dark:border-[#1e3a65] admin-dark:bg-[#0f2547] admin-dark:text-white"}`}
                >
                  {paginateDebugOn ? "Debug: ON" : "Debug"}
                </button>
              </div>
            </div>

            {/* Image help */}
            <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900 admin-dark:border-amber-900/40 admin-dark:bg-amber-900/20 admin-dark:text-amber-200">
              <span className="font-bold">Image Upload:</span> Manual only — for diagrams/figures/tables. No OCR. Images are inserted between questions or inside a specific question. Resize / Move / Remove available per image. Images never overflow A4 and preserve aspect ratio in PDF.
            </div>

            {/* 11. Editable Line Spacing — ONLY control */}
            <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-[#dbeafe] bg-[#f8fafc] p-3 admin-dark:border-[#1e3a65] admin-dark:bg-[#0a162e]">
              <span className="text-xs font-extrabold text-[#0b1e3a] admin-dark:text-white">Line Spacing</span>
              <div className="flex gap-1.5">
                {(["compact", "normal", "relaxed"] as LineSpacing[]).map((opt) => (
                  <button
                    key={opt as string}
                    onClick={() => setLineSpacing(opt)}
                    className={`rounded-full px-4 py-1.5 text-xs font-bold transition ${
                      lineSpacing === opt
                        ? "bg-[#0b1e3a] text-white shadow admin-dark:bg-[#234e9f]"
                        : "bg-white text-slate-600 hover:bg-slate-100 border border-[#cbd5e1] admin-dark:bg-[#112544] admin-dark:text-[#8da0c0] admin-dark:border-[#1e3a65]"
                    }`}
                  >
                    {opt === "compact" ? "Compact" : opt === "normal" ? "Normal" : "Relaxed"}
                  </button>
                ))}
              </div>
              <span className="text-xs text-slate-500 admin-dark:text-[#8da0c0]">— only spacing control • updates pagination automatically</span>
              <span className="ml-auto text-xs text-slate-500 admin-dark:text-slate-400 hidden sm:inline">{spacingLabel} • {lineHeightStyle.toFixed(2)}x</span>
            </div>
          </div>
        )}

        {/* A4 Pages Preview — scale-to-fit on phones, full 794px for PDF capture */}
        {questions.length > 0 ? (
          <div
            ref={previewRef}
            className="mt-6 flex flex-col items-center gap-8 overflow-x-auto bg-[#525659] p-4 py-6 sm:rounded-2xl sm:p-8"
            style={{ background: "#525659" }}
          >
            {pages.map((page) => {
              const effScale = captureClean ? 1 : previewScale;
              const measuredH = pageHeights[page.pageNumber] ?? A4_PREVIEW_H;
              return (
              <Fragment key={page.pageNumber}>
                {paginateDebugOn && (() => {
                  const info = debug.pages.find((d) => d.page === page.pageNumber);
                  if (!info) return null;
                  return (
                    <div
                      data-html2canvas-ignore="true"
                      className="w-full max-w-[794px] rounded-xl border border-amber-400 bg-amber-50 px-4 py-2 text-[11px] leading-relaxed text-amber-900"
                    >
                      <span className="font-extrabold">Page {page.pageNumber} pagination</span>
                      {` — available ${Math.round(info.capacityH)}px (col ${Math.round(info.columnBudgetH)}px each) • used ${Math.round(info.usedH)}px [L ${Math.round(info.colUsedH[0])} / R ${Math.round(info.colUsedH[1])}] • remaining ${Math.round(info.remainingH)}px • fill ${(info.fillRatio * 100).toFixed(1)}%`}
                      <span className="mt-1 block font-mono">
                        {info.items.map((it) => `${it.column === 0 ? "L" : "R"}${it.qNumber ?? "img"}:${Math.round(it.height)}${it.topicHeader ? "+T" : ""}`).join("  ")}
                      </span>
                    </div>
                  );
                })()}
              {/* Display wrapper: shrinks layout box on phones so the full page
                  stays visible. The .a4-page inside keeps true 794px width for capture. */}
              <div
                style={
                  effScale < 1
                    ? { width: A4_PREVIEW_W * effScale, height: measuredH * effScale, flexShrink: 0 }
                    : { flexShrink: 0 }
                }
              >
              <div
                key={page.pageNumber}
                ref={pageRefCallbacks.get(page.pageNumber)}
                className="a4-page relative flex w-full max-w-[794px] flex-col bg-white shadow-[0_8px_40px_rgba(0,0,0,.35)]"
                style={{
                  width: "210mm",
                  minHeight: "297mm",
                  padding: "10mm 12mm 10mm 12mm",
                  fontFamily: "'Hind Siliguri','Noto Sans Bengali',sans-serif",
                  zIndex: 0,
                  ...(effScale < 1
                    ? { transform: `scale(${effScale})`, transformOrigin: "top left" }
                    : undefined),
                }}
              >
                {watermarkEnabled && watermarkLogo && (
                  <img
                    src={watermarkLogo}
                    alt=""
                    aria-hidden="true"
                    className={
                      watermarkPosition === "top"
                        ? "absolute left-1/2 top-[16%] -translate-x-1/2"
                        : watermarkPosition === "bottom"
                          ? "absolute bottom-[16%] left-1/2 -translate-x-1/2"
                          : "absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
                    }
                    style={{
                      width: `${watermarkSize}px`,
                      maxWidth: "60%",
                      height: "auto",
                      opacity: watermarkOpacity / 100,
                      zIndex: -1,
                      pointerEvents: "none",
                    }}
                    crossOrigin="anonymous"
                  />
                )}
                {/* 2. Top Header — compact, consistent every page. Keep together, never split. */}
                <div className="keep-together flex items-center justify-between gap-3 text-[10px] font-bold text-slate-700"
                  style={{ breakInside: "avoid", pageBreakInside: "avoid" } as React.CSSProperties}>
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <span
                      className="bangla cursor-text min-w-0 break-words text-[11px] font-extrabold text-[#0b1e3a] outline-none focus:bg-yellow-50 focus:ring-1 focus:ring-amber-300 rounded px-1"
                      contentEditable
                      suppressContentEditableWarning
                      style={{ overflow: "visible", whiteSpace: "normal", textOverflow: "clip", lineHeight: 1.5 } as React.CSSProperties}
                      onBlur={(e) => {
                        const txt = (e.currentTarget.innerText || "").trim();
                        if (txt) setMaterialName(txt);
                      }}
                      title="Click to edit Material Name (updates across all pages)"
                    >
                      {materialName.trim() || "SSC Academic Biology"}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="font-mono text-[11px] font-black text-[#0b1e3a]">
                      {String(page.pageNumber).padStart(2, "0")}
                    </span>
                  </div>
                </div>
                <div className="mt-1 border-b border-dotted border-slate-400 opacity-70" style={{ borderBottomStyle: "dotted", height: 1 }} />

                {/* 3. First Page Only — Large Introductory Title Header. Keep together. */}
                {page.pageNumber === 1 && (
                  <div className="keep-together mt-2.5 mb-2 rounded-xl border border-slate-200 bg-[#f8fafc] py-2.5 px-4 text-center"
                    style={{ breakInside: "avoid", pageBreakInside: "avoid" } as React.CSSProperties}>
                    <h1
                      className="bangla cursor-text text-base font-black tracking-tight text-[#0b1e3a] outline-none focus:bg-yellow-50 focus:ring-1 focus:ring-amber-300 rounded px-1"
                      contentEditable
                      suppressContentEditableWarning
                      onBlur={(e) => {
                        const txt = (e.currentTarget.innerText || "").trim();
                        if (txt) setMaterialName(txt);
                      }}
                      title="Click to edit Material Name"
                    >
                      {materialName.trim() || "SSC Academic Biology"}
                    </h1>
                    <p
                      className="bangla mt-0.5 cursor-text text-[11px] font-bold text-slate-500 outline-none focus:bg-yellow-50 focus:ring-1 focus:ring-amber-300 rounded px-1"
                      contentEditable
                      suppressContentEditableWarning
                      onBlur={(e) => {
                        const txt = (e.currentTarget.innerText || "").trim();
                        setSubtitle(txt);
                      }}
                      title="Click to edit Subtitle"
                    >
                      {subtitle || "MCQ Practice Material"}
                    </p>
                  </div>
                )}

                {/* 4 & 5. Two-Column Page Layout with vertical center divider */}
                <div className="relative mt-2.5 flex flex-1 gap-[18px]">
                  {page.columns.map((colBlocks, ci) => (
                    <Fragment key={ci}>
                      {ci === 1 && (
                        <div aria-hidden="true" className="w-px shrink-0 self-stretch bg-[#1e293b]" />
                      )}
                      <div className="min-w-0 flex-1">
                  {/* Blocks: questions + standalone images interleaved already via pagination */}
                  {colBlocks.map((q, qi) => {
                    const prevInCol = qi === 0 ? null : colBlocks[qi - 1];
                    const prevTopic = prevInCol
                      ? (prevInCol.isStandaloneImage ? "" : (prevInCol.topic ?? ""))
                      : ci === 1
                        ? (page.columns[0].slice(-1)[0]?.isStandaloneImage ? "" : (page.columns[0].slice(-1)[0]?.topic ?? ""))
                        : page.pageNumber === 1
                          ? ""
                          : (pages[page.pageNumber - 2]?.questions.slice(-1)[0]?.isStandaloneImage ? "" : (pages[page.pageNumber - 2]?.questions.slice(-1)[0]?.topic ?? ""));
                    const showTopic =
                      !q.isStandaloneImage &&
                      !!q.topic?.trim() &&
                      (page.pageNumber === 1 && ci === 0 && qi === 0 ? true : prevTopic !== q.topic);
                    return (
                      <Fragment key={q.id}>
                        {showTopic && (
                          <div
                            className="bangla mb-2.5 break-inside-avoid rounded-lg border bg-[#0b1e3a] px-3 py-1.5 text-white flex items-center justify-between gap-2"
                            style={{ breakInside: "avoid", pageBreakInside: "avoid", WebkitColumnBreakInside: "avoid", backgroundColor: "#0b1e3a", borderColor: "#24365a", color: "#ffffff", boxShadow: "0 1px 2px rgba(11,30,58,0.25)" } as React.CSSProperties}
                          >
                            <div className="flex items-center gap-1.5 min-w-0 flex-1">
                              <span className="flex shrink-0 items-center text-[9px] font-black uppercase leading-none tracking-wider"
                                style={{ color: "#fcd34d" }}>
                                TOPIC:
                              </span>
                              <span
                                className="cursor-text text-[11px] font-extrabold min-w-0 break-words outline-none focus:bg-white/20 focus:ring-1 focus:ring-white/50 rounded px-1"
                                contentEditable
                                suppressContentEditableWarning
                                style={{ overflow: "visible", whiteSpace: "normal", textOverflow: "clip", lineHeight: 1.5 } as React.CSSProperties}
                                onBlur={(e) => {
                                  const txt = (e.currentTarget.innerText || "").trim();
                                  if (txt && txt !== q.topic) handleRenameTopic(q.topic ?? "", txt);
                                  else e.currentTarget.innerText = q.topic ?? "";
                                }}
                                title="Click to rename topic (updates whole group)"
                              >
                                {q.topic}
                              </span>
                            </div>
                            <div className="flex shrink-0 items-center gap-1 pdf-hide" data-html2canvas-ignore="true">
                              <button
                                type="button"
                                onClick={() => handleMoveTopic(q.topic ?? "", -1)}
                                title="Move topic up (with all its MCQs)"
                                className="rounded px-1.5 py-0.5 text-[9px] font-bold text-white transition"
                                style={{ backgroundColor: "rgba(255,255,255,0.12)" }}
                              >
                                ↑
                              </button>
                              <button
                                type="button"
                                onClick={() => handleMoveTopic(q.topic ?? "", 1)}
                                title="Move topic down (with all its MCQs)"
                                className="rounded px-1.5 py-0.5 text-[9px] font-bold text-white transition"
                                style={{ backgroundColor: "rgba(255,255,255,0.12)" }}
                              >
                                ↓
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDeleteTopic(q.topic ?? "")}
                                title="Delete topic header (MCQs remain)"
                                className="rounded px-1.5 py-0.5 text-[9px] font-bold transition"
                                style={{ backgroundColor: "rgba(239,68,68,0.35)", color: "#fecaca" }}
                              >
                                ×
                              </button>
                            </div>
                          </div>
                        )}
                        {q.isStandaloneImage ? (
                      <div
                        key={q.id}
                        className="mb-3 break-inside-avoid rounded border border-[#cbd5e1] bg-[#f8fafc] p-2"
                        style={{ breakInside: "avoid", pageBreakInside: "avoid", WebkitColumnBreakInside: "avoid" } as React.CSSProperties}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[9px] font-bold text-slate-500">Image Block</span>
                          <div className="flex gap-1 pdf-hide" data-html2canvas-ignore="true">
                            <button onClick={() => handleMoveBlock(q.id, -1)} className="rounded border bg-white px-1 py-0.5 text-[9px] font-bold hover:bg-slate-50">↑</button>
                            <button onClick={() => handleMoveBlock(q.id, 1)} className="rounded border bg-white px-1 py-0.5 text-[9px] font-bold hover:bg-slate-50">↓</button>
                            <button onClick={() => handleDelete(q.id)} className="rounded border border-red-200 bg-white px-1 py-0.5 text-[9px] font-bold text-red-600 hover:bg-red-50">Remove</button>
                          </div>
                        </div>
                        {q.image?.dataUrl && (
                          <div className="mt-2">
                            <img
                              src={q.image.dataUrl}
                              alt={q.image.name || "uploaded"}
                              className="mx-auto block rounded border border-slate-200 bg-white"
                              style={{
                                width: `${q.image.widthPercent ?? 100}%`,
                                maxWidth: "100%",
                                height: "auto",
                                maxHeight: "280px",
                                objectFit: "contain",
                              }}
                            />
                            <div className="mt-2 flex flex-wrap items-center gap-2 pdf-hide" data-html2canvas-ignore="true">
                              <span className="text-[9px] font-bold text-slate-500">Size:</span>
                              {[30, 50, 70, 100].map((w) => (
                                <button
                                  key={w}
                                  onClick={() => handleResizeImage(q.id, w)}
                                  className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${ (q.image?.widthPercent ?? 100) === w ? "bg-[#0b1e3a] text-white" : "bg-white border border-[#cbd5e1] text-slate-600 hover:bg-slate-50"}`}
                                >
                                  {w}%
                                </button>
                              ))}
                              <input
                                type="range"
                                min={30}
                                max={100}
                                value={q.image.widthPercent ?? 100}
                                onChange={(e) => handleResizeImage(q.id, parseInt(e.target.value, 10))}
                                className="ml-2 h-1 w-20 accent-[#0b1e3a]"
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div
                        key={q.id}
                        className="mb-3 break-inside-avoid rounded-[2px] p-1"
                        style={{ breakInside: "avoid", pageBreakInside: "avoid", WebkitColumnBreakInside: "avoid" } as React.CSSProperties}
                      >
                        {/* Question text Bold — automatic continuous numbering */}
                        <div className="flex gap-1.5">
                          <span className="shrink-0 text-[11px] font-bold text-[#0f172a]">{q.qNumber}.</span>
                          <span
                            className="bangla min-w-0 flex-1 cursor-text text-[11px] font-bold leading-[1.7] text-[#0f172a] outline-none [overflow-wrap:anywhere] focus:bg-yellow-50 focus:ring-1 focus:ring-amber-300 rounded px-0.5"
                            contentEditable
                            suppressContentEditableWarning
                            onBlur={(e) => {
                              // Ignore the "[Empty — click to edit]" placeholder: when the
                              // stem is empty the placeholder text becomes the element's
                              // innerText — saving it would persist "[Empty…]" as real data.
                              const raw = (e.currentTarget.innerText || "").trim();
                              const txt = raw === "" || raw.startsWith("[Empty") ? "" : raw;
                              if (txt !== q.question) handleUpdate(q.id, { question: txt });
                            }}
                            title="Click to edit question (bold in PDF) — statements (1. 2. 3.) remain with question as one block"
                            style={{ lineHeight: `${lineHeightStyle * 1.1}`, whiteSpace: "pre-line" } as React.CSSProperties}
                          >
                            {q.question || <span className="text-red-400 font-normal">[Empty — click to edit]</span>}
                          </span>
                          <div className="flex max-w-full shrink-0 flex-wrap justify-end gap-1 pdf-hide" data-html2canvas-ignore="true">
                            <button
                              type="button"
                              onClick={() => {
                                const qBefore = q.qNumber > 1 ? q.qNumber - 1 : 0;
                                setNewTopicAfterQ(qBefore);
                                setNewTopicName("");
                                setAddTopicModalOpen(true);
                              }}
                              title={`Add Topic starting at Question ${q.qNumber}`}
                              className="rounded border border-indigo-200 bg-indigo-50 px-1 py-0.5 text-[9px] font-bold text-indigo-700 hover:bg-indigo-100"
                            >
                              + Topic
                            </button>
                            <button onClick={() => handleMoveBlock(q.id, -1)} title="Move up" className="rounded border bg-white px-1 py-0.5 text-[9px] font-bold hover:bg-slate-50">↑</button>
                            <button onClick={() => handleMoveBlock(q.id, 1)} title="Move down" className="rounded border bg-white px-1 py-0.5 text-[9px] font-bold hover:bg-slate-50">↓</button>
                            <button
                              onClick={() => handleDelete(q.id)}
                              title="Delete question"
                              className="rounded border border-red-200 px-1 py-0.5 text-[9px] font-bold text-red-600 hover:bg-red-50"
                              style={{ height: 18 }}
                            >
                              ×
                            </button>
                          </div>
                        </div>
                        {/* Question-attached image (optional, stays together with question+options) */}
                        {q.image?.dataUrl ? (
                          <div className="mt-2 pl-5">
                            <img
                              src={q.image.dataUrl}
                              alt={q.image.name || "question image"}
                              className="mx-auto block rounded border border-slate-200 bg-white"
                              style={{
                                width: `${q.image.widthPercent ?? 100}%`,
                                maxWidth: "100%",
                                height: "auto",
                                maxHeight: "260px",
                                objectFit: "contain",
                              }}
                            />
                            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pdf-hide" data-html2canvas-ignore="true">
                              <span className="text-[9px] font-bold text-slate-500">Image:</span>
                              {[30, 50, 70, 100].map((w) => (
                                <button
                                  key={w}
                                  onClick={() => handleResizeImage(q.id, w)}
                                  className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${ (q.image?.widthPercent ?? 100) === w ? "bg-[#0b1e3a] text-white" : "bg-white border border-[#cbd5e1] text-slate-600 hover:bg-slate-50"}`}
                                >
                                  {w}%
                                </button>
                              ))}
                              <input
                                type="range"
                                min={30}
                                max={100}
                                value={q.image.widthPercent ?? 100}
                                onChange={(e) => handleResizeImage(q.id, parseInt(e.target.value, 10))}
                                className="h-1 w-16 accent-[#0b1e3a]"
                              />
                              <button onClick={() => handleRemoveImage(q.id)} className="rounded border border-red-200 bg-white px-2 py-0.5 text-[9px] font-bold text-red-600 hover:bg-red-50">Remove</button>
                            </div>
                          </div>
                        ) : (
                          <div className="mt-1 pl-5 pdf-hide" data-html2canvas-ignore="true">
                            <button
                              onClick={() => questionFileRefs.current.get(q.id)?.click()}
                              className="rounded-full border border-dashed border-[#cbd5e1] bg-white px-2 py-1 text-[10px] font-bold text-slate-600 hover:bg-slate-50"
                            >
                              + Add Image to this question
                            </button>
                            <input
                              ref={questionFileRefCallbacks.get(q.id)}
                              type="file"
                              accept="image/*"
                              className="hidden"
                              onChange={(e) => handleQuestionImageUpload(q.id, e)}
                            />
                            <button onClick={() => handleInsertStandaloneAfter(q.id)} className="ml-2 rounded-full border border-[#cbd5e1] bg-white px-2 py-1 text-[10px] font-bold text-slate-600 hover:bg-slate-50">
                              + Insert image after
                            </button>
                          </div>
                        )}
                        {/* Options Regular */}
                        <div className="bangla mt-1.5 grid gap-0.5 pl-5 text-[11px] font-normal leading-[1.6] text-[#1e293b]">
                          {(["A", "B", "C", "D"] as const).map((ltr, idx) => (
                            <div key={ltr} className="flex gap-1.5">
                              <span className="shrink-0 font-semibold">{ltr}.</span>
                              <span
                                className="min-w-0 flex-1 cursor-text font-normal outline-none [overflow-wrap:anywhere] focus:bg-yellow-50 focus:ring-1 focus:ring-amber-300 rounded px-0.5"
                                contentEditable
                                suppressContentEditableWarning
                                onBlur={(e) => {
                                  // Ignore the "[Empty]" placeholder (see question stem).
                                  const raw = (e.currentTarget.textContent || "").trim();
                                  const txt = raw === "" || raw.startsWith("[Empty") ? "" : raw;
                                  if (txt !== q.options[idx]) {
                                    const next = [...q.options] as [string, string, string, string];
                                    next[idx] = txt;
                                    handleUpdate(q.id, { options: next });
                                  }
                                }}
                                title={`Click to edit Option ${ltr}`}
                                style={{ lineHeight: `${lineHeightStyle}` }}
                              >
                                {q.options[idx] || <span className="text-red-400">[Empty]</span>}
                              </span>
                            </div>
                          ))}
                        </div>
                        {/* Correct Answer inline editor — hidden in PDF, only for editing */}
                        <div className="mt-1 flex items-center gap-1.5 pl-5 pdf-hide" data-html2canvas-ignore="true">
                          <span className="text-[9px] font-bold text-slate-500">Ans:</span>
                          <select
                            value={q.answer}
                            onChange={(e) => handleAnswerChange(q.id, e.target.value)}
                            className="rounded border border-[#cbd5e1] bg-white px-1 py-0.5 text-[11px] font-bold text-[#0b1e3a] outline-none focus:border-[#234e9f]"
                            style={{ minWidth: 44 }}
                          >
                            <option value="">—</option>
                            <option value="A">A</option>
                            <option value="B">B</option>
                            <option value="C">C</option>
                            <option value="D">D</option>
                          </select>
                          <span className="text-[9px] text-slate-400">editable — updates Answer Box</span>
                        </div>
                        </div>
                      )}
                      </Fragment>
                    );
                  })}
                      </div>
                    </Fragment>
                  ))}
                  {page.questions.length === 0 && (
                    <p className="py-10 text-center text-sm text-slate-400">No questions</p>
                  )}
                </div>

                {/* 15. Answer Box — bottom of every page, bordered. Never split across pages. */}
                <div className="keep-together mt-auto pt-3"
                  style={{ breakInside: "avoid", pageBreakInside: "avoid" } as React.CSSProperties}>
                  <div className="rounded-[6px] border border-[#0f172a] bg-white overflow-hidden">
                    <div className="border-b border-[#0f172a] bg-[#f8fafc] py-1 px-3 flex items-center justify-between">
                      <span className="bangla text-[10px] font-extrabold tracking-wider text-[#0b1e3a]">
                        ANSWER KEY / উত্তরমালা
                      </span>
                      {page.questions.filter((q) => !q.isStandaloneImage).length > 0 && (
                        <span className="text-[9px] font-bold text-slate-500">
                          Q{page.questions.filter((q) => !q.isStandaloneImage)[0].qNumber}–Q{page.questions.filter((q) => !q.isStandaloneImage).slice(-1)[0].qNumber}
                        </span>
                      )}
                    </div>
                    {page.questions.filter((q) => !q.isStandaloneImage).length === 0 ? (
                      <div className="px-3 py-2 text-center text-xs text-slate-400">—</div>
                    ) : (
                      <div className="p-2">
                        <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-center">
                          {page.questions
                            .filter((q) => !q.isStandaloneImage)
                            .map((q) => (
                              <span key={`num-${q.id}`} className="min-w-[24px] text-[11px] font-normal text-slate-700">
                                {String(q.qNumber).padStart(2, "0")}
                              </span>
                            ))}
                        </div>
                        <div className="mt-1 flex flex-wrap justify-center gap-x-4 gap-y-1 text-center border-t border-dashed border-slate-200 pt-1">
                          {page.questions
                            .filter((q) => !q.isStandaloneImage)
                            .map((q) => (
                              <span key={`ans-${q.id}`} className="min-w-[24px] text-[11px] font-bold text-[#0b1e3a]">
                                {q.answer?.trim() ? q.answer.trim().toUpperCase() : "—"}
                              </span>
                            ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* 21. Marketing Footer — consistent on all pages. Never split. */}
                <div className="keep-together mt-2 pt-2 border-t border-slate-200"
                  style={{ breakInside: "avoid", pageBreakInside: "avoid" } as React.CSSProperties}>
                  <div className="flex items-center gap-3">
                    <div className="flex shrink-0 items-center justify-center rounded px-3 py-1.5 text-center text-[9px] font-black leading-none tracking-wider text-white"
                      style={{ backgroundColor: "#0b1e3a" }}>
                      MEDISPARK ACADEMIC &amp; ADMISSION CARE
                    </div>
                    <div className="flex-1 border-b border-dotted border-slate-400 opacity-70" style={{ borderBottomStyle: "dotted", height: 1 }} />
                  </div>
                </div>
                </div>
              </div>
              </Fragment>
              );
              })}
          </div>
        ) : (
          <div className="mt-6 rounded-2xl border border-dashed border-[#cbd5e1] bg-white p-10 text-center admin-dark:border-[#1e3a65] admin-dark:bg-[#112544]">
            <p className="text-sm font-bold text-slate-600 admin-dark:text-[#8da0c0]">No preview yet</p>
            <p className="mt-1 text-xs text-slate-400">Paste MCQs above and click Detect & Format to see editable A4 preview</p>
          </div>
        )}

        {/* 16. Save as Draft + 17. Download */}
        {questions.length > 0 && (
          <>
            {generateError && (
              <div className="mt-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700 admin-dark:border-red-900/40 admin-dark:bg-red-900/20 admin-dark:text-red-300">
                {generateError}
              </div>
            )}
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <button
                onClick={handleSaveDraft}
                disabled={generating || draftSaving}
                className="rounded-xl bg-[#0b1e3a] px-8 py-3 text-sm font-extrabold text-white shadow hover:bg-[#123060] disabled:opacity-40 admin-dark:bg-[#234e9f]"
                title={draftSaving ? "Saving draft…" : draftId !== null ? `Update server draft #${draftId}` : "Save as Draft on the server (editable later)"}
              >
                {draftSaving ? "Saving Draft…" : draftId !== null ? `Update Draft #${draftId}` : "Save as Draft"}
              </button>
              <button
                onClick={handleDownloadPdf}
                disabled={generating || draftSaving}
                className="rounded-xl border border-[#cbd5e1] bg-white px-6 py-3 text-sm font-bold text-[#0b1e3a] hover:bg-slate-50 disabled:opacity-40 admin-dark:border-[#1e3a65] admin-dark:bg-[#0f2547] admin-dark:text-white"
                title={generating ? "Building PDF…" : "Download PDF to your device (removes the server draft after success)"}
              >
                {generating && buildProgress && buildProgress.total > 0
                  ? `Building ${Math.round((buildProgress.done / buildProgress.total) * 100)}%`
                  : generating
                    ? "Building PDF…"
                    : "Download PDF"}
              </button>
              {draftId !== null && (
                <button
                  onClick={() => void handleDeleteDraft(draftId)}
                  disabled={generating || draftSaving || draftBusy !== null}
                  className="rounded-xl border border-red-200 bg-white px-6 py-3 text-sm font-bold text-red-600 hover:bg-red-50 disabled:opacity-40 admin-dark:border-red-900/40 admin-dark:bg-transparent admin-dark:text-red-300 admin-dark:hover:bg-red-500/10"
                  title={`Delete server draft #${draftId} permanently (local preview stays)`}
                >
                  {draftBusy === `delete-${draftId}` ? "Deleting…" : `Delete Draft #${draftId}`}
                </button>
              )}
            </div>
            {generating && buildProgress && buildProgress.total > 0 && (
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={buildProgress.total}
                aria-valuenow={buildProgress.done}
                aria-label="Building PDF"
                className="mx-auto mt-3 max-w-md space-y-1"
              >
                <div className="h-2 w-full overflow-hidden rounded-full bg-[#dbeafe] admin-dark:bg-[#1e3a65]">
                  <div
                    className="h-full rounded-full bg-[#0b1e3a] transition-[width] duration-300 admin-dark:bg-[#3b82f6]"
                    style={{ width: `${Math.round((buildProgress.done / buildProgress.total) * 100)}%` }}
                  />
                </div>
                <p className="text-center text-[11px] font-bold text-slate-600 admin-dark:text-slate-300">
                  Building PDF… page {Math.min(buildProgress.done + 1, buildProgress.total)}/{buildProgress.total} ({Math.round((buildProgress.done / buildProgress.total) * 100)}%)
                  {buildProgress.total > 10 ? " — keep this tab open" : ""}
                </p>
              </div>
            )}
            {pdfReady && !generating ? (
              <p className="mt-2 text-center text-xs font-semibold text-emerald-700 admin-dark:text-emerald-300">
                ✓ PDF ready{draftId !== null ? ` + draft #${draftId} saved on server` : ""} — click Download PDF to save {sanitizeFileName(materialName)}.pdf to your device
                {draftId !== null ? " (the server draft is removed after a successful download)" : ""}
              </p>
            ) : !pdfReady && !generating && questions.length > 0 ? (
              <p className="mt-2 text-center text-xs text-slate-500 admin-dark:text-[#8da0c0]">
                Tip: Save as Draft keeps your work on the server (editable later) — Download builds the file and removes the draft
              </p>
            ) : null}
          </>
        )}

        <p className="mt-6 text-center text-xs text-slate-400 admin-dark:text-[#8da0c0]">
          MediSpark Material PDF Generator • Focused tool: Material Name → Paste → Detect & Format → Edit → Save as Draft → Download • Two-column A4 • Professional print-ready • Images manual only (no OCR)
        </p>
      </div>

      {addTopicModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl admin-dark:bg-[#112544] border border-slate-200 admin-dark:border-[#1e3a65]">
            <h3 className="text-base font-extrabold text-[#0b1e3a] admin-dark:text-white">
              Add Topic Header
            </h3>
            <p className="mt-1 text-xs text-slate-500 admin-dark:text-[#8da0c0]">
              Insert a Topic Header to group MCQs topic-wise with automatic continuous numbering.
            </p>

            <div className="mt-4 space-y-3">
              <div>
                <label className="text-xs font-bold text-slate-700 admin-dark:text-white">
                  Topic Name
                </label>
                <input
                  type="text"
                  value={newTopicName}
                  onChange={(e) => setNewTopicName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      if (!newTopicName.trim()) {
                        setToast("Please enter a topic name");
                        return;
                      }
                      handleAddTopic(newTopicName.trim(), newTopicAfterQ);
                      setAddTopicModalOpen(false);
                    }
                  }}
                  placeholder="e.g. Genetics, Cell Biology, মানব শারীরতত্ত্ব"
                  className="bangla mt-1 w-full rounded-xl border border-slate-300 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-900 outline-none focus:border-[#234e9f] focus:bg-white admin-dark:border-[#1e3a65] admin-dark:bg-[#0a162e] admin-dark:text-white"
                  autoFocus
                />
              </div>

              <div>
                <label className="text-xs font-bold text-slate-700 admin-dark:text-white">
                  Add Topic After Question:
                </label>
                <select
                  value={newTopicAfterQ}
                  onChange={(e) => setNewTopicAfterQ(parseInt(e.target.value, 10))}
                  className="mt-1 w-full rounded-xl border border-slate-300 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-900 outline-none focus:border-[#234e9f] focus:bg-white admin-dark:border-[#1e3a65] admin-dark:bg-[#0a162e] admin-dark:text-white"
                >
                  <option value={0}>At the beginning (Before Question 1)</option>
                  {questions
                    .filter((q) => !q.isStandaloneImage)
                    .map((q) => (
                      <option key={q.id} value={q.qNumber}>
                        After Question {q.qNumber}: {q.question ? q.question.slice(0, 35) : `Question ${q.qNumber}`}
                      </option>
                    ))}
                </select>
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setAddTopicModalOpen(false)}
                className="rounded-xl border border-slate-300 px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50 admin-dark:border-[#1e3a65] admin-dark:text-white"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!newTopicName.trim()) {
                    setToast("Please enter a topic name");
                    return;
                  }
                  handleAddTopic(newTopicName.trim(), newTopicAfterQ);
                  setAddTopicModalOpen(false);
                }}
                className="rounded-xl bg-[#0b1e3a] px-5 py-2 text-xs font-extrabold text-white shadow hover:bg-[#123060] admin-dark:bg-[#234e9f]"
              >
                Add Topic
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-slate-900 px-5 py-2.5 text-sm font-bold text-white shadow-xl admin-dark:bg-white admin-dark:text-slate-900">
          {toast}
        </div>
      )}
    </div>
  );
}
