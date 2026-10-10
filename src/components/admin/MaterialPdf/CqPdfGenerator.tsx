"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { capturePageRect, fixHtml2CanvasTextBaseline, sanitizeClonedColorsForHtml2Canvas } from "./pdf-capture";

/**
 * CQ PDF Generator — Creative Questions (সৃজনশীল).
 * Material Name → Paste CQs → Detect & Format → Editable single-column
 * A4 Preview → Generate PDF → Download. The final PDF is captured from the
 * edited preview DOM, so every edit is reflected in the output.
 */

export type CqPart = {
  id: string;
  label: string;
  text: string;
  marks: string;
};

export type CqItem = {
  id: string;
  number: number;
  stem: string;
  parts: CqPart[];
  image: { dataUrl: string; name?: string; widthPercent?: number } | null;
};

const PART_LABELS = ["ক", "খ", "গ", "ঘ", "ঙ", "চ"];

function uid(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

function sanitizeFileName(name: string): string {
  const raw = (name || "MediSpark-CQ").trim();
  let s = raw.replace(/[<>:"/\\|?*\x00-\x1F]/g, "").replace(/^\.+/, "");
  s = s.replace(/\s+/g, "_").replace(/__+/g, "_").replace(/^_+|_+$/g, "");
  if (!s) s = "MediSpark-CQ";
  s = s.slice(0, 60).replace(/_+$/g, "");
  if (!s) s = "MediSpark-CQ";
  return s;
}

const PART_LINE_RE = /^\s*([কখগঘঙচABCDabcd])\s*[).:ঃ\-–]\s*(.*?)\s*$/;
const BLOCK_START_RE = /^\s*(\d+|[০-৯]+)\s*[.)।:]\s*(.*)$/;
const MARKS_RE = /[\[\(（]\s*(\d+)\s*(?:marks?|mark|নম্বর)?\s*[\]\)）]\s*$/i;
const MARKS_TAIL_RE = /\s*(\d+)\s*নম্বর\s*$/;

const CQ_BN_DIGIT_MAP: Record<string, string> = { "০": "0", "১": "1", "২": "2", "৩": "3", "৪": "4", "৫": "5", "৬": "6", "৭": "7", "৮": "8", "৯": "9" };

function cqBlockNumber(raw: string): number | null {
  const t = raw.trim();
  if (/^\d+$/.test(t)) {
    const n = parseInt(t, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  if (/^[০-৯]+$/.test(t)) {
    const ascii = t.replace(/[০-৯]/g, (ch) => CQ_BN_DIGIT_MAP[ch] ?? ch);
    const n = parseInt(ascii, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

function parsePartLine(line: string, fallbackLabel: string): CqPart {
  const m = line.match(PART_LINE_RE);
  const label = m ? m[1].trim() : fallbackLabel;
  let text = m ? m[2].trim() : line.trim();
  let marks = "";
  const bm = text.match(MARKS_RE);
  if (bm) {
    marks = bm[1];
    text = text.slice(0, bm.index).trim();
  } else {
    const tm = text.match(MARKS_TAIL_RE);
    if (tm) {
      marks = tm[1];
      text = text.slice(0, tm.index).trim();
    }
  }
  return { id: uid("p"), label, text, marks };
}

/**
 * Detect CQs from pasted text. Blocks start with `1.`, `২।`, `3:` …
 * Part lines start with ক) খ) গ) ঘ) (or A-D, mapped to ক-ঘ).
 * Leading non-part lines become the stem (উদ্দীপক + stem).
 */
export function parsePastedCqs(raw: string): CqItem[] {
  const labelMap: Record<string, string> = { A: "ক", B: "খ", C: "গ", D: "ঘ", a: "ক", b: "খ", c: "গ", d: "ঘ" };
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of raw.split("\n")) {
    if (BLOCK_START_RE.test(line) && current.some((l) => l.trim())) {
      blocks.push(current);
      current = [];
    }
    current.push(line);
  }
  if (current.some((l) => l.trim())) blocks.push(current);

  const items: CqItem[] = [];
  blocks.forEach((lines, bi) => {
    const first = lines[0] ?? "";
    const bm = first.match(BLOCK_START_RE);
    const number = bm ? (cqBlockNumber(bm[1]) ?? bi + 1) : bi + 1;
    const rest = bm ? [bm[2], ...lines.slice(1)] : lines;
    const stemLines: string[] = [];
    const partLines: string[] = [];
    for (const line of rest) {
      if (!line.trim()) continue;
      if (PART_LINE_RE.test(line)) partLines.push(line);
      else if (partLines.length === 0) stemLines.push(line);
      else partLines.push(line);
    }
    const parts = partLines.map((line, pi) =>
      parsePartLine(line, PART_LABELS[pi] ?? `(${pi + 1})`),
    );
    const stem = stemLines.join("\n").trim();
    if (!stem && parts.length === 0) return;
    items.push({
      id: uid("cq"),
      number: Number.isFinite(number) ? number : bi + 1,
      stem,
      parts: parts.map((p) => ({ ...p, label: labelMap[p.label] ?? p.label })),
      image: null,
    });
  });
  // Renumber sequentially 1..N preserving order.
  return renumberCqItems(items);
}

/** Preserve user-edited numbers: keep existing unique positive numbers, only
 *  fill missing/duplicates sequentially. Never clobbers intentional edits. */
function renumberCqItems(list: CqItem[]): CqItem[] {
  const seen = new Set<number>();
  return list.map((item, idx) => {
    const n = item.number;
    if (Number.isInteger(n) && n > 0 && !seen.has(n)) {
      seen.add(n);
      return item;
    }
    let fallback = idx + 1;
    while (seen.has(fallback)) fallback += 1;
    seen.add(fallback);
    return { ...item, number: fallback };
  });
}

// ── Pagination (single column A4) ──
const CQ_PAGE_CAPACITY = 900;

function estimateCqHeight(item: CqItem): number {
  const stemLines = item.stem
    ? item.stem.split("\n").reduce((acc, seg) => acc + Math.max(1, Math.ceil((seg.trim().length || 1) / 85)), 0)
    : 1;
  let h = stemLines * 20 + 26;
  for (const part of item.parts) {
    const len = part.text?.length ?? 0;
    h += Math.max(1, Math.ceil(Math.max(len, 1) / 85)) * 18 + 10;
  }
  if (item.image?.dataUrl) {
    const w = item.image.widthPercent ?? 100;
    h += Math.round((200 * w) / 100) + 16;
  }
  return h + 24;
}

type CqPage = { pageNumber: number; items: CqItem[] };

function paginateCqs(items: CqItem[]): CqPage[] {
  if (items.length === 0) return [{ pageNumber: 1, items: [] }];
  const pages: CqPage[] = [];
  let current: CqItem[] = [];
  let curH = 0;
  for (const item of items) {
    const h = estimateCqHeight(item);
    if (curH + h > CQ_PAGE_CAPACITY && current.length > 0) {
      pages.push({ pageNumber: pages.length + 1, items: current });
      current = [item];
      curH = h;
    } else {
      current.push(item);
      curH += h;
    }
  }
  if (current.length > 0) pages.push({ pageNumber: pages.length + 1, items: current });
  return pages;
}

export default function CqPdfGenerator({ onBack }: { onBack: () => void }) {
  const [materialName, setMaterialName] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [items, setItems] = useState<CqItem[]>([]);
  const [detection, setDetection] = useState<{ total: number } | null>(null);
  const [generating, setGenerating] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [pdfBlob, setPdfBlob] = useState<Blob | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfReady, setPdfReady] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const pdfUrlRef = useRef<string | null>(null);

  // Watermark logo (shared permanent setting with the MCQ generator).
  const [watermarkLogo, setWatermarkLogo] = useState<string | null>(null);
  const [watermarkEnabled, setWatermarkEnabled] = useState(true);
  const [watermarkOpacity, setWatermarkOpacity] = useState(7);
  const [watermarkSize, setWatermarkSize] = useState(280);
  const [watermarkPosition, setWatermarkPosition] = useState<"top" | "center" | "bottom">("center");

  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(t);
    }
  }, [toast]);

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

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/watermark-logo", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data?.logo?.url) return;
        setWatermarkLogo(data.logo.url);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Invalidate generated PDF whenever the edited preview state changes.
  const prevKeyRef = useRef<string>("");
  useEffect(() => {
    const key =
      JSON.stringify(items) + "|" + materialName + "|" +
      (watermarkEnabled ? "wm1" : "wm0") + "|" + watermarkOpacity + "|" + watermarkSize + "|" + watermarkPosition +
      "|" + (watermarkLogo ?? "");
    if (prevKeyRef.current && prevKeyRef.current !== key && pdfReady) {
      setPdfReady(false);
      setGenerateError(null);
    }
    prevKeyRef.current = key;
  }, [items, materialName, watermarkEnabled, watermarkOpacity, watermarkSize, watermarkPosition, watermarkLogo, pdfReady]);

  const pages: CqPage[] = useMemo(() => paginateCqs(items), [items]);
  const partCount = items.reduce((acc, item) => acc + item.parts.length, 0);

  const renumber = (list: CqItem[]): CqItem[] => renumberCqItems(list);

  const handleDetect = () => {
    if (!pasteText.trim()) {
      setToast("Please paste questions first.");
      return;
    }
    const parsed = parsePastedCqs(pasteText);
    if (parsed.length === 0) {
      setToast("No CQs detected. Check format.");
      return;
    }
    setItems(parsed);
    setDetection({ total: parsed.length });
    setToast(`${parsed.length} creative questions detected & formatted`);
    window.scrollTo({ top: 0, behavior: "smooth" });
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
    setItems([]);
    setPasteText("");
    setDetection(null);
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

  const updateItem = (id: string, patch: Partial<CqItem>) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  const handleDelete = (id: string) => {
    setItems((prev) => renumber(prev.filter((item) => item.id !== id)));
  };

  const handleMove = (id: string, dir: -1 | 1) => {
    setItems((prev) => {
      const idx = prev.findIndex((item) => item.id === id);
      if (idx === -1) return prev;
      const target = idx + dir;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(idx, 1);
      next.splice(target, 0, moved);
      return renumber(next);
    });
  };

  const handlePartUpdate = (itemId: string, partId: string, patch: Partial<CqPart>) => {
    setItems((prev) =>
      prev.map((item) =>
        item.id === itemId
          ? { ...item, parts: item.parts.map((p) => (p.id === partId ? { ...p, ...patch } : p)) }
          : item,
      ),
    );
  };

  const handlePartDelete = (itemId: string, partId: string) => {
    setItems((prev) =>
      prev.map((item) =>
        item.id === itemId ? { ...item, parts: item.parts.filter((p) => p.id !== partId) } : item,
      ),
    );
  };

  const handlePartAdd = (itemId: string) => {
    setItems((prev) =>
      prev.map((item) => {
        if (item.id !== itemId) return item;
        const used = new Set(item.parts.map((p) => p.label));
        const label = PART_LABELS.find((l) => !used.has(l)) ?? `(${item.parts.length + 1})`;
        return { ...item, parts: [...item.parts, { id: uid("p"), label, text: "", marks: "" }] };
      }),
    );
  };

  const handleImageUpload = async (id: string, file: File | undefined) => {
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
      updateItem(id, { image: { dataUrl, name: file.name, widthPercent: 100 } });
      setToast("Image added to question");
    } catch {
      setToast("Failed to load image");
    }
  };

  const handleResizeImage = (id: string, widthPercent: number) => {
    setItems((prev) =>
      prev.map((item) =>
        item.id === id && item.image ? { ...item, image: { ...item.image, widthPercent } } : item,
      ),
    );
  };

  const handleRemoveImage = (id: string) => {
    updateItem(id, { image: null });
    setToast("Image removed");
  };

  // ── PDF build: captured from the edited A4 preview DOM ──
  const buildPdfBlob = async (): Promise<Blob> => {
    if (items.length === 0) throw new Error("No questions to generate.");
    if (!previewRef.current) throw new Error("Preview not ready — please try again.");
    const [{ default: jsPDF }, { default: html2canvas }] = await Promise.all([
      import("jspdf"),
      import("html2canvas"),
    ]);
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
    const pageEls = previewRef.current.querySelectorAll<HTMLElement>(".a4-page");
    if (!pageEls || pageEls.length === 0) throw new Error("Preview not ready");
    for (let i = 0; i < pageEls.length; i++) {
      const el = pageEls[i];
      const restoreTextBaseline = fixHtml2CanvasTextBaseline(document);
      const canvas = await html2canvas(el, {
        scale: 2,
        useCORS: true,
        allowTaint: false,
        backgroundColor: "#ffffff",
        logging: false,
        onclone: (clonedDoc) => {
          const style = clonedDoc.createElement("style");
          style.textContent = `@import url('https://fonts.googleapis.com/css2?family=Hind+Siliguri:wght@400;600;700&family=Noto+Sans+Bengali:wght@400;600;700&display=swap');`;
          clonedDoc.head.appendChild(style);
          // html2canvas 1.4.1 cannot parse Tailwind v4 modern colors
          // (oklch/oklab/color-mix). Rewrite them to sRGB so capture never throws.
          try {
            sanitizeClonedColorsForHtml2Canvas(clonedDoc);
          } catch {}
        },
      }).finally(restoreTextBaseline);
      const imgData = canvas.toDataURL("image/jpeg", 0.92);
      const pageW = pdf.internal.pageSize.getWidth();
      const pageH = pdf.internal.pageSize.getHeight();
      if (i > 0) pdf.addPage();
      // Preview-faithful placement: exact-A4 fills edge-to-edge; overflow
      // captures shrink uniformly (never stretched, never clipped).
      const rect = capturePageRect(canvas.width, canvas.height, pageW, pageH);
      pdf.addImage(imgData, "JPEG", rect.x, rect.y, rect.w, rect.h, undefined, "FAST");
    }
    const blob: Blob = pdf.output("blob");
    if (!blob || blob.size === 0) throw new Error("Generated PDF is empty — please try again.");
    return blob;
  };

  const triggerClientDownload = (blob: Blob, fileName: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.style.display = "none";
    a.rel = "noopener";
    document.body.appendChild(a);
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

  const handleGeneratePdf = async () => {
    if (items.length === 0) {
      setToast("No questions to generate.");
      setGenerateError("No questions to generate.");
      return;
    }
    if (!previewRef.current) {
      setToast("Preview not ready");
      setGenerateError("Preview not ready — please try again.");
      return;
    }
    setGenerating(true);
    setGenerateError(null);
    setPdfReady(false);
    if (pdfUrl) {
      URL.revokeObjectURL(pdfUrl);
      pdfUrlRef.current = null;
    }
    setPdfUrl(null);
    setPdfBlob(null);
    try {
      const blob = await buildPdfBlob();
      const url = URL.createObjectURL(blob);
      setPdfBlob(blob);
      setPdfUrl(url);
      pdfUrlRef.current = url;
      setPdfReady(true);
      setToast("PDF generated — click Download PDF");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "PDF generation failed — please try again.";
      setGenerateError(msg);
      setToast(msg);
      setPdfReady(false);
    } finally {
      setGenerating(false);
    }
  };

  const handleDownloadPdf = async () => {
    if (generating) {
      setToast("Please wait — generating PDF…");
      return;
    }
    try {
      const fileName = `${sanitizeFileName(materialName)}.pdf`;
      let blobToDownload: Blob | null = pdfBlob;
      if (!blobToDownload && pdfUrlRef.current && pdfBlob) blobToDownload = pdfBlob;
      if (!blobToDownload || !pdfReady) {
        setGenerating(true);
        setGenerateError(null);
        if (pdfUrl) {
          URL.revokeObjectURL(pdfUrl);
          pdfUrlRef.current = null;
        }
        setPdfUrl(null);
        setPdfBlob(null);
        try {
          blobToDownload = await buildPdfBlob();
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
        }
      }
      if (!blobToDownload) throw new Error("No PDF to download — please click Generate PDF first.");
      triggerClientDownload(blobToDownload, fileName);
      setToast("PDF downloaded to your device");
      setGenerateError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Download failed — please try again.";
      setGenerateError(msg);
      setToast(msg);
    }
  };

  return (
    <div className="min-h-screen bg-[#f1f5f9] admin-dark:bg-[#0a162e]">
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Hind+Siliguri:wght@400;600;700&family=Noto+Sans+Bengali:wght@400;600;700&display=swap'); .bangla{font-family:'Hind Siliguri','Noto Sans Bengali',system-ui,sans-serif} .a4-page *{font-family:'Hind Siliguri','Noto Sans Bengali',system-ui,sans-serif} .a4-page{break-inside:avoid;page-break-inside:avoid} .a4-page .keep-together{break-inside:avoid;page-break-inside:avoid;-webkit-column-break-inside:avoid} .a4-page ol,.a4-page ul{list-style-type:none !important;list-style:none !important;margin-left:0 !important;padding-left:0 !important} .a4-page li::marker{content:none !important} @media print{.a4-page{break-after:page;page-break-after:always;break-inside:avoid;page-break-inside:avoid} .a4-page h1,.a4-page h2,.a4-page .keep-together{overflow:visible !important;height:auto !important;max-height:none !important;white-space:normal !important;text-overflow:clip !important} .a4-page h1,.a4-page h2{line-height:1.5 !important}}`}</style>

      <div className="mx-auto max-w-[1280px] px-3 py-6 sm:px-6 sm:py-8">
        {/* Top Title */}
        <div className="rounded-2xl border border-[#dbeafe] bg-white p-4 sm:p-6 shadow-sm admin-dark:border-[#1e3a65] admin-dark:bg-[#112544]">
          <button
            type="button"
            onClick={onBack}
            className="mb-3 rounded-xl border border-[#cbd5e1] bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50 admin-dark:border-[#1e3a65] admin-dark:bg-[#0f2547] admin-dark:text-white"
          >
            ← All Generators
          </button>
          <p className="text-[11px] font-bold uppercase tracking-widest text-emerald-700 admin-dark:text-emerald-300">
            Admin Tool • CQ PDF Generator
          </p>
          <h1 className="mt-1 text-xl font-extrabold text-[#0b1e3a] sm:text-2xl admin-dark:text-white">
            CQ PDF Generator
          </h1>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-slate-500 sm:text-sm admin-dark:text-[#8da0c0]">
            Material Name → Paste CQs → Detect &amp; Format → Editable single-column A4 Preview → Generate PDF → Download. উদ্দীপক + ক / খ / গ / ঘ parts with marks. Manual image insertion (no OCR).
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <span className="text-xs font-bold text-slate-600 admin-dark:text-[#8da0c0]">
              {items.length} Questions • {partCount} Parts • {pages.length} Page{pages.length !== 1 ? "s" : ""} • A4 Single-Column
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
            placeholder="e.g. Biology - Cell - CQ Model Test 01"
            className="bangla mt-3 w-full rounded-xl border border-[#cbd5e1] bg-[#f8fafc] px-4 py-3 text-sm font-semibold text-slate-900 outline-none placeholder:text-slate-400 focus:border-emerald-600 focus:bg-white admin-dark:border-[#1e3a65] admin-dark:bg-[#0a162e] admin-dark:text-white"
          />
        </div>

        {/* 2. Watermark */}
        <div className="mt-6 rounded-2xl border border-[#dbeafe] bg-white p-4 sm:p-6 shadow-sm admin-dark:border-[#1e3a65] admin-dark:bg-[#112544]">
          <label className="text-sm font-extrabold text-[#0b1e3a] admin-dark:text-white">2. Watermark</label>
          <p className="mt-1 text-xs leading-relaxed text-slate-500 admin-dark:text-[#8da0c0]">
            Uses the saved watermark logo (upload it once from the MCQ generator). Applied as a centered, transparent background mark on every generated PDF page.
          </p>
          <div className="mt-4 grid gap-3 rounded-xl border border-[#dbeafe] bg-[#f8fafc] p-3 sm:grid-cols-2 lg:grid-cols-4 admin-dark:border-[#1e3a65] admin-dark:bg-[#0a162e]">
            <label className="flex items-center gap-2 text-xs font-bold text-slate-700 admin-dark:text-white">
              <input
                type="checkbox"
                checked={watermarkEnabled}
                onChange={(e) => setWatermarkEnabled(e.target.checked)}
                className="h-4 w-4 accent-emerald-600"
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
                className="h-1 w-24 accent-emerald-600"
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
                className="h-1 w-24 accent-emerald-600"
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
          {!watermarkLogo && (
            <p className="mt-2 text-xs text-slate-400">No watermark logo saved yet — upload one from the MCQ generator to enable watermarks here.</p>
          )}
        </div>

        {/* 3. Paste CQs + Detect & Format */}
        <div className="mt-6 rounded-2xl border border-[#dbeafe] bg-white p-4 sm:p-6 shadow-sm admin-dark:border-[#1e3a65] admin-dark:bg-[#112544]">
          <label className="text-sm font-extrabold text-[#0b1e3a] admin-dark:text-white">3. Paste CQs</label>
          <p className="mt-1 text-xs leading-relaxed text-slate-500 admin-dark:text-[#8da0c0]">
            Paste creative questions. Each block starts with a number (1. 2. 3.), parts start with ক) খ) গ) ঘ). Marks like [৩] or ৩ নম্বর are auto-detected. Bangla + English mixed, Unicode fully supported.
          </p>
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder={`Paste your creative questions

Example:
1. উদ্দীপক: রহিম প্রতিদিন সকালে হাঁটতে যায়। সুষম খাদ্য গ্রহণ করে।
ক) সুষম খাদ্য কী? [১]
খ) হাঁটা কেন স্বাস্থ্যের জন্য উপকারী? ব্যাখ্যা করো। [২]
গ) উদ্দীপকের রহিমের জীবনধারা বিশ্লেষণ করো। [৩]
ঘ) সুস্থ জীবনের জন্য রহিমের অভ্যাস কতটা যুক্তিযুক্ত? মূল্যায়ন করো। [৪]

2. Next question stem here...
ক) ... [১]
খ) ... [২]
...`}
            className="bangla mt-3 min-h-[280px] w-full resize-y rounded-xl border border-[#cbd5e1] bg-[#f8fafc] p-4 text-sm leading-relaxed text-slate-800 outline-none placeholder:text-slate-400 focus:border-emerald-600 focus:bg-white admin-dark:border-[#1e3a65] admin-dark:bg-[#0a162e] admin-dark:text-white"
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={handleDetect}
              disabled={!pasteText.trim()}
              className="rounded-xl bg-emerald-600 px-6 py-2.5 text-sm font-extrabold text-white shadow hover:bg-emerald-700 disabled:opacity-40"
            >
              Detect &amp; Format
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
              {pasteText.length} chars • Auto renumber 1..N • Detects ক) খ) গ) ঘ) + marks
            </span>
          </div>
        </div>

        {/* 4. Editable A4 Preview */}
        {items.length > 0 && (
          <div className="mt-6 rounded-2xl border border-[#dbeafe] bg-white p-4 sm:p-6 shadow-sm admin-dark:border-[#1e3a65] admin-dark:bg-[#112544]">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-extrabold text-[#0b1e3a] admin-dark:text-white">Editable A4 Preview</h2>
                <p className="mt-1 text-xs text-slate-500 admin-dark:text-[#8da0c0]">
                  Real-time A4 preview = exact PDF layout. Click any stem/part to edit. Add images — they stay with their question. Edits update pagination instantly.
                </p>
              </div>
              <button
                onClick={handleClear}
                className="rounded-xl border border-[#cbd5e1] bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50 admin-dark:border-[#1e3a65] admin-dark:bg-[#0f2547] admin-dark:text-white"
              >
                Reset
              </button>
            </div>
            <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900 admin-dark:border-amber-900/40 admin-dark:bg-amber-900/20 admin-dark:text-amber-200">
              <span className="font-bold">Image Upload:</span> Manual only — for উদ্দীপক diagrams/figures/tables. No OCR. Resize / Move / Remove available per image. Images never overflow A4 and preserve aspect ratio in PDF.
            </div>
          </div>
        )}

        {/* A4 Pages Preview — single column */}
        {items.length > 0 ? (
          <div
            ref={previewRef}
            className="mt-6 flex flex-col items-center gap-8 bg-[#525659] p-4 py-6 sm:rounded-2xl sm:p-8"
            style={{ background: "#525659" }}
          >
            {pages.map((page) => (
              <div
                key={page.pageNumber}
                className="a4-page relative flex w-full max-w-[794px] flex-col bg-white shadow-[0_8px_40px_rgba(0,0,0,.35)]"
                style={{
                  width: "210mm",
                  minHeight: "297mm",
                  padding: "10mm 12mm 10mm 12mm",
                  fontFamily: "'Hind Siliguri','Noto Sans Bengali',sans-serif",
                  zIndex: 0,
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
                {/* Top Header — fixed every page. Keep together, never split. */}
                <div className="keep-together flex items-center gap-2 text-[9px] font-semibold tracking-wide text-slate-700"
                  style={{ breakInside: "avoid", pageBreakInside: "avoid" } as React.CSSProperties}>
                  <span className="shrink-0 font-bold text-[#0b1e3a]">MediSpark Academic and Admission Care</span>
                  <span className="flex-1 border-b border-dotted border-slate-400 opacity-70" style={{ borderBottomStyle: "dotted", height: 1, marginTop: 6 }} />
                  <span className="shrink-0 font-bold text-[#0b1e3a]">Page {String(page.pageNumber).padStart(2, "0")}</span>
                </div>
                <div className="mt-1 border-b border-dotted border-slate-300" style={{ borderBottomStyle: "dotted" }} />

                {/* Material Name Title if exists — editable. Keep together. */}
                {materialName.trim() && (
                  <div className="keep-together mt-3 text-center"
                    style={{ breakInside: "avoid", pageBreakInside: "avoid" } as React.CSSProperties}>
                    <h2
                      className="bangla cursor-text text-[13px] font-extrabold leading-tight text-[#0b1e3a] outline-none focus:bg-yellow-50 focus:ring-1 focus:ring-amber-300 rounded px-1"
                      contentEditable
                      suppressContentEditableWarning
                      onBlur={(e) => {
                        const txt = (e.currentTarget.innerText || "").trim();
                        if (txt !== materialName.trim()) setMaterialName(txt);
                        else e.currentTarget.innerText = materialName.trim();
                      }}
                      title="Click to edit material title"
                    >
                      {materialName.trim()}
                    </h2>
                  </div>
                )}

                {/* Single-column CQ blocks */}
                <div className="mt-3 flex-1">
                  {page.items.map((item) => (
                    <div
                      key={item.id}
                      className="mb-4 break-inside-avoid rounded-[2px] border-b border-dashed border-slate-200 p-1 pb-3"
                      style={{ breakInside: "avoid", pageBreakInside: "avoid" } as React.CSSProperties}
                    >
                      {/* Number + stem — number editable */}
                      <div className="flex gap-1.5">
                        <span className="flex shrink-0 items-start gap-1">
                          <input
                            type="number"
                            value={item.number}
                            onChange={(e) => {
                              const n = parseInt(e.target.value, 10);
                              if (Number.isFinite(n) && n > 0) updateItem(item.id, { number: n });
                            }}
                            className="pdf-number-input w-8 rounded border border-transparent bg-transparent text-center text-[12px] font-extrabold text-[#0f172a] outline-none hover:border-[#cbd5e1] focus:border-emerald-600 focus:bg-white"
                            style={{ lineHeight: "1" }}
                            title="Edit question number"
                          />
                          <span className="text-[12px] font-extrabold text-[#0f172a]">.</span>
                        </span>
                        <span
                          className="bangla flex-1 cursor-text text-[12px] font-bold leading-[1.8] text-[#0f172a] outline-none focus:bg-yellow-50 focus:ring-1 focus:ring-amber-300 rounded px-0.5"
                          contentEditable
                          suppressContentEditableWarning
                          onBlur={(e) => {
                            const txt = (e.currentTarget.innerText || "").trim();
                            if (txt !== item.stem) updateItem(item.id, { stem: txt });
                          }}
                          title="Click to edit stem"
                          style={{ whiteSpace: "pre-line" } as React.CSSProperties}
                        >
                          {item.stem || <span className="text-red-400 font-normal">[Empty — click to edit]</span>}
                        </span>
                        <div className="flex shrink-0 gap-1 pdf-hide" data-html2canvas-ignore="true">
                          <button onClick={() => handleMove(item.id, -1)} title="Move up" className="rounded border bg-white px-1 py-0.5 text-[9px] font-bold hover:bg-slate-50">↑</button>
                          <button onClick={() => handleMove(item.id, 1)} title="Move down" className="rounded border bg-white px-1 py-0.5 text-[9px] font-bold hover:bg-slate-50">↓</button>
                          <button
                            onClick={() => handleDelete(item.id)}
                            title="Delete question"
                            className="rounded border border-red-200 px-1 py-0.5 text-[9px] font-bold text-red-600 hover:bg-red-50"
                            style={{ height: 18 }}
                          >
                            ×
                          </button>
                        </div>
                      </div>

                      {/* Question image (optional) */}
                      {item.image?.dataUrl ? (
                        <div className="mt-2 pl-6">
                          <img
                            src={item.image.dataUrl}
                            alt={item.image.name || "question image"}
                            className="mx-auto block rounded border border-slate-200 bg-white"
                            style={{
                              width: `${item.image.widthPercent ?? 100}%`,
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
                                onClick={() => handleResizeImage(item.id, w)}
                                className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${(item.image?.widthPercent ?? 100) === w ? "bg-emerald-600 text-white" : "bg-white border border-[#cbd5e1] text-slate-600 hover:bg-slate-50"}`}
                              >
                                {w}%
                              </button>
                            ))}
                            <input
                              type="range"
                              min={30}
                              max={100}
                              value={item.image.widthPercent ?? 100}
                              onChange={(e) => handleResizeImage(item.id, parseInt(e.target.value, 10))}
                              className="h-1 w-16 accent-emerald-600"
                            />
                            <button onClick={() => handleRemoveImage(item.id)} className="rounded border border-red-200 bg-white px-2 py-0.5 text-[9px] font-bold text-red-600 hover:bg-red-50">Remove</button>
                            <label className="ml-1 cursor-pointer rounded border border-[#cbd5e1] bg-white px-2 py-0.5 text-[9px] font-bold text-slate-600 hover:bg-slate-50">
                              Replace
                              <input
                                type="file"
                                accept="image/*"
                                className="hidden"
                                onChange={(e) => {
                                  void handleImageUpload(item.id, e.target.files?.[0]);
                                  e.target.value = "";
                                }}
                              />
                            </label>
                          </div>
                        </div>
                      ) : (
                        <div className="mt-1 pl-6 pdf-hide" data-html2canvas-ignore="true">
                          <label className="cursor-pointer rounded-full border border-dashed border-[#cbd5e1] bg-white px-2 py-1 text-[10px] font-bold text-slate-600 hover:bg-slate-50">
                            + Add Image to this question
                            <input
                              type="file"
                              accept="image/*"
                              className="hidden"
                              onChange={(e) => {
                                void handleImageUpload(item.id, e.target.files?.[0]);
                                e.target.value = "";
                              }}
                            />
                          </label>
                        </div>
                      )}

                      {/* Parts ক/খ/গ/ঘ with marks */}
                      <div className="bangla mt-2 grid gap-1 pl-6 text-[12px] leading-[1.7] text-[#1e293b]">
                        {item.parts.map((part) => (
                          <div key={part.id} className="flex gap-1.5">
                            <span className="shrink-0 font-bold">{part.label}.</span>
                            <span
                              className="flex-1 cursor-text outline-none focus:bg-yellow-50 focus:ring-1 focus:ring-amber-300 rounded px-0.5"
                              contentEditable
                              suppressContentEditableWarning
                              onBlur={(e) => {
                                const txt = (e.currentTarget.textContent || "").trim();
                                if (txt !== part.text) handlePartUpdate(item.id, part.id, { text: txt });
                              }}
                              title={`Click to edit part ${part.label}`}
                            >
                              {part.text || <span className="text-red-400">[Empty]</span>}
                            </span>
                            <span className="flex shrink-0 items-center gap-1">
                              <input
                                type="number"
                                min={0}
                                max={50}
                                value={part.marks}
                                onChange={(e) => handlePartUpdate(item.id, part.id, { marks: e.target.value })}
                                className="w-10 rounded border border-transparent bg-transparent text-center text-[11px] font-bold text-slate-600 outline-none hover:border-[#cbd5e1] focus:border-emerald-600 focus:bg-white"
                                title="Marks"
                                placeholder="–"
                              />
                              <button
                                onClick={() => handlePartDelete(item.id, part.id)}
                                title="Delete part"
                                className="rounded border border-red-200 px-1 text-[9px] font-bold text-red-600 hover:bg-red-50 pdf-hide"
                                data-html2canvas-ignore="true"
                              >
                                ×
                              </button>
                            </span>
                          </div>
                        ))}
                      </div>
                      <div className="mt-1 pl-6 pdf-hide" data-html2canvas-ignore="true">
                        <button
                          onClick={() => handlePartAdd(item.id)}
                          className="rounded-full border border-[#cbd5e1] bg-white px-2 py-1 text-[10px] font-bold text-slate-600 hover:bg-slate-50"
                        >
                          + Add Part
                        </button>
                      </div>
                    </div>
                  ))}
                  {page.items.length === 0 && (
                    <p className="py-10 text-center text-sm text-slate-400">No questions</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-6 rounded-2xl border border-dashed border-[#cbd5e1] bg-white p-10 text-center admin-dark:border-[#1e3a65] admin-dark:bg-[#112544]">
            <p className="text-sm font-bold text-slate-600 admin-dark:text-[#8da0c0]">No preview yet</p>
            <p className="mt-1 text-xs text-slate-400">Paste CQs above and click Detect &amp; Format to see editable A4 preview</p>
          </div>
        )}

        {/* Generate PDF + Download */}
        {items.length > 0 && (
          <>
            {generateError && (
              <div className="mt-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700 admin-dark:border-red-900/40 admin-dark:bg-red-900/20 admin-dark:text-red-300">
                {generateError}
              </div>
            )}
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <button
                onClick={handleGeneratePdf}
                disabled={generating}
                className="rounded-xl bg-emerald-600 px-8 py-3 text-sm font-extrabold text-white shadow hover:bg-emerald-700 disabled:opacity-40"
                title={generating ? "Generating PDF…" : "Generate PDF"}
              >
                {generating ? "Generating PDF…" : "Generate PDF"}
              </button>
              <button
                onClick={handleDownloadPdf}
                disabled={generating}
                className="rounded-xl border border-[#cbd5e1] bg-white px-6 py-3 text-sm font-bold text-[#0b1e3a] hover:bg-slate-50 disabled:opacity-40 admin-dark:border-[#1e3a65] admin-dark:bg-[#0f2547] admin-dark:text-white"
                title={generating ? "Generating PDF…" : pdfReady ? "Download PDF to your device" : "Download PDF (auto-generates if needed) — saves to your device"}
              >
                {generating ? "Preparing…" : "Download PDF"}
              </button>
            </div>
            {pdfReady && !generating ? (
              <p className="mt-2 text-center text-xs font-semibold text-emerald-700 admin-dark:text-emerald-300">
                ✓ PDF ready — click Download PDF to save {sanitizeFileName(materialName)}.pdf to your device
              </p>
            ) : !pdfReady && !generating && items.length > 0 ? (
              <p className="mt-2 text-center text-xs text-slate-500 admin-dark:text-[#8da0c0]">
                Tip: Download PDF auto-generates first if needed — file saves directly to your device (not server)
              </p>
            ) : null}
          </>
        )}

        <p className="mt-6 text-center text-xs text-slate-400 admin-dark:text-[#8da0c0]">
          MediSpark CQ PDF Generator • Material Name → Paste → Detect &amp; Format → Edit → Generate → Download • Single-column A4 • Professional print-ready • Images manual only (no OCR)
        </p>
      </div>

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-slate-900 px-5 py-2.5 text-sm font-bold text-white shadow-xl admin-dark:bg-white admin-dark:text-slate-900">
          {toast}
        </div>
      )}
    </div>
  );
}
