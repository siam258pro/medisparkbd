'use client';
// Local smart handwriting whiteboard — modern floating-chrome edition.
// Full-screen canvas + left tool rail + right control dock + bottom status pill.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BeautifyStrength, Board, BoardBackground, BoardTheme, Camera, InkPoint, ScriptPref, Stroke, ToolKind } from './types.ts';
import { uid } from './types.ts';
import { beautifyStroke, revertStroke, layoutCorrectGroup, deviationOf } from './beautify.ts';
import { cleanStroke, normalizeGroupHeight } from './cleanStrokes.ts';
import { getStroke } from 'perfect-freehand';
import { groupStrokes, pointInPolygon } from './grouping.ts';
import { detectInkShape } from './inkShape.ts';
import { groupIntoLines } from './lines.ts';
import { expandCoalesced, shouldIgnorePointer } from './input.ts';
import { VisionLlmRecognizer, type RecResult, verifyLang, normalizeBanglaNFC, type RecLang, LOW_CONFIDENCE } from './recognizer.ts';
import type { TextLine } from './lines.ts';
import { pickFont, ensureFonts, fitFontSize, measureCanvas } from './handText.ts';
import { loadBoards, saveBoards, loadProfile, saveProfile } from './storage.ts';
import { DEFAULT_PROFILE, learnFromFeedback, deleteExample, clearMemory, countByScript, exportProfile, importProfile } from './memory.ts';

const COLORS = ['#f5f2ea', '#111111', '#3b82f6', '#ef4444', '#10b981', '#a855f7', '#f59e0b', '#14b8a6'];
const WIDTHS = [2, 3.5, 5, 8];
const BG = '#131210';

function newBoard(name: string): Board {
  return { id: uid('b'), name, strokes: [], camera: { x: 0, y: 0, zoom: 1 }, createdAt: Date.now(), updatedAt: Date.now(), theme: 'night', background: { type: 'dots' }, pdf: null };
}

