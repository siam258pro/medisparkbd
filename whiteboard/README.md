# Smart Handwriting Whiteboard (standalone, local, AI-API-free)

Miro-inspired infinite-canvas teaching whiteboard with automatic handwriting
beautification + personal handwriting memory. Fully **separate** app — no
MediSpark code, branding, or dependency. 100% local: no AI APIs, no cloud
calls, works offline after install.

## What it is / is not

- **Working now (deterministic code):** infinite canvas (mouse + touch + **pinch-zoom**),
  pen/highlighter/eraser/shapes/arrows/text/sticky, **ruler straightedge**, undo/redo,
  boards, autosave, PNG+PDF export, image import, **PDF-slide templates**,
  **custom image backgrounds**, **night/white board themes**, adaptive
  **speed-aware** geometric smoothing, conservative layout correction, stroke
  grouping that protects math/diagrams/shapes, personal geometric memory
  (localStorage).
- **Microsoft-Whiteboard-style selection:** freehand **lasso** select (tap =
  single select), drag any object to **move** it, floating toolbar on selection
  (Duplicate / Copy / Beautify / Delete), **Ctrl+C / Ctrl+V** paste at view
  center, shape tools store crisp **parametric geometry** (line/arrow/rect/
  ellipse with filled arrowheads), and **ink-to-shape auto-convert** turns
  deliberately drawn rough circles, rectangles, and straight lines into perfect
  shapes (toggleable, conservative — handwriting is never converted).
- **Explicitly NOT claimed:** semantic recognition of Bangla characters.
  Smoothing is geometric; proximity grouping is not character understanding.

## Install & launch

Prereqs: Node 22+, npm. Internet needed only once for `npm install`.

```bash
cd whiteboard
npm install
npm run dev        # open http://localhost:5173/
```

Production:

```bash
npm run build      # outputs dist/
npm run preview    # serve the production build locally
```

## Test

```bash
npm test           # 15 engine tests (node:test, no framework)
npx tsc --noEmit   # typecheck
```

## Files

| File | Purpose |
|---|---|
| `src/main.tsx`, `index.html`, `src/index.css` | App entry + styles |
| `src/Whiteboard.tsx` | Canvas UI: tool rail, control dock, status pill, boards, export, memory panel |
| `src/types.ts` | Stroke/Board/Memory types |
| `src/geometry.ts` | Dedupe, moving-average, corner detection, Catmull-Rom, RDP, adaptive smoothing |
| `src/beautify.ts` | Beautify pipeline, capped layout correction, revert, deviation metric |
| `src/grouping.ts` | Spatio-temporal grouping + shape/math/diagram protection |
| `src/memory.ts` | Personal memory: learned width/size/slant/spacing + example store |
| `src/storage.ts` | localStorage persistence (boards + profile), no network |
| `tests/whiteboard.test.ts` | 15 automated tests incl. Bangla diacritics, fractions, offline audit |

## Usage

1. Write with mouse/pen/stylus. Provisional ink renders immediately.
   Text/sticky: click the board and type in the inline box — Enter commits,
   Esc cancels. No popup dialogs anywhere in the app.
2. Select tool: drag a box to select, or drag directly on any object
   (ink, text, image) to move it. Del removes, Beautify processes selection.
2. Pause (~700ms, adjustable): Auto Beautify processes handwriting groups in the
   background; shapes, arrows, fractions, diagrams are left untouched.
3. `Compare original` toggles raw vs beautified; `Revert` restores raw ink
   (recorded as a rejected example in Memory).
4. Memory section: inspect/delete/clear/export/import your profile, toggle
   personalization, view per-script counts.
5. Shortcuts: `P`en `H`ighlighter `E`raser `V`select `T`ext, `Space`-drag pan,
   wheel zoom, `F` fit, `0` reset, `Ctrl+Z/Y` undo/redo, `Del` delete selection.

## Handwriting recognition (backend required for AI features)

Geometric beautification works fully offline. AI transcription needs the
bundled backend (API key stays server-side, never in the browser bundle):

```bash
cp .env.example .env     # then set LLM_API_KEY inside
npm run server           # :3001  (health: GET /api/health)
npm run dev              # :5173, proxies /api -> :3001
```

