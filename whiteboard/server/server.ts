// Handwriting recognition backend (Phase 3): POST /api/recognize.
// Receives a PNG of stroke ink, forwards it to a vision LLM, returns
// strict JSON {text, lang, confidence, alternatives}.
// The LLM API key lives ONLY here (process.env), never in client code.
// Run: npm run server  (needs whiteboard/.env, see ../.env.example)
import crypto from 'node:crypto';
import express from 'express';
import multer from 'multer';
import cors from 'cors';
import { sanitizeResult } from '../src/recognizer.ts';

const PORT = Number(process.env.PORT ?? 3001);
const LLM_API_URL = process.env.LLM_API_URL ?? 'https://api.openai.com/v1/chat/completions';
const LLM_API_KEY = process.env.LLM_API_KEY ?? '';
const LLM_MODEL = process.env.LLM_MODEL ?? 'gpt-4o-mini';
const RATE_PER_MIN = Number(process.env.RATE_PER_MIN ?? 20);
const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 25000);
const CACHE_SIZE = 200;

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

const cache = new Map<string, unknown>();
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < 60000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > RATE_PER_MIN;
}

const STRICT_PROMPT = [
  'Transcribe exactly the handwritten text in the image.',
  'Do NOT correct spelling, grammar, or letterforms. Transcribe what is written, nothing more.',
  'Languages: Bengali/Bangla and English only (digits and common punctuation allowed).',
  'If a line mixes both scripts, transcribe it as written and set lang to "mixed".',
  'Bengali output must be valid Unicode (preserve vowel signs, conjuncts).',
  'Return ONLY this JSON object, no other text:',
  '{"text": string, "lang": "en" | "bn" | "mixed", "confidence": 0..1, "alternatives": string[0..3]}',
].join('\n');

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, configured: LLM_API_KEY.length > 0, model: LLM_MODEL });
});

app.post('/api/recognize', upload.single('image'), async (req, res) => {
  try {
    if (!LLM_API_KEY) {
      res.status(501).json({ error: 'AI backend not configured. Set LLM_API_KEY (see .env.example).' });
      return;
    }
    const ip = (req.ip ?? req.socket.remoteAddress ?? 'unknown').toString();
    if (rateLimited(ip)) {
      res.status(429).json({ error: 'Rate limit exceeded. Try again in a minute.' });
      return;
    }
    const file = (req as unknown as { file?: { buffer: Buffer; mimetype: string; size: number } }).file;
    if (!file || !file.buffer?.length) {
      res.status(400).json({ error: 'Missing image file (field "image", PNG, max 5MB).' });
      return;
    }
    const hash = crypto.createHash('sha256').update(file.buffer).digest('hex');
    const cached = cache.get(hash);
    if (cached) {
      res.json({ ...(cached as Record<string, unknown>), cached: true });
      return;
    }
    const dataUrl = `data:${file.mimetype || 'image/png'};base64,${file.buffer.toString('base64')}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let payload: unknown;
    try {
      const llm = await fetch(LLM_API_URL, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_API_KEY}` },
        body: JSON.stringify({
          model: LLM_MODEL,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'user', content: [
              { type: 'text', text: STRICT_PROMPT },
              { type: 'image_url', image_url: { url: dataUrl } },
            ] },
          ],
        }),
      });
      if (!llm.ok) {
        res.status(502).json({ error: `Vision model HTTP ${llm.status}.` });
        return;
      }
      const body = (await llm.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = body.choices?.[0]?.message?.content ?? '{}';
      payload = JSON.parse(content);
    } catch (e) {
      const aborted = e instanceof Error && e.name === 'AbortError';
      res.status(504).json({ error: aborted ? 'Vision model timed out.' : `Vision model error: ${(e as Error).message}` });
      return;
    } finally {
      clearTimeout(timer);
    }
    const clean = sanitizeResult(payload);
    cache.set(hash, clean);
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
    res.json(clean);
  } catch (e) {
    res.status(500).json({ error: `Recognizer failed: ${(e as Error).message}` });
  }
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`recognizer backend on :${PORT} (model=${LLM_MODEL}, key=${LLM_API_KEY ? 'set' : 'MISSING'})`);
});