/* Minimal inline icons (no emoji, no extra deps). */
function Icon({ d, size = 18 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}
const ICONS: Record<string, string> = {
  pen: 'M12 19l7-7 3 3-7 7-3-3z M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z M2 2l7.586 7.586 M22 22H2',
  highlighter: 'M9 11l-6 6v3h9l3-3 M9 11l4 4 M9 11l8.5-8.5a2.1 2.1 0 013 3L13 14 M13 14l-2-2',
  eraser: 'M7 21l-4-4L13 7l5 5-7 8H7z M13 7l4-4 4 4-5 5 M7 21h14',
  select: 'M4 3l7 18 2.5-7.5L21 11 4 3z',
  line: 'M5 19L19 5 M5 19h0 M19 5h0',
  arrow: 'M5 19L19 5 M11 5h8v8',
  rect: 'M4 7h16v10H4z',
  ellipse: 'M12 4c5 0 8 3.5 8 8s-3 8-8 8-8-3.5-8-8 3-8 8-8z',
  text: 'M5 6V4h14v2 M12 4v16 M9 20h6',
  sticky: 'M6 3h12v12l-4 4H6V3z M14 19v-4h4',
  pan: 'M12 3v18 M3 12h18 M12 3l-2.5 2.5 M12 3l2.5 2.5 M12 21l-2.5-2.5 M12 21l2.5-2.5 M3 12l2.5-2.5 M3 12l2.5 2.5 M21 12l-2.5-2.5 M21 12l-2.5 2.5',
  undo: 'M9 14L4 9l5-5 M4 9h10a6 6 0 016 6v1',
  redo: 'M15 14l5-5-5-5 M20 9H10a6 6 0 00-6 6v1',
  spark: 'M12 2l2.2 6.6L21 11l-6.8 2.4L12 20l-2.2-6.6L3 11l6.8-2.4L12 2z',
  board: 'M4 5h16v14H4z M4 10h16 M10 10v9',
  sliders: 'M4 8h10 M18 8h2 M4 16h4 M12 16h8 M14 6v4 M8 14v4',
  image: 'M4 5h16v14H4z M4 15l5-5 3 3 4-4 4 4 M9 9h.01',
  download: 'M12 3v12 M7 10l5 5 5-5 M4 21h16',
  plus: 'M12 5v14 M5 12h14',
  minus: 'M5 12h14',
  check: 'M4 12l5 5L20 6',
  x: 'M6 6l12 12 M18 6L6 18',
  fit: 'M4 9V4h5 M15 4h5v5 M20 15v5h-5 M9 20H4v-5',
  moon: 'M20 13A8 8 0 1111 4a6.5 6.5 0 009 9z',
  sun: 'M12 4V2 M12 20v-2 M4 12H2 M20 12h-2 M6.3 6.3L4.9 4.9 M19.1 19.1l-1.4-1.4 M6.3 17.7l-1.4 1.4 M19.1 4.9l-1.4 1.4 M12 8a4 4 0 100 8 4 4 0 000-8z',
  ruler: 'M3 17L17 3l4 4L7 21l-4-4z M8.5 15.5l1.4 1.4 M11.5 12.5l1.4 1.4 M14.5 9.5l1.4 1.4',
  file: 'M6 2h8l4 4v16H6V2z M14 2v4h4 M9 13h6 M9 17h6',
  trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 14h10l1-14 M10 11v6 M14 11v6',
  hw: 'M4 20l1-4L16.5 4.5a2.1 2.1 0 013 3L8 19l-4 1z M14.5 6.5l3 3',
};

const TOOLS: Array<{ id: ToolKind; label: string; kbd: string }> = [
  { id: 'pen', label: 'Pen', kbd: 'P' },
  { id: 'highlighter', label: 'Highlighter', kbd: 'H' },
  { id: 'eraser', label: 'Eraser', kbd: 'E' },
  { id: 'select', label: 'Select', kbd: 'V' },
  { id: 'line', label: 'Line', kbd: '' },
  { id: 'arrow', label: 'Arrow', kbd: '' },
  { id: 'rect', label: 'Rectangle', kbd: '' },
  { id: 'ellipse', label: 'Ellipse', kbd: '' },
  { id: 'text', label: 'Text', kbd: 'T' },
  { id: 'sticky', label: 'Sticky note', kbd: '' },
  { id: 'pan', label: 'Pan', kbd: 'Space' },
];

export default function Whiteboard() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [boards, setBoards] = useState<Board[]>([]);
  const [boardId, setBoardId] = useState<string>('');
  const [tool, setTool] = useState<ToolKind>('pen');
  const [color, setColor] = useState(COLORS[0]);
  const [width, setWidth] = useState(3.5);
  const [autoBeautify, setAutoBeautify] = useState(true);
  const [strength, setStrength] = useState<BeautifyStrength>('balanced');
  const [inkStyle, setInkStyle] = useState<'geometric' | 'clean'>('geometric');
  const [delayMs, setDelayMs] = useState(700);
  const [lang, setLang] = useState<ScriptPref>('auto');
  const [showOriginal, setShowOriginal] = useState(false);
  const [keepOriginalUnder, setKeepOriginalUnder] = useState(false);
  const [status, setStatus] = useState('Ready — local only, no cloud.');
  const [busy, setBusy] = useState(false);
  const [dockOpen, setDockOpen] = useState(true);
  const [penPanel, setPenPanel] = useState(false);
  const [theme, setThemeState] = useState<BoardTheme>('night');
  const [rulerOn, setRulerOn] = useState(false);
  const [rulerAngle, setRulerAngle] = useState(0);
  const [rulerOff, setRulerOff] = useState(-80);
  const [autoShape, setAutoShape] = useState(true);
  const [hwMode, setHwMode] = useState(false);
  const [palmReject, setPalmReject] = useState(true);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiBusy, setAiBusy] = useState(0);
  const [aiNotice, setAiNotice] = useState(false);
  const [chips, setChips] = useState<Array<{ key: string; ids: string[]; text: string; alternatives: string[]; lang: RecLang; sx: number; sy: number }>>([]);
  const [recMode, setRecMode] = useState<'clean' | 'convert'>('clean');
  const LOW_CONF = LOW_CONFIDENCE;
  const [editing, setEditing] = useState<null | { wx: number; wy: number; sx: number; sy: number; kind: 'text' | 'sticky'; editId?: string }>(null);
  const [editText, setEditText] = useState('');
  const [boardNameDraft, setBoardNameDraft] = useState('');
  const [renameDraft, setRenameDraft] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);
  const [, setTick] = useState(0);

  const strokesRef = useRef<Stroke[]>([]);
  const camRef = useRef<Camera>({ x: 0, y: 0, zoom: 1 });
  const themeRef = useRef<BoardTheme>('night');
  const bgRef = useRef<BoardBackground>({ type: 'dots' });
  const pdfRef = useRef<Board['pdf']>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<null | { d0: number; zoom0: number; wx: number; wy: number }>(null);
  const undoRef = useRef<Stroke[][]>([]);
  const redoRef = useRef<Stroke[][]>([]);
  const drawingRef = useRef<{ pts: InkPoint[]; id: string } | null>(null);
  const panningRef = useRef<{ sx: number; sy: number; cx: number; cy: number } | null>(null);
  const lassoRef = useRef<Array<{ x: number; y: number }> | null>(null);
  const copyRef = useRef<Stroke[]>([]);
  const moveRef = useRef<null | { sx: number; sy: number; orig: Map<string, Stroke>; moved: boolean }>(null);
  const selectedRef = useRef<Set<string>>(new Set());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hwTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const processedHwRef = useRef<Set<string>>(new Set());
  const penActiveRef = useRef(0);
  const recognizerRef = useRef(new VisionLlmRecognizer());
  const recRef = useRef(new Map<string, { line: TextLine; result: RecResult }>());
  const profileRef = useRef(loadProfileSafe());
  const [memCount, setMemCount] = useState(0);
  const spaceDown = useRef(false);

  function loadProfileSafe() {
    try { return loadProfile(); } catch { return DEFAULT_PROFILE; }
  }

  const SETTINGS_KEY = 'msb.hwsettings.v1';
  const NOTICE_KEY = 'msb.aiNotice.v1';

  // Persist handwriting settings (never the strokes or the API key).
  useEffect(() => {
    try {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ aiEnabled, recMode, inkStyle, hwMode, palmReject }));
    } catch { /* ignore */ }
  }, [aiEnabled, recMode, inkStyle, hwMode, palmReject]);

  const board = boards.find((b) => b.id === boardId);
  const rerender = () => setTick((t) => t + 1);

  useEffect(() => {
    let bs: Board[] = [];
    try { bs = loadBoards(); } catch { bs = []; }
    if (bs.length === 0) {
      const b = newBoard('Lesson 1');
      bs = [b];
      try { saveBoards(bs); } catch { /* ignore */ }
    }
    setBoards(bs);
    setBoardId(bs[0].id);
    strokesRef.current = bs[0].strokes;
    camRef.current = bs[0].camera;
    themeRef.current = bs[0].theme ?? 'night';
    setThemeState(themeRef.current);
    bgRef.current = bs[0].background ?? { type: 'dots' };
    pdfRef.current = bs[0].pdf ?? null;
    try { setMemCount(loadProfile().examples.length); } catch { /* ignore */ }
    try {
      const raw = window.localStorage.getItem(SETTINGS_KEY);
      if (raw) {
        const s = JSON.parse(raw) as Partial<Record<string, unknown>>;
        if (typeof s.hwMode === 'boolean') setHwMode(s.hwMode);
        if (typeof s.palmReject === 'boolean') setPalmReject(s.palmReject);
        if (s.inkStyle === 'geometric' || s.inkStyle === 'clean') setInkStyle(s.inkStyle);
        if (s.recMode === 'clean' || s.recMode === 'convert') setRecMode(s.recMode);
        if (s.aiEnabled === true) {
          setAiEnabled(true);
          if (!window.localStorage.getItem(NOTICE_KEY)) setAiNotice(true);
        }
      }
    } catch { /* ignore */ }
    void ensureFonts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persist = useCallback((strokes: Stroke[], cam: Camera) => {
    setBoards((prev) => {
      const next = prev.map((b) => b.id === boardId ? { ...b, strokes, camera: cam, theme: themeRef.current, background: bgRef.current, pdf: pdfRef.current, updatedAt: Date.now() } : b);
      try { saveBoards(next); } catch (e) { setStatus(`Save failed: ${(e as Error).message}`); }
      return next;
    });
  }, [boardId]);

  const pushUndo = useCallback(() => {
    undoRef.current.push(strokesRef.current.map((s) => ({ ...s, points: s.points.slice() })));
    if (undoRef.current.length > 60) undoRef.current.shift();
    redoRef.current = [];
  }, []);

  const undo = useCallback(() => {
    const prev = undoRef.current.pop();
    if (!prev) return;
    redoRef.current.push(strokesRef.current);
    strokesRef.current = prev;
    persist(strokesRef.current, camRef.current);
    rerender();
  }, [persist]);

  const redo = useCallback(() => {
    const nxt = redoRef.current.pop();
    if (!nxt) return;
    undoRef.current.push(strokesRef.current);
    strokesRef.current = nxt;
    persist(strokesRef.current, camRef.current);
    rerender();
  }, [persist]);

  const toWorld = useCallback((sx: number, sy: number): InkPoint => {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    const cam = camRef.current;
    return {
      x: (sx - r.left - c.width / (window.devicePixelRatio || 1) / 2) / cam.zoom + cam.x,
      y: (sy - r.top - c.height / (window.devicePixelRatio || 1) / 2) / cam.zoom + cam.y,
      t: Date.now(),
    };
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    }
    const ctx2 = canvas.getContext('2d');
    if (!ctx2) return;
    const ctx: CanvasRenderingContext2D = ctx2;
    const cam = camRef.current;
    const night = themeRef.current !== 'white';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = night ? BG : '#f7f5ef';
    ctx.fillRect(0, 0, w, h);
    const X = (wx: number) => (wx - cam.x) * cam.zoom + w / 2;
    const Y = (wy: number) => (wy - cam.y) * cam.zoom + h / 2;
    // Template background image / PDF page
    const pdf = pdfRef.current;
    if (pdf && pdf.pages[pdf.pageIndex]) {
      drawBgImage(pdf.pages[pdf.pageIndex], pdf.ox, pdf.oy, pdf.pw, pdf.ph);
    } else if (bgRef.current.type === 'image' && bgRef.current.imageSrc) {
      const b = bgRef.current;
      drawBgImage(b.imageSrc!, b.ox ?? cam.x - (b.w ?? 600) / 2, b.oy ?? cam.y - (b.h ?? 400) / 2, b.w ?? 600, b.h ?? 400);
    }
    // Template patterns (screen-space, like classic whiteboards)
    const step = 48 * cam.zoom;
    const bgType = bgRef.current.type;
    if (bgType === 'dots' && step > 14) {
      ctx.fillStyle = night ? 'rgba(255,255,255,0.07)' : 'rgba(60,50,30,0.18)';
      const ox = (w / 2 - (cam.x * cam.zoom) % step + step) % step;
      const oy = (h / 2 - (cam.y * cam.zoom) % step + step) % step;
      for (let gx = ox; gx < w; gx += step) for (let gy = oy; gy < h; gy += step) {
        ctx.fillRect(gx, gy, 1.6, 1.6);
      }
    } else if ((bgType === 'grid' || bgType === 'lines') && step > 10) {
      ctx.strokeStyle = night ? 'rgba(255,255,255,0.06)' : 'rgba(60,50,30,0.14)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      const ox = (w / 2 - (cam.x * cam.zoom) % step + step) % step;
      const oy = (h / 2 - (cam.y * cam.zoom) % step + step) % step;
      for (let gx = ox; gx < w; gx += step) { ctx.moveTo(gx, 0); ctx.lineTo(gx, h); }
      if (bgType === 'grid') for (let gy = oy; gy < h; gy += step) { ctx.moveTo(0, gy); ctx.lineTo(w, gy); }
      else { ctx.strokeStyle = night ? 'rgba(255,255,255,0.09)' : 'rgba(60,50,30,0.2)'; for (let gy = oy; gy < h; gy += step) { ctx.moveTo(0, gy); ctx.lineTo(w, gy); } }
      ctx.stroke();
    }
    const renderStroke = (s: Stroke, ghost = false) => {
      const pts = (showOriginal && s.originalPoints ? s.originalPoints : s.points);
      if (s.isImage && s.imgSrc) {
        const img = imgCache.get(s.id);
        if (img && img.complete && img.naturalWidth) {
          ctx.drawImage(img, X(pts[0]?.x ?? 0), Y(pts[0]?.y ?? 0), (s.w ?? 300) * cam.zoom, (s.h ?? 200) * cam.zoom);
        } else {
          const im = new Image();
          im.onload = () => rerender();
          im.src = s.imgSrc;
          imgCache.set(s.id, im);
        }
        return;
      }
      if (s.text !== undefined) {
        ctx.fillStyle = s.color;
        const family = s.font ?? pickFont(s.text);
        ctx.font = `${Math.max(10, (s.width * 6) * cam.zoom)}px ${family}`;
        ctx.fillText(s.text, X(pts[0]?.x ?? 0), Y(pts[0]?.y ?? 0));
        return;
      }
      if (pts.length === 0) return;
      // Variable-width clean-strokes rendering (perfect-freehand outline).
      if (s.variableWidth && pts.length > 1 && !ghost) {
        const outline = getStroke(pts.map((p) => [p.x, p.y, p.p ?? 0.5]), {
          size: Math.max(2, s.width * 2.2), thinning: 0.65, smoothing: 0.6, streamline: 0.5, simulatePressure: false,
        });
        if (outline.length > 2) {
          ctx.fillStyle = s.color;
          ctx.beginPath();
          outline.forEach((o, i) => i ? ctx.lineTo(X(o[0]), Y(o[1])) : ctx.moveTo(X(o[0]), Y(o[1])));
          ctx.closePath();
          ctx.fill();
          if (selectedRef.current.has(s.id)) {
            ctx.strokeStyle = '#38bdf8'; ctx.setLineDash([5, 4]); ctx.lineWidth = 1.5;
            let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
            for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
            ctx.strokeRect(X(x0) - 6, Y(y0) - 6, (x1 - x0) * cam.zoom + 12, (y1 - y0) * cam.zoom + 12);
            ctx.setLineDash([]);
          }
          return;
        }
      }
      // Parametric shapes render crisp (not from point clouds).
      if (s.shape && s.ax !== undefined && s.ay !== undefined && s.bx !== undefined && s.by !== undefined) {
        const { shape, ax, ay, bx, by } = s;
        ctx.strokeStyle = s.color;
        ctx.fillStyle = s.color;
        ctx.globalAlpha = ghost ? 0.3 : 1;
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.lineWidth = Math.max(1, s.width * cam.zoom);
        ctx.beginPath();
        if (shape === 'line' || shape === 'arrow') { ctx.moveTo(X(ax), Y(ay)); ctx.lineTo(X(bx), Y(by)); ctx.stroke(); }
        else if (shape === 'rect') { ctx.strokeRect(X(Math.min(ax, bx)), Y(Math.min(ay, by)), Math.abs(bx - ax) * cam.zoom, Math.abs(by - ay) * cam.zoom); }
        else { ctx.beginPath(); ctx.ellipse(X((ax + bx) / 2), Y((ay + by) / 2), Math.max(1, Math.abs(bx - ax) / 2 * cam.zoom), Math.max(1, Math.abs(by - ay) / 2 * cam.zoom), 0, 0, Math.PI * 2); ctx.stroke(); }
        if (shape === 'arrow') {
          const ang = Math.atan2(by - ay, bx - ax);
          const L = Math.max(12, 7 * s.width);
          const p1x = bx - Math.cos(ang - 0.42) * L, p1y = by - Math.sin(ang - 0.42) * L;
          const p2x = bx - Math.cos(ang + 0.42) * L, p2y = by - Math.sin(ang + 0.42) * L;
          ctx.beginPath();
          ctx.moveTo(X(bx), Y(by)); ctx.lineTo(X(p1x), Y(p1y)); ctx.lineTo(X(p2x), Y(p2y));
          ctx.closePath(); ctx.fill();
        }
        ctx.globalAlpha = 1;
        if (selectedRef.current.has(s.id)) {
          ctx.strokeStyle = '#38bdf8'; ctx.setLineDash([5, 4]); ctx.lineWidth = 1.5;
          ctx.strokeRect(X(Math.min(ax, bx)) - 6, Y(Math.min(ay, by)) - 6, Math.abs(bx - ax) * cam.zoom + 12, Math.abs(by - ay) * cam.zoom + 12);
          ctx.setLineDash([]);
        }
        return;
      }
      ctx.strokeStyle = s.color;
      ctx.globalAlpha = s.tool === 'highlighter' ? 0.35 : ghost ? 0.3 : 1;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(1, s.width * cam.zoom * (s.tool === 'highlighter' ? 3 : 1));
      ctx.beginPath();
      if (pts.length === 1) {
        ctx.arc(X(pts[0].x), Y(pts[0].y), ctx.lineWidth / 2, 0, Math.PI * 2);
        ctx.fillStyle = s.color; ctx.fill();
      } else {
        ctx.moveTo(X(pts[0].x), Y(pts[0].y));
        for (let i = 1; i < pts.length; i++) ctx.lineTo(X(pts[i].x), Y(pts[i].y));
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      if (selectedRef.current.has(s.id)) {
        ctx.strokeStyle = '#38bdf8'; ctx.setLineDash([5, 4]); ctx.lineWidth = 1.5;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
        ctx.strokeRect(X(x0) - 6, Y(y0) - 6, (x1 - x0) * cam.zoom + 12, (y1 - y0) * cam.zoom + 12);
        ctx.setLineDash([]);
      }
    };
    for (const s of strokesRef.current) {
      if (keepOriginalUnder && s.originalPoints && !showOriginal) renderStroke({ ...s, points: s.originalPoints }, true);
      renderStroke(s);
    }
    if (drawingRef.current) {
      const pts = drawingRef.current.pts;
      if (pts.length) {
        ctx.strokeStyle = color; ctx.lineWidth = Math.max(1, width * cam.zoom);
        ctx.lineCap = 'round'; ctx.beginPath();
        ctx.moveTo(X(pts[0].x), Y(pts[0].y));
        for (let i = 1; i < pts.length; i++) ctx.lineTo(X(pts[i].x), Y(pts[i].y));
        ctx.stroke();
      }
    }
    if (lassoRef.current && lassoRef.current.length > 1) {
      const L = lassoRef.current;
      ctx.strokeStyle = '#38bdf8'; ctx.setLineDash([6, 4]); ctx.lineWidth = 1.5;
      ctx.fillStyle = 'rgba(56,189,248,0.07)';
      ctx.beginPath();
      ctx.moveTo(L[0].x, L[0].y);
      for (let i = 1; i < L.length; i++) ctx.lineTo(L[i].x, L[i].y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (rulerOn) {
      // Screen-locked straightedge (Microsoft-Whiteboard-style ruler)
      const cx = w / 2, cy = h / 2 + rulerOff;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate((rulerAngle * Math.PI) / 180);
      ctx.fillStyle = night ? 'rgba(56,189,248,0.13)' : 'rgba(2,132,199,0.10)';
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2;
      const RW = Math.min(520, w * 0.7), RH = 54;
      ctx.beginPath();
      ctx.roundRect(-RW / 2, -RH / 2, RW, RH, 10);
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = night ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = -RW / 2 + 12; x <= RW / 2 - 12; x += 12) {
        const tall = Math.round((x + RW / 2) / 12) % 5 === 0;
        ctx.moveTo(x, RH / 2 - 4);
        ctx.lineTo(x, RH / 2 - (tall ? 16 : 9));
      }
      ctx.stroke();
      ctx.restore();
    }
    function drawBgImage(src: string, ox: number, oy: number, iw: number, ih: number) {
      let img = bgImgCache.get(src);
      if (!img) {
        const im = new Image();
        im.onload = () => rerender();
        im.src = src;
        bgImgCache.set(src, im);
        if (bgImgCache.size > 12) bgImgCache.delete(bgImgCache.keys().next().value as string);
        return;
      }
      if (img.complete && img.naturalWidth) ctx.drawImage(img, X(ox), Y(oy), iw * cam.zoom, ih * cam.zoom);
    }
  }, [color, width, showOriginal, keepOriginalUnder, rulerOn, rulerAngle, rulerOff]);

  const imgCache = useRef(new Map<string, HTMLImageElement>()).current;
  const bgImgCache = useRef(new Map<string, HTMLImageElement>()).current;

  useEffect(() => { draw(); });

  // Keep the rename input in sync with the active board.
  useEffect(() => {
    setRenameDraft(board?.name ?? '');
  }, [boardId, board?.name]);

  useEffect(() => {
    const onResize = () => draw();
    window.addEventListener('resize', onResize);
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === ' ') spaceDown.current = true;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') { e.preventDefault(); copySelected(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') { e.preventDefault(); pasteCopied(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { if (selectedRef.current.size) { e.preventDefault(); deleteSelected(); } }
      else if (e.key === 'f' || e.key === 'F') fitToContent();
      else if (e.key === '0') resetView();
      else if (e.key === 'p' || e.key === 'P') setTool('pen');
      else if (e.key === 'h' || e.key === 'H') setTool('highlighter');
      else if (e.key === 'e' || e.key === 'E') setTool('eraser');
      else if (e.key === 'v' || e.key === 'V') setTool('select');
      else if (e.key === 't' || e.key === 'T') setTool('text');
      else if (e.key === 'r' || e.key === 'R') setRulerOn((v) => !v);
    };
    const onKeyUp = (e: KeyboardEvent) => { if (e.key === ' ') spaceDown.current = false; };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => { window.removeEventListener('resize', onResize); window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKeyUp); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [undo, redo, copySelected, pasteCopied]);

  const runBeautify = useCallback((ids?: string[]) => {
    const t0 = performance.now();
    setBusy(true);
    setStatus('Beautifying…');
    setTimeout(() => {
      const all = strokesRef.current;
      const targets = ids ? all.filter((s) => ids.includes(s.id)) : all.filter((s) => !s.beautified && s.tool === 'pen');
      if (targets.length === 0) { setStatus('Nothing to beautify.'); setBusy(false); rerender(); return; }
      const distPx = lang === 'bangla' ? 150 : 120;
      const groups = groupStrokes(targets, { distPx });
      let changed = 0;
      const byId = new Map(all.map((s) => [s.id, s]));
      const params = profileRef.current.enabled ? profileRef.current.params : undefined;
      for (const g of groups) {
        if (g.kind === 'shape' || g.kind === 'diagram' || g.kind === 'math') continue;
        const gs = g.strokeIds.map((id) => byId.get(id)).filter(Boolean) as Stroke[];
        if (inkStyle === 'clean') {
          // Clean-strokes mode: capped height normalization + One-Euro/RDP/straighten.
          const raws = gs.map((s) => (s.originalPoints ?? s.points).map((p) => ({ ...p })));
          const leveled = normalizeGroupHeight(raws);
          gs.forEach((s, i) => {
            if (s.beautified && s.originalPoints) return;
            const idx = all.findIndex((x) => x.id === s.id);
            if (idx < 0) return;
            const trueRaw = s.points.slice();
            const nb = cleanStroke({ ...s, points: leveled[i] ?? s.points });
            all[idx] = { ...nb, originalPoints: trueRaw };
            changed++;
          });
          continue;
        }
        const corrected = layoutCorrectGroup(gs.map((s) => (s.originalPoints ?? s.points).map((p) => ({ ...p }))), strength, params);
        gs.forEach((s, i) => {
          if (s.beautified && s.originalPoints) return;
          const idx = all.findIndex((x) => x.id === s.id);
          if (idx < 0) return;
          const trueRaw = s.points.slice();
          const raw = corrected[i] ?? s.points;
          const nb = beautifyStroke({ ...s, points: raw }, strength, params);
          all[idx] = { ...nb, originalPoints: trueRaw };
          changed++;
        });
      }
      if (changed > 0) {
        undoRef.current.push(targets.map((s) => ({ ...s })));
        if (undoRef.current.length > 60) undoRef.current.shift();
        redoRef.current = [];
        persist(strokesRef.current, camRef.current);
        try {
          const prof = profileRef.current;
          if (prof.enabled) {
            const sampleIds = new Set(targets.slice(0, 6).map((s) => s.id));
            const after = new Map(strokesRef.current.map((s) => [s.id, s]));
            const updated = learnFromFeedback(prof, {
              script: lang === 'bangla' ? 'bangla' : lang === 'english' ? 'english' : lang === 'mixed' ? 'mixed' : 'unknown',
              accepted: true, strength,
              original: targets.slice(0, 6).map((s) => (s.originalPoints ?? s.points).slice(0, 200)),
              beautified: [...sampleIds].map((id) => (after.get(id)?.points ?? []).slice(0, 200)),
            });
            profileRef.current = updated;
            saveProfile(updated);
            setMemCount(updated.examples.length);
          }
        } catch { /* memory must never break drawing */ }
        setStatus(`Beautified ${changed} stroke${changed === 1 ? '' : 's'} (${strength}) in ${Math.round(performance.now() - t0)}ms — originals kept.`);
      } else {
        setStatus('No handwriting groups qualified (shapes/math/diagrams protected).');
      }
      setBusy(false);
      rerender();
    }, 0);
  }, [lang, strength, inkStyle, persist]);

  /** Replace a recognized line's ink with an editable text object (undo-safe). */
  const convertLineToText = useCallback(async (strokes: Stroke[], result: RecResult) => {
    await ensureFonts();
    pushUndo();
    const ids = new Set(strokes.map((s) => s.id));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of strokes) for (const p of (s.originalPoints ?? s.points)) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    if (!isFinite(x0)) return;
    const font = pickFont(result.text);
    const startPx = Math.max(14, Math.min(110, (y1 - y0) * 0.9));
    const px = fitFontSize(result.text, font, Math.max(40, (x1 - x0) * 1.05), startPx, measureCanvas);
    const textStroke: Stroke = {
      id: uid('t'), points: [{ x: x0, y: y0, t: Date.now() }],
      color: strokes[0]?.color ?? '#f5f2ea', width: px / 6, tool: 'pen',
      font, text: result.text, replaces: [...ids], handwritten: true, createdAt: Date.now(),
    };
    strokesRef.current = [...strokesRef.current.filter((s) => !ids.has(s.id)), textStroke];
    persist(strokesRef.current, camRef.current);
    rerender();
    setStatus(`Converted to text: "${result.text.slice(0, 60)}" — double-click to edit, undo restores ink.`);
  }, [persist, pushUndo]);

  /** Recognize grouped lines and apply recMode (clean or convert). */
  const recognizeLines = useCallback(async (lines: TextLine[], byId: Map<string, Stroke>) => {
    let n = 0;
    for (const line of lines) {
      const ids = line.words.flatMap((w) => w.strokeIds);
      const strokes = ids.map((id) => byId.get(id)).filter((s): s is Stroke => !!s);
      if (!strokes.length) continue;
      n++;
      setAiBusy((b) => b + 1);
      setStatus(`Sending strokes to AI service… (line ${n}/${lines.length})`);
      try {
        const result = await recognizerRef.current.recognize(strokes);
        recRef.current.set(ids.join(','), { line, result });
        if (result.confidence < LOW_CONF) {
          const canvas = canvasRef.current;
          const cam = camRef.current;
          const lb = line.bbox;
          const cx = canvas ? ((lb.x + lb.w / 2 - cam.x) * cam.zoom + canvas.clientWidth / 2) : 100;
          const ty = canvas ? ((lb.y - cam.y) * cam.zoom + canvas.clientHeight / 2) : 100;
          const key = ids.join(',');
          setChips((prev) => [...prev.slice(-4), {
            key, ids, text: result.text, alternatives: result.alternatives,
            lang: result.lang, sx: cx, sy: ty,
          }]);
          setStatus(`Low confidence (${Math.round(result.confidence * 100)}%) — pick a transcription from the chips, or keep the ink.`);
        } else if (recMode === 'convert') {
          await convertLineToText(strokes, result);
        } else {
          pushUndo();
          const idSet = new Set(ids);
          strokesRef.current = strokesRef.current.map((s) => (idSet.has(s.id) ? cleanStroke(s) : s));
          persist(strokesRef.current, camRef.current);
          rerender();
          setStatus(`Recognized "${result.text.slice(0, 60)}" (${result.lang}) — cleaned strokes.`);
        }
      } catch (e) {
        setStatus(`Recognition failed: ${(e as Error).message}`);
      } finally {
        setAiBusy((b) => Math.max(0, b - 1));
      }
    }
  }, [recMode, convertLineToText, persist, pushUndo]);

  /** Manual mode: recognize the current lasso selection. */
  const recognizeIds = (ids: string[]) => {
    const sel = strokesRef.current.filter((s) => ids.includes(s.id) && s.tool === 'pen');
    if (!sel.length) { setStatus('Select handwritten pen strokes first.'); return; }
    const lines = groupIntoLines(sel, { pauseMs: 700 });
    void recognizeLines(lines, new Map(sel.map((s) => [s.id, s])));
  };

  /** Beautify buttons route to recognition in Handwriting mode with a selection. */
  const beautifyOrRecognize = () => {
    if (hwMode && selectedRef.current.size > 0) recognizeIds([...selectedRef.current]);
    else runBeautify(selectedRef.current.size ? [...selectedRef.current] : undefined);
  };

  /** AI toggle with explicit privacy notice on first enable. */
  const toggleAi = (v: boolean) => {
    setAiEnabled(v);
    if (v) {
      try {
        if (!window.localStorage.getItem(NOTICE_KEY)) setAiNotice(true);
      } catch {
        setAiNotice(true);
      }
    }
  };

  /** Apply a user's chip choice as the transcription (low-confidence flow). */
  const applyChip = (chip: { key: string; ids: string[]; lang: RecLang }, text: string) => {
    const strokes = chip.ids
      .map((id) => strokesRef.current.find((s) => s.id === id))
      .filter((s): s is Stroke => !!s);
    setChips((prev) => prev.filter((c) => c.key !== chip.key));
    if (!strokes.length) { setStatus('Original strokes are gone — chip dismissed.'); return; }
    const clean = normalizeBanglaNFC(text);
    void convertLineToText(strokes, { text: clean, lang: verifyLang(clean, chip.lang), confidence: 1, alternatives: [] });
  };

  /** Group handwritten strokes after pause, then recognize each line (Phase 3). */
  const queueHwRecognition = useCallback(() => {
    if (hwTimerRef.current) clearTimeout(hwTimerRef.current);
    hwTimerRef.current = setTimeout(async () => {
      const pending = strokesRef.current.filter((s) => s.handwritten && s.tool === 'pen' && !s.beautified && !processedHwRef.current.has(s.id));
      if (!pending.length) return;
      const lines = groupIntoLines(pending, { pauseMs: 700 });
      const words = lines.reduce((a, l) => a + l.words.length, 0);
      for (const l of lines) for (const w of l.words) for (const id of w.strokeIds) processedHwRef.current.add(id);
      if (!aiEnabled) {
        setStatus(`Handwriting: ${lines.length} line(s), ${words} word(s) grouped — enable "Use AI" to recognize.`);
        return;
      }
      const byId = new Map(pending.map((s) => [s.id, s]));
      void recognizeLines(lines, byId);
    }, 700);
  }, [aiEnabled, recMode, recognizeLines]);

  const scheduleAuto = useCallback(() => {
    if (!autoBeautify) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    setStatus('Writing… beautify queued.');
    timerRef.current = setTimeout(() => runBeautify(), delayMs);
  }, [autoBeautify, delayMs, runBeautify]);

  const revertSelected = useCallback(() => {
    const ids = selectedRef.current.size ? [...selectedRef.current] : strokesRef.current.filter((s) => s.beautified).map((s) => s.id);
    if (!ids.length) { setStatus('Nothing to revert.'); return; }
    pushUndo();
    let n = 0;
    const before = new Map(strokesRef.current.map((s) => [s.id, s.points]));
    strokesRef.current = strokesRef.current.map((s) => ids.includes(s.id) && s.originalPoints ? (n++, revertStroke(s)) : s);
    try {
      const prof = profileRef.current;
      if (prof.enabled && n > 0) {
        const rej = strokesRef.current.filter((s) => ids.includes(s.id)).slice(0, 4);
        const updated = learnFromFeedback(prof, {
          script: 'unknown', accepted: false, strength,
          original: rej.map((s) => s.points.slice(0, 200)),
          beautified: rej.map((s) => (before.get(s.id) ?? s.points).slice(0, 200)),
        });
        profileRef.current = updated; saveProfile(updated); setMemCount(updated.examples.length);
      }
    } catch { /* ignore */ }
    persist(strokesRef.current, camRef.current);
    setStatus(`Reverted ${n} stroke${n === 1 ? '' : 's'} to original ink (recorded as rejected).`);
    rerender();
  }, [persist, pushUndo, strength]);

  const deleteSelected = useCallback(() => {
    if (!selectedRef.current.size) return;
    pushUndo();
    strokesRef.current = strokesRef.current.filter((s) => !selectedRef.current.has(s.id));
    selectedRef.current.clear();
    persist(strokesRef.current, camRef.current);
    rerender();
  }, [persist, pushUndo]);

  function copySelected() {
    const sel = strokesRef.current.filter((s) => selectedRef.current.has(s.id));
    if (!sel.length) { setStatus('Nothing selected to copy.'); return; }
    copyRef.current = sel.map((s) => ({ ...s, points: s.points.map((p) => ({ ...p })) }));
    setStatus(`Copied ${sel.length} object${sel.length === 1 ? '' : 's'} — Ctrl+V pastes.`);
  }

  function pasteCopied(atCenter = true) {
    const buf = copyRef.current;
    if (!buf.length) { setStatus('Clipboard empty — select objects and Ctrl+C first.'); return; }
    pushUndo();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of buf) for (const p of s.points) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    const cam = camRef.current;
    const dx = (atCenter ? cam.x - (x0 + x1) / 2 : 24) + 0;
    const dy = (atCenter ? cam.y - (y0 + y1) / 2 : 24) + 0;
    const clones: Stroke[] = buf.map((s) => {
      const np = s.points.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy }));
      const c: Stroke = { ...s, id: uid('s'), points: np, createdAt: Date.now() };
      delete c.originalPoints; delete c.beautified; delete c.strength;
      if (c.shape && c.ax !== undefined && c.bx !== undefined && c.ay !== undefined && c.by !== undefined) {
        c.ax += dx; c.ay += dy; c.bx += dx; c.by += dy;
      }
      return c;
    });
    strokesRef.current = [...strokesRef.current, ...clones];
    selectedRef.current.clear();
    clones.forEach((c) => selectedRef.current.add(c.id));
    persist(strokesRef.current, camRef.current);
    setStatus(`Pasted ${clones.length} object${clones.length === 1 ? '' : 's'}.`);
    rerender();
  }

  function duplicateSelected() {
    const sel = strokesRef.current.filter((s) => selectedRef.current.has(s.id));
    if (!sel.length) { setStatus('Nothing selected to duplicate.'); return; }
    copyRef.current = sel.map((s) => ({ ...s, points: s.points.map((p) => ({ ...p })) }));
    // Duplicate offsets instead of centering: nudge down-right.
    pushUndo();
    const clones: Stroke[] = copyRef.current.map((s) => {
      const np = s.points.map((p) => ({ ...p, x: p.x + 28, y: p.y + 28 }));
      const c: Stroke = { ...s, id: uid('s'), points: np, createdAt: Date.now() };
      delete c.originalPoints; delete c.beautified; delete c.strength;
      if (c.shape && c.ax !== undefined && c.bx !== undefined && c.ay !== undefined && c.by !== undefined) {
        c.ax += 28; c.ay += 28; c.bx += 28; c.by += 28;
      }
      return c;
    });
    strokesRef.current = [...strokesRef.current, ...clones];
    selectedRef.current.clear();
    clones.forEach((c) => selectedRef.current.add(c.id));
    persist(strokesRef.current, camRef.current);
    setStatus(`Duplicated ${clones.length} object${clones.length === 1 ? '' : 's'}.`);
    rerender();
  }

  const zoomBy = useCallback((f: number) => {
    const cam = camRef.current;
    camRef.current = { ...cam, zoom: Math.max(0.15, Math.min(6, cam.zoom * f)) };
    persist(strokesRef.current, camRef.current);
    rerender();
  }, [persist]);

  const fitToContent = useCallback(() => {
    const ss = strokesRef.current;
    const tpl = templateRect();
    if (!ss.length && !tpl) { camRef.current = { x: 0, y: 0, zoom: 1 }; rerender(); return; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of ss) for (const p of s.points) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    if (tpl) {
      x0 = Math.min(x0, tpl.ox); y0 = Math.min(y0, tpl.oy);
      x1 = Math.max(x1, tpl.ox + tpl.w); y1 = Math.max(y1, tpl.oy + tpl.h);
    }
    const c = canvasRef.current!;
    const w = c.clientWidth, h = c.clientHeight;
    const z = Math.max(0.1, Math.min(3, Math.min(w / Math.max(50, x1 - x0 + 100), h / Math.max(50, y1 - y0 + 100))));
    camRef.current = { x: (x0 + x1) / 2, y: (y0 + y1) / 2, zoom: z };
    persist(strokesRef.current, camRef.current);
    rerender();
  }, [persist]);

  const resetView = useCallback(() => {
    camRef.current = { x: 0, y: 0, zoom: 1 };
    persist(strokesRef.current, camRef.current);
    rerender();
  }, [persist]);

  /** Hit-test: topmost stroke near a world point (eraser, select-drag). */
  const hitStroke = (wx: number, wy: number): Stroke | undefined => strokesRef.current.find((s) => {
    if (s.shape && s.ax !== undefined && s.ay !== undefined && s.bx !== undefined && s.by !== undefined) {
      const { shape, ax, ay, bx, by } = s;
      const tol = Math.max(10, s.width * 2);
      const dSeg = (x1: number, y1: number, x2: number, y2: number): number => {
        const dx = x2 - x1, dy = y2 - y1;
        const L2 = dx * dx + dy * dy;
        const t = L2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((wx - x1) * dx + (wy - y1) * dy) / L2));
        return Math.hypot(wx - (x1 + dx * t), wy - (y1 + dy * t));
      };
      if (shape === 'line' || shape === 'arrow') return dSeg(ax, ay, bx, by) < tol;
      if (shape === 'rect') {
        const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx), y0 = Math.min(ay, by), y1 = Math.max(ay, by);
        return wx > x0 - tol && wx < x1 + tol && wy > y0 - tol && wy < y1 + tol;
      }
      const cx = (ax + bx) / 2, cy = (ay + by) / 2;
      const rx = Math.abs(bx - ax) / 2, ry = Math.abs(by - ay) / 2;
      if (rx < 1 || ry < 1) return false;
      const n = ((wx - cx) / (rx + tol)) ** 2 + ((wy - cy) / (ry + tol)) ** 2;
      return n <= 1;
    }
    const pts = s.points;
    for (let i = 0; i < pts.length; i++) {
      if (Math.hypot(pts[i].x - wx, pts[i].y - wy) < Math.max(8, s.width * 2)) return true;
    }
    if ((s.text !== undefined || s.isImage) && pts[0] && Math.hypot(pts[0].x - wx, pts[0].y - wy) < 60) return true;
    return false;
  });

  const eraseAt = (wx: number, wy: number) => {
    const hit = hitStroke(wx, wy);
    if (hit) {
      pushUndo();
      strokesRef.current = strokesRef.current.filter((s) => s.id !== hit.id);
      selectedRef.current.delete(hit.id);
      persist(strokesRef.current, camRef.current);
      rerender();
    }
  };

  /** Project a client point onto the ruler edge (screen-locked straightedge). */
  const snapRuler = (clientX: number, clientY: number): { x: number; y: number } | null => {
    if (!rulerOn) return null;
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const sx = clientX - rect.left, sy = clientY - rect.top;
    const cx = rect.width / 2, cy = rect.height / 2 + rulerOff;
    const th = (rulerAngle * Math.PI) / 180;
    const dx = Math.cos(th), dy = Math.sin(th);
    const t = (sx - cx) * dx + (sy - cy) * dy;
    const wpt = toWorld(cx + dx * t + rect.left, cy + dy * t + rect.top);
    return { x: wpt.x, y: wpt.y };
  };

  /** Commit the inline text/sticky editor to a board object. No popups. */
  const commitEdit = () => {
    const ed = editing;
    if (!ed) return;
    const txt = editText.trim();
    if (ed.editId) {
      // Editing an existing converted text object (double-click flow).
      pushUndo();
      if (!txt) {
        strokesRef.current = strokesRef.current.filter((s) => s.id !== ed.editId);
        setStatus('Text deleted.');
      } else {
        strokesRef.current = strokesRef.current.map((s) => s.id === ed.editId ? { ...s, text: txt } : s);
        setStatus('Text updated.');
      }
      persist(strokesRef.current, camRef.current);
      setEditing(null);
      rerender();
      return;
    }
    if (txt) {
      pushUndo();
      strokesRef.current = [...strokesRef.current, {
        id: uid('t'), points: [{ x: ed.wx, y: ed.wy, t: Date.now() }],
        color: ed.kind === 'sticky' ? '#fbbf24' : color,
        width: ed.kind === 'sticky' ? 5 : 4, tool: 'pen', createdAt: Date.now(), text: txt,
      }];
      persist(strokesRef.current, camRef.current);
      setStatus(ed.kind === 'sticky' ? 'Sticky note added.' : 'Text added.');
    }
    setEditing(null);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    canvas.setPointerCapture(e.pointerId);
    if (e.pointerType === 'pen') penActiveRef.current++;
    if (shouldIgnorePointer(e.pointerType, penActiveRef.current > 0, palmReject)) {
      pointersRef.current.delete(e.pointerId);
      return; // palm rejection: ignore touch while pen is down
    }
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size === 2) {
      // Second finger down -> pinch-zoom gesture (discard provisional stroke)
      const [a, b] = [...pointersRef.current.values()];
      const d0 = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const anchor = toWorld((a.x + b.x) / 2, (a.y + b.y) / 2);
      pinchRef.current = { d0, zoom0: camRef.current.zoom, wx: anchor.x, wy: anchor.y };
      drawingRef.current = null;
      lassoRef.current = null;
      panningRef.current = null;
      setStatus('Pinch to zoom, drag with two fingers to move.');
      return;
    }
    if (pinchRef.current) return;
    if (e.button === 2) return; // right-click reserved (no context draw)
    if (tool === 'pan' || spaceDown.current || e.button === 1) {
      panningRef.current = { sx: e.clientX, sy: e.clientY, cx: camRef.current.x, cy: camRef.current.y };
      return;
    }
    if (tool === 'select') {
      const wpt0 = toWorld(e.clientX, e.clientY);
      const hit = hitStroke(wpt0.x, wpt0.y);
      if (hit) {
        // Drag directly on an object to move it (selects it first if needed)
        if (!selectedRef.current.has(hit.id)) {
          selectedRef.current.clear();
          selectedRef.current.add(hit.id);
        }
        pushUndo();
        moveRef.current = {
          sx: wpt0.x, sy: wpt0.y,
          orig: new Map(strokesRef.current.filter((s) => selectedRef.current.has(s.id)).map((s) => [s.id, { ...s, points: s.points.slice() }] as [string, Stroke])),
          moved: false,
        };
        setStatus(`${selectedRef.current.size} selected — drag to move, Del removes.`);
        draw();
        return;
      }
      // Freehand lasso (Microsoft-Whiteboard-style selection)
      const rect = canvas.getBoundingClientRect();
      lassoRef.current = [{ x: e.clientX - rect.left, y: e.clientY - rect.top }];
      return;
    }
    if (tool === 'eraser') {
      const wpt = toWorld(e.clientX, e.clientY);
      eraseAt(wpt.x, wpt.y);
      drawingRef.current = { pts: [], id: 'erase' };
      return;
    }
    if (tool === 'text' || tool === 'sticky') {
      // Inline editor overlay — never a popup dialog.
      if (editing) commitEdit();
      const wpt = toWorld(e.clientX, e.clientY);
      const root = wrapRef.current?.getBoundingClientRect();
      setEditing({
        wx: wpt.x, wy: wpt.y,
        sx: root ? e.clientX - root.left : e.clientX,
        sy: root ? e.clientY - root.top : e.clientY,
        kind: tool,
      });
      setEditText('');
      return;
    }
    const samples = expandCoalesced(e.nativeEvent);
    const startPts: InkPoint[] = [];
    for (const s of samples) {
      const wpt = toWorld(s.x, s.y);
      wpt.p = s.p; wpt.pt = s.pt;
      if ((tool === 'pen' || tool === 'highlighter') && rulerOn) {
        const snapped = snapRuler(s.x, s.y);
        if (snapped) { wpt.x = snapped.x; wpt.y = snapped.y; }
      }
      const last = startPts[startPts.length - 1];
      if (!last || Math.hypot(last.x - wpt.x, last.y - wpt.y) > 0.5) startPts.push(wpt);
    }
    if (!startPts.length) return;
    drawingRef.current = { pts: startPts, id: uid('s') };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (pointersRef.current.has(e.pointerId)) pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pinch = pinchRef.current;
    if (pinch && pointersRef.current.size >= 2) {
      const [a, b] = [...pointersRef.current.values()];
      const d = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const canvas = canvasRef.current!;
      const rect = canvas.getBoundingClientRect();
      const z = Math.max(0.15, Math.min(6, pinch.zoom0 * d / pinch.d0));
      camRef.current = {
        x: pinch.wx - (((a.x + b.x) / 2 - rect.left) - rect.width / 2) / z,
        y: pinch.wy - (((a.y + b.y) / 2 - rect.top) - rect.height / 2) / z,
        zoom: z,
      };
      draw();
      return;
    }
    if (panningRef.current) {
      const cam = camRef.current;
      const dx = (e.clientX - panningRef.current.sx) / cam.zoom;
      const dy = (e.clientY - panningRef.current.sy) / cam.zoom;
      camRef.current = { ...cam, x: panningRef.current.cx - dx, y: panningRef.current.cy - dy };
      draw();
      return;
    }
    if (moveRef.current) {
      const wpt = toWorld(e.clientX, e.clientY);
      const m = moveRef.current;
      const dx = wpt.x - m.sx, dy = wpt.y - m.sy;
      if (Math.abs(dx) + Math.abs(dy) > 0.5) m.moved = true;
      strokesRef.current = strokesRef.current.map((s) => {
        const o = m.orig.get(s.id);
        if (!o) return s;
        if (o.shape && o.ax !== undefined && o.ay !== undefined && o.bx !== undefined && o.by !== undefined) {
          const ax = o.ax + dx, ay = o.ay + dy, bx = o.bx + dx, by = o.by + dy;
          return { ...s, ax, ay, bx, by, points: shapePoints(o.shape, { x: ax, y: ay, t: Date.now() }, { x: bx, y: by, t: Date.now() }) };
        }
        return { ...s, points: o.points.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })) };
      });
      draw();
      return;
    }
    if (lassoRef.current) {
      const canvas = canvasRef.current!;
      const rect = canvas.getBoundingClientRect();
      const L = lassoRef.current;
      const last = L[L.length - 1];
      const nx = e.clientX - rect.left, ny = e.clientY - rect.top;
      if (Math.hypot(nx - last.x, ny - last.y) > 3) {
        L.push({ x: nx, y: ny });
        draw();
      }
      return;
    }
    if (!drawingRef.current || drawingRef.current.id === 'erase') {
      if (tool === 'eraser' && e.buttons) {
        const wpt = toWorld(e.clientX, e.clientY);
        eraseAt(wpt.x, wpt.y);
      }
      return;
    }
    const samples = expandCoalesced(e.nativeEvent);
    const pts = drawingRef.current.pts;
    let drew = false;
    for (const s of samples) {
      const wpt = toWorld(s.x, s.y);
      wpt.p = s.p; wpt.pt = s.pt;
      if ((tool === 'pen' || tool === 'highlighter') && rulerOn) {
        const snapped = snapRuler(s.x, s.y);
        if (snapped) { wpt.x = snapped.x; wpt.y = snapped.y; }
      }
      if (pts.length === 0 || Math.hypot(pts[pts.length - 1].x - wpt.x, pts[pts.length - 1].y - wpt.y) > 0.5) {
        pts.push(wpt);
        drew = true;
      }
    }
    if (drew) draw();
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === 'pen') penActiveRef.current = Math.max(0, penActiveRef.current - 1);
    pointersRef.current.delete(e.pointerId);
    if (pinchRef.current) {
      if (pointersRef.current.size < 2) {
        pinchRef.current = null;
        persist(strokesRef.current, camRef.current);
        setStatus('Pinch zoom done.');
        rerender();
      }
      return;
    }
    if (panningRef.current) {
      panningRef.current = null;
      persist(strokesRef.current, camRef.current);
      rerender();
      return;
    }
    if (moveRef.current) {
      const m = moveRef.current;
      moveRef.current = null;
      if (m.moved) {
        persist(strokesRef.current, camRef.current);
        setStatus(`Moved ${m.orig.size} object${m.orig.size === 1 ? '' : 's'}.`);
      }
      rerender();
      return;
    }
    if (lassoRef.current) {
      const L = lassoRef.current;
      lassoRef.current = null;
      const canvas = canvasRef.current!;
      const rect = canvas.getBoundingClientRect();
      const toWx = (sx: number) => (sx - rect.width / 2) / camRef.current.zoom + camRef.current.x;
      const toWy = (sy: number) => (sy - rect.height / 2) / camRef.current.zoom + camRef.current.y;
      // Tap (tiny lasso) = single select / clear; loop = lasso select.
      let travel = 0;
      for (let i = 1; i < L.length; i++) travel += Math.hypot(L[i].x - L[i - 1].x, L[i].y - L[i - 1].y);
      selectedRef.current.clear();
      if (travel < 8 && L.length > 0) {
        const wpt = toWorld(L[0].x + rect.left, L[0].y + rect.top);
        const hit = hitStroke(wpt.x, wpt.y);
        if (hit) selectedRef.current.add(hit.id);
      } else if (L.length > 2) {
        const poly = L.map((p) => ({ x: toWx(p.x), y: toWy(p.y) }));
        for (const s of strokesRef.current) {
          const pts = s.originalPoints ?? s.points;
          if (pts.some((p) => pointInPolygon(p.x, p.y, poly))) selectedRef.current.add(s.id);
        }
      }
      setStatus(selectedRef.current.size ? `${selectedRef.current.size} selected — drag to move, Delete removes, Beautify processes selection.` : 'Selection cleared.');
      rerender();
      return;
    }
    const d = drawingRef.current;
    drawingRef.current = null;
    if (!d || d.id === 'erase' || d.pts.length === 0) return;
    pushUndo();
    let pts = d.pts;
    const isShapeTool = tool === 'line' || tool === 'arrow' || tool === 'rect' || tool === 'ellipse';
    let shapeParams: { shape: 'line' | 'arrow' | 'rect' | 'ellipse'; ax: number; ay: number; bx: number; by: number } | null = null;
    if (isShapeTool && pts.length > 1) {
      const a = pts[0], b = pts[pts.length - 1];
      shapeParams = { shape: tool as 'line' | 'arrow' | 'rect' | 'ellipse', ax: a.x, ay: a.y, bx: b.x, by: b.y };
      pts = shapePoints(tool, a, b);
    }
    const strokeTool = tool === 'highlighter' ? 'highlighter' : isShapeTool ? tool : 'pen';
    // Ink-to-shape: deliberately-drawn rough shapes become perfect geometry.
    if (!isShapeTool && tool === 'pen' && autoShape) {
      const found = detectInkShape(pts);
      if (found) {
        const a = { x: found.ax, y: found.ay, t: Date.now() }, b = { x: found.bx, y: found.by, t: Date.now() };
        strokesRef.current = [...strokesRef.current, {
          id: d.id, points: shapePoints(found.shape, a, b), color, width,
          tool: found.shape, shape: found.shape, ax: found.ax, ay: found.ay, bx: found.bx, by: found.by,
          createdAt: Date.now(),
        }];
        persist(strokesRef.current, camRef.current);
        setStatus(`Converted to ${found.shape}.`);
        rerender();
        return;
      }
    }
    strokesRef.current = [...strokesRef.current, {
      id: d.id, points: pts, color, width, tool: strokeTool,
      ...(shapeParams ? { shape: shapeParams.shape, ax: shapeParams.ax, ay: shapeParams.ay, bx: shapeParams.bx, by: shapeParams.by } : {}),
      handwritten: hwMode && !isShapeTool && tool === 'pen',
      createdAt: Date.now(),
    }];
    persist(strokesRef.current, camRef.current);
    rerender();
    if (autoBeautify && strokeTool === 'pen') scheduleAuto();
    else if (!autoBeautify) setStatus('Stroke saved (Auto Beautify off).');
    if (hwMode && strokeTool === 'pen' && !isShapeTool) queueHwRecognition();
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const wpt = toWorld(e.clientX, e.clientY);
    const hit = hitStroke(wpt.x, wpt.y);
    if (hit && hit.text !== undefined && !hit.isImage && hit.points[0]) {
      const root = wrapRef.current?.getBoundingClientRect();
      setEditing({
        wx: hit.points[0].x, wy: hit.points[0].y,
        sx: root ? e.clientX - root.left : e.clientX,
        sy: root ? e.clientY - root.top : e.clientY,
        kind: 'text', editId: hit.id,
      });
      setEditText(hit.text);
      setStatus('Editing text — Enter saves, Esc cancels, empty deletes.');
    }
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {    const cam = camRef.current;
    const factor = Math.exp(-e.deltaY * 0.0012);
    camRef.current = { ...cam, zoom: Math.max(0.15, Math.min(6, cam.zoom * factor)) };
    rerender();
  };

  function shapePoints(kind: string, a: InkPoint, b: InkPoint): InkPoint[] {
    const pts: InkPoint[] = [];
    const N = 24;
    if (kind === 'line' || kind === 'arrow') {
      for (let i = 0; i <= N; i++) pts.push({ x: a.x + (b.x - a.x) * i / N, y: a.y + (b.y - a.y) * i / N, t: Date.now() });
      if (kind === 'arrow') {
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        const L = 18;
        for (let i = 0; i <= 8; i++) pts.push({ x: b.x - Math.cos(ang - 0.45) * L * i / 8, y: b.y - Math.sin(ang - 0.45) * L * i / 8, t: Date.now() });
        for (let i = 0; i <= 8; i++) pts.push({ x: b.x - Math.cos(ang + 0.45) * L * i / 8, y: b.y - Math.sin(ang + 0.45) * L * i / 8, t: Date.now() });
      }
      return pts;
    }
    if (kind === 'rect') {
      const cs = [{ x: a.x, y: a.y }, { x: b.x, y: a.y }, { x: b.x, y: b.y }, { x: a.x, y: b.y }, { x: a.x, y: a.y }];
      for (let s = 0; s < 4; s++) for (let i = 0; i <= 8; i++) pts.push({ x: cs[s].x + (cs[s + 1].x - cs[s].x) * i / 8, y: cs[s].y + (cs[s + 1].y - cs[s].y) * i / 8, t: Date.now() });
      return pts;
    }
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2, rx = Math.abs(b.x - a.x) / 2, ry = Math.abs(b.y - a.y) / 2;
    for (let i = 0; i <= 48; i++) { const t = i / 48 * Math.PI * 2; pts.push({ x: cx + Math.cos(t) * rx, y: cy + Math.sin(t) * ry, t: Date.now() }); }
    return pts;
  }

  /** Current template rect for export, or null. */
  const templateRect = (): { src: string; ox: number; oy: number; w: number; h: number } | null => {
    const pdf = pdfRef.current;
    if (pdf && pdf.pages[pdf.pageIndex]) {
      return { src: pdf.pages[pdf.pageIndex], ox: pdf.ox, oy: pdf.oy, w: pdf.pw, h: pdf.ph };
    }
    const b = bgRef.current;
    if (b.type === 'image' && b.imageSrc) {
      return { src: b.imageSrc, ox: b.ox ?? 0, oy: b.oy ?? 0, w: b.w ?? 600, h: b.h ?? 400 };
    }
    return null;
  };

  const exportPNG = () => {
    const ss = strokesRef.current;
    if (!ss.length && !templateRect()) { setStatus('Board is empty — nothing to export.'); return; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of ss) for (const p of s.points) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    const tplPng = templateRect();
    if (tplPng) {
      x0 = Math.min(x0, tplPng.ox); y0 = Math.min(y0, tplPng.oy);
      x1 = Math.max(x1, tplPng.ox + tplPng.w); y1 = Math.max(y1, tplPng.oy + tplPng.h);
    }
    const pad = 40;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(x1 - x0 + pad * 2));
    c.height = Math.max(1, Math.ceil(y1 - y0 + pad * 2));
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
    if (tplPng) {
      const im = bgImgCache.get(tplPng.src);
      if (im && im.complete && im.naturalWidth) ctx.drawImage(im, tplPng.ox - x0 + pad, tplPng.oy - y0 + pad, tplPng.w, tplPng.h);
    }
    for (const s of ss) {
      const pts = showOriginal && s.originalPoints ? s.originalPoints : s.points;
      ctx.strokeStyle = s.color; ctx.lineWidth = s.width; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      pts.forEach((p, i) => i ? ctx.lineTo(p.x - x0 + pad, p.y - y0 + pad) : ctx.moveTo(p.x - x0 + pad, p.y - y0 + pad));
      ctx.stroke();
      if (s.text) { ctx.fillStyle = s.color; ctx.font = `${s.width * 6}px sans-serif`; ctx.fillText(s.text, pts[0].x - x0 + pad, pts[0].y - y0 + pad); }
    }
    const a = document.createElement('a');
    a.download = `${board?.name ?? 'board'}.png`;
    a.href = c.toDataURL('image/png');
    a.click();
    setStatus('Exported PNG.');
  };

  const exportPDF = async () => {
    try {
      const { jsPDF } = await import('jspdf');
      const ss = strokesRef.current;
      if (!ss.length && !templateRect()) { setStatus('Board is empty — nothing to export.'); return; }
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const s of ss) for (const p of s.points) {
        x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
      }
      const tplPdf = templateRect();
      if (tplPdf) {
        x0 = Math.min(x0, tplPdf.ox); y0 = Math.min(y0, tplPdf.oy);
        x1 = Math.max(x1, tplPdf.ox + tplPdf.w); y1 = Math.max(y1, tplPdf.oy + tplPdf.h);
      }
      const pdf = new jsPDF({ unit: 'pt', orientation: x1 - x0 > y1 - y0 ? 'landscape' : 'portrait' });
      const pw = pdf.internal.pageSize.getWidth(), ph = pdf.internal.pageSize.getHeight();
      const sc = Math.min(pw / Math.max(1, x1 - x0 + 80), ph / Math.max(1, y1 - y0 + 80));
      if (tplPdf) {
        try { pdf.addImage(tplPdf.src, 'JPEG', 40 + (tplPdf.ox - x0) * sc, 40 + (tplPdf.oy - y0) * sc, tplPdf.w * sc, tplPdf.h * sc); }
        catch { /* template skipped if it doesn't fit PDF image limits */ }
      }
      for (const s of ss) {
        const pts = showOriginal && s.originalPoints ? s.originalPoints : s.points;
        pdf.setDrawColor(s.color);
        pdf.setLineWidth(s.width * 0.6);
        for (let i = 1; i < pts.length; i++) {
          pdf.line(40 + (pts[i - 1].x - x0) * sc, 40 + (pts[i - 1].y - y0) * sc, 40 + (pts[i].x - x0) * sc, 40 + (pts[i].y - y0) * sc);
        }
        if (s.text && pts[0]) { pdf.setTextColor(s.color); pdf.text(s.text, 40 + (pts[0].x - x0) * sc, 40 + (pts[0].y - y0) * sc); }
      }
      pdf.save(`${board?.name ?? 'board'}.pdf`);
      setStatus('Exported PDF.');
    } catch (e) { setStatus(`PDF export failed: ${(e as Error).message}`); }
  };

  const importImage = () => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*';
    inp.onchange = () => {
      const f = inp.files?.[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        const src = reader.result as string;
        const img = new Image();
        img.onload = () => {
          pushUndo();
          const cam = camRef.current;
          const w = Math.min(600, img.naturalWidth), h = w * img.naturalHeight / img.naturalWidth;
          strokesRef.current = [...strokesRef.current, {
            id: uid('img'), points: [{ x: cam.x - w / 2, y: cam.y - h / 2, t: Date.now() }],
            color: '#000', width: 1, tool: 'pen', createdAt: Date.now(), isImage: true, imgSrc: src, w, h,
          }];
          persist(strokesRef.current, camRef.current);
          rerender();
          setStatus('Image placed on board — select + drag to move, eraser to remove.');
        };
        img.src = src;
      };
      reader.readAsDataURL(f);
    };
    inp.click();
  };

  const switchBoard = (id: string) => {
    const b = boards.find((x) => x.id === id);
    if (!b) return;
    strokesRef.current = b.strokes;
    camRef.current = b.camera;
    themeRef.current = b.theme ?? 'night';
    setThemeState(themeRef.current);
    bgRef.current = b.background ?? { type: 'dots' };
    pdfRef.current = b.pdf ?? null;
    moveRef.current = null;
    setEditing(null);
    setChips([]);
    selectedRef.current.clear();
    undoRef.current = []; redoRef.current = [];
    setBoardId(id);
    rerender();
  };

  const setTheme = (t: BoardTheme) => {
    themeRef.current = t;
    setThemeState(t);
    if (t === 'white' && color === COLORS[0]) setColor(COLORS[1]);
    if (t === 'night' && color === COLORS[1]) setColor(COLORS[0]);
    persist(strokesRef.current, camRef.current);
    rerender();
  };

  const setPdfPage = (i: number) => {
    const pdf = pdfRef.current;
    if (!pdf) return;
    pdf.pageIndex = Math.max(0, Math.min(pdf.pages.length - 1, i));
    persist(strokesRef.current, camRef.current);
    rerender();
  };

  const uploadPdf = () => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.pdf,application/pdf';
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return;
      setBusy(true);
      try {
        const { loadPdfTemplate } = await import('./pdfTemplate.ts');
        const cam = camRef.current;
        const data = await loadPdfTemplate(f, { x: cam.x, y: cam.y }, (d, t) => setStatus(`Rendering PDF ${d}/${t}…`));
        pdfRef.current = data;
        persist(strokesRef.current, camRef.current);
        setStatus(`PDF template: ${data.name} — ${data.pages.length} page(s). Write on top.`);
      } catch (e) { setStatus(`PDF load failed: ${(e as Error).message}`); }
      setBusy(false);
      rerender();
    };
    inp.click();
  };

  const uploadImageBg = () => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*';
    inp.onchange = () => {
      const f = inp.files?.[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        const src = reader.result as string;
        const img = new Image();
        img.onload = () => {
          const cam = camRef.current;
          const w = Math.min(1000, img.naturalWidth), h = w * img.naturalHeight / img.naturalWidth;
          bgRef.current = { type: 'image', imageSrc: src, ox: cam.x - w / 2, oy: cam.y - h / 2, w, h };
          pdfRef.current = null;
          persist(strokesRef.current, camRef.current);
          setStatus('Custom image template set as background.');
          rerender();
        };
        img.src = src;
      };
      reader.readAsDataURL(f);
    };
    inp.click();
  };

  const clearBoard = () => {
    if (strokesRef.current.length === 0) return;
    pushUndo();
    strokesRef.current = [];
    selectedRef.current.clear();
    persist(strokesRef.current, camRef.current);
    setStatus('Board cleared.');
    rerender();
  };

  const addBoard = (name?: string) => {
    const finalName = (name ?? boardNameDraft).trim() || `Lesson ${boards.length + 1}`;
    const b = newBoard(finalName);
    const next = [...boards, b];
    setBoards(next);
    try { saveBoards(next); } catch { /* ignore */ }
    setBoardNameDraft('');
    switchBoard(b.id);
  };

  const renameBoard = () => {
    const name = renameDraft.trim();
    if (!name) return;
    const next = boards.map((b) => b.id === boardId ? { ...b, name } : b);
    setBoards(next);
    try { saveBoards(next); } catch { /* ignore */ }
  };

  const deleteBoard = () => {
    if (boards.length <= 1) { setStatus('Cannot delete the last board.'); return; }
    const next = boards.filter((b) => b.id !== boardId);
    setBoards(next);
    try { saveBoards(next); } catch { /* ignore */ }
    switchBoard(next[0].id);
  };

  const cmpCount = strokesRef.current.filter((s) => s.originalPoints).length;
  const lastDev = strokesRef.current.filter((s) => s.originalPoints).slice(-1).map(deviationOf)[0] ?? 0;
  const mem = profileRef.current;
  const byScript = countByScript(mem);

  // Floating toolbar anchor: screen rect of current selection.
  const selBox = (() => {
    if (selectedRef.current.size === 0) return null;
    const canvas = canvasRef.current;
    if (!canvas || canvas.clientWidth === 0) return null;
    const cam = camRef.current;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of strokesRef.current) {
      if (!selectedRef.current.has(s.id)) continue;
      const pts = s.originalPoints ?? s.points;
      if (s.shape && s.ax !== undefined && s.bx !== undefined && s.ay !== undefined && s.by !== undefined) {
        x0 = Math.min(x0, Math.min(s.ax, s.bx)); y0 = Math.min(y0, Math.min(s.ay, s.by));
        x1 = Math.max(x1, Math.max(s.ax, s.bx)); y1 = Math.max(y1, Math.max(s.ay, s.by));
      } else {
        for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
      }
    }
    if (!isFinite(x0)) return null;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const sx0 = (x0 - cam.x) * cam.zoom + w / 2, sx1 = (x1 - cam.x) * cam.zoom + w / 2;
    const sy0 = (y0 - cam.y) * cam.zoom + h / 2;
    return {
      left: Math.max(8, Math.min(w - 260, (sx0 + sx1) / 2 - 120)),
      top: Math.max(64, sy0 - 56),
    };
  })();

  return (
    <div ref={wrapRef} data-wb className={`relative h-[100dvh] w-full overflow-hidden ${theme === 'white' ? 'bg-[#f7f5ef] text-neutral-900' : 'bg-[#131210] text-neutral-100'}`} style={{ fontFamily: '"Noto Sans Bengali","Noto Sans",system-ui,sans-serif' }}>
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full touch-none cursor-crosshair"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
      />

      {/* ── Inline text/sticky editor (no popup dialogs) ─────── */}
      {editing && (
        <textarea
          autoFocus
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          onBlur={() => commitEdit()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitEdit(); }
            else if (e.key === 'Escape') { setEditing(null); }
          }}
          placeholder={editing.kind === 'sticky' ? 'নোট / note…' : 'Type here… Bangla + English (Enter ✓, Esc ✕)'}
          rows={editing.kind === 'sticky' ? 4 : 2}
          style={{ left: Math.min(editing.sx, (wrapRef.current?.clientWidth ?? 400) - 240), top: editing.sy }}
          className={`absolute z-30 w-56 rounded-xl border p-2.5 text-[15px] leading-snug shadow-2xl outline-none backdrop-blur-md ${
            editing.kind === 'sticky'
              ? 'border-amber-300/50 bg-amber-300/95 font-medium text-amber-950 placeholder:text-amber-800/60'
              : 'border-sky-400/50 bg-neutral-900/90 text-neutral-100 placeholder:text-neutral-500'
          }`}
        />
      )}

      {/* ── Top-left: board switcher ─────────────────────────── */}
      <div className="absolute left-4 top-4 z-20 flex items-center gap-2 rounded-2xl border border-white/10 bg-neutral-900/80 py-2 pl-3 pr-2 shadow-xl backdrop-blur-md">
        <Icon d={ICONS.board} />
        <select value={boardId} onChange={(e) => switchBoard(e.target.value)}
          className="max-w-[160px] cursor-pointer bg-transparent text-sm font-medium outline-none [&>option]:bg-neutral-900">
          {boards.map((b) => <option key={b.id} value={b.id}>{b.name} · {b.strokes.length}</option>)}
        </select>
        <button onClick={() => addBoard()} title="New board" className={chipBtn}><Icon d={ICONS.plus} size={15} /></button>
      </div>

      {/* ── Top-right: theme, beautify, dock toggle ──────── */}
      <div className="absolute right-4 top-4 z-20 flex items-center gap-2">
        <button onClick={() => setTheme(theme === 'night' ? 'white' : 'night')}
          title={theme === 'night' ? 'Switch to white board' : 'Switch to night board'}
          className="rounded-2xl border border-white/10 bg-neutral-900/80 p-2.5 text-amber-300 shadow-xl backdrop-blur-md transition hover:bg-white/10 active:scale-95">
          <Icon d={theme === 'night' ? ICONS.sun : ICONS.moon} />
        </button>
        <button onClick={beautifyOrRecognize}
          title="Beautify now"
          className="flex items-center gap-2 rounded-2xl bg-gradient-to-r from-amber-400 to-orange-500 px-4 py-2 text-sm font-semibold text-neutral-950 shadow-xl transition hover:brightness-110 active:scale-95">
          <Icon d={ICONS.spark} size={16} />
          {busy ? 'Working…' : 'Beautify'}
        </button>
        <button onClick={() => setDockOpen(!dockOpen)} title="Toggle control dock"
          className={`rounded-2xl border p-2.5 shadow-xl backdrop-blur-md transition active:scale-95 ${dockOpen ? 'border-sky-400/40 bg-sky-500/20 text-sky-300' : 'border-white/10 bg-neutral-900/80 text-neutral-300'}`}>
          <Icon d={ICONS.sliders} />
        </button>
      </div>

      {/* ── Left: floating tool rail ──────────────────────────── */}
      <div className="absolute left-4 top-1/2 z-20 flex -translate-y-1/2 flex-col items-center gap-1 rounded-2xl border border-white/10 bg-neutral-900/80 p-2 shadow-xl backdrop-blur-md">
        {TOOLS.map((t) => (
          <button key={t.id} onClick={() => {
            setTool(t.id);
            if (t.id === 'pen' || t.id === 'highlighter') setPenPanel(true);
            if (t.id === 'select') setStatus('Select: draw a lasso around objects, or drag an object to move it.');
          }}
            title={t.kbd ? `${t.label} (${t.kbd})` : t.label}
            className={`rounded-xl p-2.5 transition active:scale-90 ${tool === t.id ? 'bg-amber-400 text-neutral-950 shadow-lg shadow-amber-400/30' : 'text-neutral-300 hover:bg-white/10'}`}>
            <Icon d={ICONS[t.id]} />
          </button>
        ))}
        <div className="my-1 h-px w-8 bg-white/10" />
        <button
          onClick={() => {
            setHwMode((v) => {
              setStatus(v ? 'Handwriting mode off — normal drawing.' : 'Handwriting mode on — pen strokes will be recognized as text.');
              return !v;
            });
          }}
          title="Handwriting mode: strokes become text candidates"
          className={`rounded-xl p-2.5 transition active:scale-90 ${hwMode ? 'bg-sky-400 text-neutral-950 shadow-lg shadow-sky-400/30' : 'text-neutral-300 hover:bg-white/10'}`}>
          <Icon d={ICONS.hw} />
        </button>
        <div className="my-1 h-px w-8 bg-white/10" />
        <button onClick={undo} title="Undo (Ctrl+Z)" className={railBtn}><Icon d={ICONS.undo} /></button>
        <button onClick={redo} title="Redo (Ctrl+Y)" className={railBtn}><Icon d={ICONS.redo} /></button>
      </div>

      {/* ── Pen swatch popover ────────────────────────────────── */}
      {penPanel && (tool === 'pen' || tool === 'highlighter') && (
        <div className="absolute left-[74px] top-1/2 z-20 w-44 -translate-y-1/2 rounded-2xl border border-white/10 bg-neutral-900/90 p-3 shadow-xl backdrop-blur-md">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-neutral-400">Ink</span>
            <button onClick={() => setPenPanel(false)} className="text-neutral-500 hover:text-white"><Icon d={ICONS.x} size={14} /></button>
          </div>
          <div className="mb-3 flex flex-wrap gap-2">
            {COLORS.map((c) => (
              <button key={c} onClick={() => setColor(c)} title={c}
                className={`h-7 w-7 rounded-full border-2 transition active:scale-90 ${color === c ? 'scale-110 border-amber-400' : 'border-white/20'}`}
                style={{ background: c }} />
            ))}
          </div>
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-neutral-400">Width · {width}px</span>
          <div className="flex gap-1.5">
            {WIDTHS.map((wd) => (
              <button key={wd} onClick={() => setWidth(wd)}
                className={`flex-1 rounded-lg border py-1.5 text-xs transition active:scale-95 ${width === wd ? 'border-amber-400 bg-amber-400/15 text-amber-300' : 'border-white/10 text-neutral-400 hover:bg-white/5'}`}>{wd}</button>
            ))}
          </div>
        </div>
      )}

      {/* ── Right: control dock ───────────────────────────────── */}
      {dockOpen && (
        <aside className="absolute bottom-20 right-4 top-20 z-20 flex w-72 flex-col gap-3 overflow-y-auto rounded-2xl border border-white/10 bg-neutral-900/85 p-4 shadow-2xl backdrop-blur-md">
          <DockSection title="Boards" icon={ICONS.board} defaultOpen>
            <div className="flex flex-col gap-1.5">
              {boards.map((b) => (
                <button key={b.id} onClick={() => switchBoard(b.id)}
                  className={`flex items-center justify-between rounded-xl px-3 py-2 text-left text-sm transition ${b.id === boardId ? 'bg-amber-400/15 text-amber-200 ring-1 ring-amber-400/40' : 'text-neutral-300 hover:bg-white/5'}`}>
                  <span className="truncate font-medium">{b.name}</span>
                  <span className="ml-2 shrink-0 text-xs text-neutral-500">{b.strokes.length}</span>
                </button>
              ))}
              <div className="mt-1 flex gap-1.5">
                <input
                  value={boardNameDraft}
                  onChange={(e) => setBoardNameDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') addBoard(); }}
                  placeholder="New board name…"
                  className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-xs text-neutral-200 outline-none placeholder:text-neutral-600 focus:border-amber-400/60"
                />
                <button onClick={() => addBoard()} className={miniBtn}>+ Add</button>
              </div>
              <div className="mt-1.5 flex gap-1.5">
                <input
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') renameBoard(); }}
                  placeholder="Rename board…"
                  title="Rename active board"
                  className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-xs text-neutral-200 outline-none placeholder:text-neutral-600 focus:border-amber-400/60"
                />
                <button onClick={renameBoard} className={miniBtn}>Save</button>
                <ArmButton className={`${miniBtn} hover:!border-red-400/50 hover:!text-red-300`} armedClassName={`${miniBtn} !border-red-400 !bg-red-400/15 !text-red-200`} armedLabel="Sure?" onFire={deleteBoard}>Delete</ArmButton>
              </div>
            </div>
          </DockSection>

          <DockSection title="Beautify" icon={ICONS.spark} defaultOpen>
            <Toggle label="Auto Beautify" hint="Process after pause" checked={autoBeautify} onChange={setAutoBeautify} />
            <Toggle label="Use AI to recognize handwriting" hint="Sends stroke images to your /api/recognize backend" checked={aiEnabled} onChange={toggleAi} />
            <p className="mt-1 text-[11px] leading-relaxed text-neutral-500">
              When on, PNG images of your handwriting are POSTed to your own backend,
              which forwards them to a vision AI service. Nothing is sent while off.
            </p>
            {aiEnabled && (
              <>
                <label className="mt-2 block text-xs text-neutral-400">When recognized</label>
                <div className="mt-1 grid grid-cols-2 gap-1.5">
                  {(['clean', 'convert'] as const).map((m) => (
                    <button key={m} onClick={() => setRecMode(m)}
                      className={`rounded-lg border py-1.5 text-xs capitalize transition active:scale-95 ${recMode === m ? 'border-sky-400 bg-sky-400/15 text-sky-200' : 'border-white/10 text-neutral-400 hover:bg-white/5'}`}>
                      {m === 'convert' ? 'Convert to text' : 'Clean strokes'}
                    </button>
                  ))}
                </div>
              </>
            )}
            {aiBusy > 0 && <p className="mt-1 text-[11px] text-amber-300">Recognizing handwriting… ({aiBusy})</p>}
            <label className="mt-2 block text-xs text-neutral-400">Ink style</label>
            <div className="mt-1 grid grid-cols-2 gap-1.5">
              {(['geometric', 'clean'] as const).map((m) => (
                <button key={m} onClick={() => setInkStyle(m)}
                  className={`rounded-lg border py-1.5 text-xs capitalize transition active:scale-95 ${inkStyle === m ? 'border-amber-400 bg-amber-400/15 text-amber-200' : 'border-white/10 text-neutral-400 hover:bg-white/5'}`}>
                  {m === 'clean' ? 'Clean strokes' : 'Geometric'}
                </button>
              ))}
            </div>
            <label className="mt-2 block text-xs text-neutral-400">Strength</label>
            <div className="mt-1 grid grid-cols-3 gap-1.5">
              {(['subtle', 'balanced', 'strong'] as BeautifyStrength[]).map((s) => (
                <button key={s} onClick={() => setStrength(s)}
                  className={`rounded-lg border py-1.5 text-xs capitalize transition active:scale-95 ${strength === s ? 'border-amber-400 bg-amber-400/15 text-amber-200' : 'border-white/10 text-neutral-400 hover:bg-white/5'}`}>{s}</button>
              ))}
            </div>
            <label className="mt-2 block text-xs text-neutral-400">Delay after pause · {delayMs}ms
              <input type="range" min={200} max={2000} step={100} value={delayMs} onChange={(e) => setDelayMs(Number(e.target.value))} className="mt-1 w-full accent-amber-400" />
            </label>
            <label className="mt-2 block text-xs text-neutral-400">Script</label>
            <div className="mt-1 grid grid-cols-4 gap-1.5">
              {(['auto', 'bangla', 'english', 'mixed'] as ScriptPref[]).map((l) => (
                <button key={l} onClick={() => setLang(l)}
                  className={`rounded-lg border py-1.5 text-xs capitalize transition active:scale-95 ${lang === l ? 'border-sky-400 bg-sky-400/15 text-sky-200' : 'border-white/10 text-neutral-400 hover:bg-white/5'}`}>
                  {l === 'bangla' ? 'বাংলা' : l}
                </button>
              ))}
            </div>
            <Toggle label="Compare original" hint="Show raw ink" checked={showOriginal} onChange={setShowOriginal} />
            <Toggle label="Ghost original under" hint="Faint raw layer" checked={keepOriginalUnder} onChange={setKeepOriginalUnder} />
            <div className="mt-2 flex gap-1.5">
              <button onClick={beautifyOrRecognize} className={`${miniBtn} flex-1 !border-amber-400/50 !text-amber-200`}>Beautify now</button>
              <button onClick={revertSelected} className={`${miniBtn} flex-1`}>Revert</button>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-neutral-500">
              Beautified: {cmpCount}{cmpCount > 0 && <> · last shift {lastDev.toFixed(1)}px</>} · shapes, math &amp; diagrams are never touched.
            </p>
          </DockSection>

          <DockSection title="Template & Theme" icon={ICONS.file} defaultOpen>
            <label className="block text-xs text-neutral-400">Board theme</label>
            <div className="mt-1 grid grid-cols-2 gap-1.5">
              <button onClick={() => setTheme('night')}
                className={`flex items-center justify-center gap-1.5 rounded-lg border py-1.5 text-xs transition active:scale-95 ${theme === 'night' ? 'border-amber-400 bg-amber-400/15 text-amber-200' : 'border-white/10 text-neutral-400 hover:bg-white/5'}`}>
                <Icon d={ICONS.moon} size={13} /> Night
              </button>
              <button onClick={() => setTheme('white')}
                className={`flex items-center justify-center gap-1.5 rounded-lg border py-1.5 text-xs transition active:scale-95 ${theme === 'white' ? 'border-amber-400 bg-amber-400/15 text-amber-200' : 'border-white/10 text-neutral-400 hover:bg-white/5'}`}>
                <Icon d={ICONS.sun} size={13} /> White
              </button>
            </div>
            <label className="mt-2 block text-xs text-neutral-400">Background pattern</label>
            <div className="mt-1 grid grid-cols-4 gap-1.5">
              {(['none', 'dots', 'grid', 'lines'] as const).map((t) => (
                <button key={t} onClick={() => { bgRef.current = { ...bgRef.current, type: t }; persist(strokesRef.current, camRef.current); rerender(); }}
                  className={`rounded-lg border py-1.5 text-xs capitalize transition active:scale-95 ${bgRef.current.type === t && !pdfRef.current ? 'border-sky-400 bg-sky-400/15 text-sky-200' : 'border-white/10 text-neutral-400 hover:bg-white/5'}`}>{t}</button>
              ))}
            </div>
            <div className="mt-1.5 grid grid-cols-2 gap-1.5">
              {pdfRef.current ? (
                <ArmButton className={miniBtn} armedClassName={`${miniBtn} !border-amber-400 !text-amber-200`} armedLabel="Replace PDF?" onFire={uploadImageBg}>Image bg</ArmButton>
              ) : (
                <button onClick={uploadImageBg} className={miniBtn}>Image bg</button>
              )}
              <button onClick={uploadPdf} className={miniBtn}>PDF template</button>
            </div>
            {pdfRef.current && (
              <p className="mt-1 text-[11px] leading-relaxed text-neutral-500">The PDF page is opaque, so it covers the pattern behind it.</p>
            )}
            {bgRef.current.type === 'image' && !pdfRef.current && (
              <button onClick={() => { bgRef.current = { type: 'dots' }; persist(strokesRef.current, camRef.current); rerender(); }} className={`${miniBtn} mt-1.5 w-full`}>Remove image bg</button>
            )}
            {pdfRef.current && (
              <div className="mt-2 rounded-lg border border-sky-400/30 bg-sky-400/10 p-2">
                <p className="truncate text-xs font-medium text-sky-200">{pdfRef.current.name}</p>
                <div className="mt-1.5 flex items-center gap-1.5">
                  <button onClick={() => setPdfPage(pdfRef.current!.pageIndex - 1)} className={miniBtn}>‹ Prev</button>
                  <span className="flex-1 text-center text-xs text-neutral-300">{pdfRef.current.pageIndex + 1}/{pdfRef.current.pages.length}</span>
                  <button onClick={() => setPdfPage(pdfRef.current!.pageIndex + 1)} className={miniBtn}>Next ›</button>
                </div>
                {pdfRef.current.pages.length > 1 && (
                  <div className="mt-1.5 grid max-h-44 grid-cols-3 gap-1.5 overflow-y-auto pr-0.5">
                    {pdfRef.current.pages.map((pg, i) => (
                      <button key={i} onClick={() => setPdfPage(i)} title={`Slide ${i + 1}`}
                        className={`overflow-hidden rounded-lg border transition active:scale-95 ${i === pdfRef.current!.pageIndex ? 'border-amber-400 ring-1 ring-amber-400/50' : 'border-white/10 opacity-70 hover:opacity-100'}`}>
                        <img src={pg} alt={`Slide ${i + 1}`} loading="lazy" className="block h-16 w-full bg-white object-cover" />
                        <span className="block bg-black/40 py-0.5 text-center text-[10px] tabular-nums text-neutral-300">{i + 1}</span>
                      </button>
                    ))}
                  </div>
                )}
                <button onClick={() => { pdfRef.current = null; persist(strokesRef.current, camRef.current); setStatus('PDF template removed.'); rerender(); }} className={`${miniBtn} mt-1.5 w-full`}>Remove PDF</button>
              </div>
            )}
            <p className="mt-1.5 text-[11px] leading-relaxed text-neutral-500">Tip: convert .pptx locally first — <code>./convert-pptx.sh slides.pptx</code> — then load the PDF.</p>
            <Toggle label="Ruler" hint="Straightedge for pen (R)" checked={rulerOn} onChange={setRulerOn} />
            {rulerOn && (
              <>
                <label className="mt-1 block text-xs text-neutral-400">Angle · {rulerAngle}°
                  <input type="range" min={-90} max={90} step={1} value={rulerAngle} onChange={(e) => setRulerAngle(Number(e.target.value))} className="mt-1 w-full accent-sky-400" />
                </label>
                <label className="mt-1 block text-xs text-neutral-400">Position · {rulerOff}px
                  <input type="range" min={-300} max={300} step={5} value={rulerOff} onChange={(e) => setRulerOff(Number(e.target.value))} className="mt-1 w-full accent-sky-400" />
                </label>
              </>
            )}
            <ArmButton className={`${miniBtn} mt-2 w-full !border-red-400/50 !text-red-300`} armedClassName={`${miniBtn} mt-2 w-full !border-red-400 !bg-red-400/15 !text-red-200`} armedLabel="Click again to erase all ink" onFire={clearBoard}>
              <span className="mr-1 inline-block align-middle"><Icon d={ICONS.trash} size={13} /></span>Clear board ink
            </ArmButton>
          </DockSection>

          <DockSection title="Canvas & Export" icon={ICONS.fit}>
            <Toggle label="Auto-convert shapes" hint="Rough circles/rects/lines become perfect" checked={autoShape} onChange={setAutoShape} />
            <Toggle label="Palm rejection" hint="Ignore touch while pen is down" checked={palmReject} onChange={setPalmReject} />
            <div className="mt-2 grid grid-cols-2 gap-1.5">
              <button onClick={fitToContent} className={miniBtn}>Fit (F)</button>
              <button onClick={resetView} className={miniBtn}>Reset (0)</button>
              <button onClick={exportPNG} className={miniBtn}><span className="mr-1 inline-block align-middle"><Icon d={ICONS.download} size={13} /></span>PNG</button>
              <button onClick={exportPDF} className={miniBtn}><span className="mr-1 inline-block align-middle"><Icon d={ICONS.download} size={13} /></span>PDF</button>
              <button onClick={importImage} className={`${miniBtn} col-span-2`}><span className="mr-1 inline-block align-middle"><Icon d={ICONS.image} size={13} /></span>Import image</button>
            </div>
            {selectedRef.current.size > 0 && (
              <button onClick={deleteSelected} className={`${miniBtn} mt-1.5 w-full !border-red-400/50 !text-red-300`}>
                Delete {selectedRef.current.size} selected (Del)
              </button>
            )}
          </DockSection>

          <DockSection title={`Memory · ${memCount}`} icon={ICONS.sliders}>
            <p className="text-[11px] leading-relaxed text-neutral-500">Local geometric personalization — not neural training. Survives reload.</p>
            <Toggle label="Personalization" hint="" checked={mem.enabled} onChange={(v) => {
              profileRef.current = { ...mem, enabled: v };
              try { saveProfile(profileRef.current); } catch { /* ignore */ }
              rerender();
            }} />
            <ul className="mt-1.5 space-y-1 text-xs text-neutral-400">
              <li>Examples {mem.examples.length} · kept {mem.accepts} · rejected {mem.rejects}</li>
              <li>বাংলা {byScript.bangla ?? 0} · EN {byScript.english ?? 0} · mixed {byScript.mixed ?? 0}</li>
              <li>Smooth {mem.params.smoothingBias.toFixed(2)} · slant {mem.params.slant.toFixed(2)} · h {Math.round(mem.params.avgHeight)}px</li>
            </ul>
            <div className="mt-2 flex gap-1.5">
              <button className={miniBtn} onClick={() => {
                const blob = new Blob([exportProfile(profileRef.current)], { type: 'application/json' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob); a.download = 'handwriting-memory.json'; a.click();
              }}>Export</button>
              <button className={miniBtn} onClick={() => {
                const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json';
                inp.onchange = async () => {
                  const f = inp.files?.[0]; if (!f) return;
                  try {
                    const t = await f.text();
                    profileRef.current = importProfile(t);
                    saveProfile(profileRef.current);
                    setMemCount(profileRef.current.examples.length);
                    setStatus('Memory profile imported.');
                  } catch (e) { setStatus(`Import failed: ${(e as Error).message}`); }
                  rerender();
                };
                inp.click();
              }}>Import</button>
              <button className={`${miniBtn} hover:!border-red-400/50 hover:!text-red-300`} onClick={() => {
                profileRef.current = clearMemory(profileRef.current);
                try { saveProfile(profileRef.current); } catch { /* ignore */ }
                setMemCount(0); rerender();
              }}>Clear</button>
            </div>
            <div className="mt-2 max-h-40 space-y-1 overflow-y-auto">
              {mem.examples.slice(0, 20).map((ex) => (
                <div key={ex.id} className="flex items-center justify-between rounded-lg border border-white/5 bg-white/[0.03] px-2 py-1 text-[11px] text-neutral-400">
                  <span>{ex.script} · {ex.accepted ? 'kept' : 'rejected'} · {ex.strength}</span>
                  <button className="text-red-400/80 hover:text-red-300" onClick={() => {
                    profileRef.current = deleteExample(profileRef.current, ex.id);
                    try { saveProfile(profileRef.current); } catch { /* ignore */ }
                    setMemCount(profileRef.current.examples.length); rerender();
                  }}>delete</button>
                </div>
              ))}
              {mem.examples.length === 0 && <p className="text-[11px] text-neutral-600">No examples yet — beautify some writing first.</p>}
            </div>
          </DockSection>

          <p className="pb-1 text-center text-[10px] text-neutral-600">100% local · no cloud · works offline</p>
        </aside>
      )}

      {/* ── AI privacy notice (first enable) ──────────────── */}
      {aiNotice && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-neutral-900 p-5 shadow-2xl">
            <h2 className="text-sm font-semibold text-neutral-100">Handwriting recognition uses AI</h2>
            <p className="mt-2 text-xs leading-relaxed text-neutral-300">
              When enabled, images of the strokes you write in Handwriting mode are sent
              to <code className="text-amber-300">/api/recognize</code> on your own backend, which
              forwards them to a vision AI service for transcription. Your API key stays
              on the backend and is never in this app. Turn the setting off any time to
              stop sending strokes.
            </p>
            <div className="mt-4 flex gap-2">
              <button
                onClick={() => { try { window.localStorage.setItem(NOTICE_KEY, '1'); } catch { /* ignore */ } setAiNotice(false); }}
                className="flex-1 rounded-lg bg-amber-400 px-3 py-2 text-xs font-semibold text-neutral-950 transition hover:brightness-110 active:scale-95">
                I understand, keep on
              </button>
              <button
                onClick={() => { setAiEnabled(false); setAiNotice(false); }}
                className="flex-1 rounded-lg border border-white/15 px-3 py-2 text-xs text-neutral-300 transition hover:bg-white/5 active:scale-95">
                Turn off
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Floating selection toolbar ────────────────────── */}
      {selBox && !editing && (
        <div className="absolute z-20 flex items-center gap-1 rounded-2xl border border-white/10 bg-neutral-900/90 p-1.5 shadow-xl backdrop-blur-md"
          style={{ left: selBox.left, top: selBox.top }}>
          <span className="px-1.5 text-[11px] font-semibold text-sky-300">{selectedRef.current.size} selected</span>
          <button onClick={duplicateSelected} title="Duplicate selection" className={miniBtn}>Duplicate</button>
          <button onClick={copySelected} title="Copy (Ctrl+C)" className={miniBtn}>Copy</button>
          <button onClick={beautifyOrRecognize} title="Beautify selection" className={`${miniBtn} !border-amber-400/50 !text-amber-200`}>Beautify</button>
          <button onClick={deleteSelected} title="Delete (Del)" className={`${miniBtn} !border-red-400/50 !text-red-300`}>Delete</button>
        </div>
      )}

      {/* ── Low-confidence transcription chips ────────────── */}
      {chips.map((c) => (
        <div
          key={c.key}
          className="absolute z-20 w-60 rounded-2xl border border-amber-400/40 bg-neutral-900/95 p-2.5 shadow-xl backdrop-blur-md"
          style={{
            left: Math.max(8, Math.min(c.sx - 120, (wrapRef.current?.clientWidth ?? 400) - 260)),
            top: Math.max(64, c.sy - 12),
          }}
        >
          <p className="mb-1.5 text-[11px] font-medium text-neutral-400">Not sure — tap to use:</p>
          <div className="flex flex-wrap gap-1.5">
            {[c.text, ...c.alternatives].filter(Boolean).slice(0, 4).map((alt, i) => (
              <button
                key={i}
                onClick={() => applyChip(c, alt)}
                className={`rounded-lg border px-2 py-1 text-xs transition active:scale-95 ${i === 0 ? 'border-amber-400 bg-amber-400/15 text-amber-200' : 'border-white/10 text-neutral-300 hover:bg-white/5'}`}
              >
                {alt.length > 40 ? alt.slice(0, 40) + '…' : alt}
              </button>
            ))}
            <button onClick={() => setChips((prev) => prev.filter((x) => x.key !== c.key))} title="Keep ink, dismiss"
              className="rounded-lg border border-white/10 px-2 py-1 text-xs text-neutral-500 hover:bg-white/5">Keep ink</button>
          </div>
        </div>
      ))}

      {/* ── Bottom-center: status + zoom pill ─────────────────── */}
      <div className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/10 bg-neutral-900/85 py-1.5 pl-4 pr-1.5 shadow-xl backdrop-blur-md">
        <span className={`h-2 w-2 shrink-0 rounded-full ${busy ? 'animate-pulse bg-amber-400' : 'bg-emerald-400'}`} />
        <span className="max-w-[42vw] truncate text-xs text-neutral-300">{status}</span>
        <span className="h-4 w-px bg-white/10" />
        <button onClick={() => zoomBy(1 / 1.25)} title="Zoom out" className={pillBtn}><Icon d={ICONS.minus} size={14} /></button>
        <span className="min-w-[44px] text-center text-xs font-semibold tabular-nums text-neutral-200">{Math.round(camRef.current.zoom * 100)}%</span>
        <button onClick={() => zoomBy(1.25)} title="Zoom in" className={pillBtn}><Icon d={ICONS.plus} size={14} /></button>
        <button onClick={fitToContent} title="Fit to content (F)" className={pillBtn}><Icon d={ICONS.fit} size={14} /></button>
      </div>
    </div>
  );
}