Groq (OpenAI-compatible) example for `.env`:
```bash
LLM_API_URL=https://api.groq.com/openai/v1/chat/completions
LLM_API_KEY=gsk_your_key_here
LLM_MODEL=meta-llama/llama-4-maverick-17b-128e-instruct
```
Restart `npm run server` after editing `.env` — the log must say `key=set`.
The app's AI toggle also checks `/api/health` and reports `configured:false`
if the key is missing.

Flow: Handwriting-mode pen strokes → 700ms debounce → `groupIntoLines` →
PNG rasterize → `POST /api/recognize` (sha256 cache, 20 req/min/IP, 25s
upstream timeout, strict no-correction prompt) → NFC + Unicode-range verify →
clean-strokes or convert-to-text (Atma/Caveat, double-click to edit).
Low confidence (<0.6) never auto-replaces — chips offer alternatives.
Enable "Use AI" in the dock (privacy notice on first enable).

Accuracy report (mocked backend, `tests/pipeline.test.ts` + `tests/fixtures.ts`):
| Fixture | Grouping | Lang/font decision | Auto-replace |
|---|---|---|---|
| "hello" (5 strokes) | 1 line / 1 word ✓ | en → Caveat ✓ | allowed at 0.95 ✓ |
| "বিজ্ঞান"-shaped (5 strokes, dot kept) | 1 line / 1 word ✓ | bn → Atma, NFC intact ✓ | allowed at 0.92 ✓ |
| mixed EN+BN line | 1 line / 2 words ✓ | mixed, script runs en/bn ✓ | allowed at 0.88 ✓ |
| low-conf 0.3 + alternatives | — | — | blocked, chips shown ✓ |
| local budget (group+clean, mixed line) | <10ms measured | budget 300ms ✓ | — |

Live-LLM transcription accuracy is not asserted here (needs your key +
real handwriting) — run the acceptance lines ("hello", "বাংলা") manually
with `LLM_API_KEY` set and confirm both modes before classroom use.

Language selector (`Auto/বাংলা/English/Mixed`) tunes geometric grouping
tolerance (Bangla allows wider vertical spread so vowel signs stay grouped).

## Templates: PDF slides, PPTX, images, patterns

- **Built-in patterns:** none / dots / grid / lines (Template & Theme section).
- **Custom image background:** any image as the board backdrop.
- **PDF slides:** load any PDF — every page renders locally (pdf.js, offline),
  flip pages with Prev/Next or the **slide thumbnail strip in the sidebar**,
  and write on top. Export includes the slide.
- **PPTX:** browsers cannot render PowerPoint faithfully offline, so convert
  locally first (LibreOffice is free and private):
  ```bash
  ./convert-pptx.sh slides.pptx        # -> slides.pdf next to the input
  ```
  then load the PDF as above. No file ever leaves your machine.

## Board themes & touch

- **Night / White** toggle (top-right button or Template & Theme). Ink color
  auto-switches between near-white and black so writing stays readable.
- **Pinch to zoom** with two fingers (touch/stylus); midpoint stays anchored.
- **Ruler (R):** screen-locked straightedge — pen snaps to its edge; adjust
  angle/position with sliders. Microsoft-Whiteboard-style lines without shaky hands.

## Data & privacy

- Boards: `msb.boards.v1`, memory: `msb.memory.v1` in browser localStorage.
- Zero fetch/XHR/WebSocket in app code (audited by the `offline` test).

## Known limitations (honest)

1. Beautification is geometric only — it cannot fix misspelled/misformed letters.
   v2 improves quality with **speed-aware smoothing** (fast loops smoothed more,
   slow detail preserved), arc-length even resampling, corner-safe segmentation,
   and exact endpoints — covered by automated tests.
2. Grouping is spatio-temporal, not semantic: overlapping annotations may merge;
   use Select + manual Beautify/Revert to override.
3. Layout correction caps shifts at 2–9px by design; slanted pages stay slanted.
4. No pressure rendering on devices without pointer pressure (falls back to 0.5).
5. Two-finger touch pan/zoom not yet implemented; mouse + Space works.

## Roadmap (optional local ML — not started)

A small open-source model with verified Bangla support via ONNX Runtime would be
needed for true semantic reconstruction. The memory profile format
(`original`/`beautified` stroke pairs + script labels) is designed to serve as
future fine-tuning data. Geometric mode remains the default regardless.