const railBtn = 'rounded-xl p-2.5 text-neutral-400 transition hover:bg-white/10 hover:text-white active:scale-90';
const chipBtn = 'rounded-lg p-1.5 text-neutral-400 transition hover:bg-white/10 hover:text-white active:scale-90';
const pillBtn = 'rounded-full p-1.5 text-neutral-400 transition hover:bg-white/10 hover:text-white active:scale-90';
const miniBtn = 'rounded-lg border border-white/10 px-2 py-1.5 text-xs text-neutral-300 transition hover:bg-white/5 active:scale-95';

function ArmButton({ className, armedClassName, armedLabel, onFire, children }: {
  className: string; armedClassName: string; armedLabel: string; onFire: () => void; children: React.ReactNode;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      className={armed ? armedClassName : className}
      onClick={() => { if (armed) { setArmed(false); onFire(); } else setArmed(true); }}
    >
      {armed ? armedLabel : children}
    </button>
  );
}

function DockSection({ title, icon, defaultOpen, children }: { title: string; icon: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <section className="rounded-xl border border-white/5 bg-white/[0.02]">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-2.5 text-left">
        <span className="text-neutral-400"><Icon d={icon} size={15} /></span>
        <span className="flex-1 text-[13px] font-semibold text-neutral-200">{title}</span>
        <span className={`text-neutral-500 transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </section>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!checked)} className="mt-2 flex w-full items-center justify-between gap-2 rounded-lg px-1 py-1 text-left">
      <span>
        <span className="block text-xs font-medium text-neutral-200">{label}</span>
        {hint && <span className="block text-[11px] text-neutral-500">{hint}</span>}
      </span>
      <span className={`relative h-5.5 w-10 shrink-0 rounded-full p-0.5 transition ${checked ? 'bg-amber-400' : 'bg-white/15'}`} style={{ height: 22 }}>
        <span className={`block h-[18px] w-[18px] rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-[18px]' : ''}`} />
      </span>
    </button>
  );
}
