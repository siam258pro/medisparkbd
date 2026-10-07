"use client";

import { useCallback, useEffect, useState } from "react";
import {
  buttonDangerClass,
  buttonPrimaryClass,
  buttonSecondaryClass,
  cardClass,
  inputClass,
  labelClass,
} from "./admin-ui";

type Lang = "bn" | "en";
type SetLabel = "A" | "B";

type Q = {
  id: number;
  questionUid: string | null;
  order: number;
  topic: string | null;
  question: string | null;
  options: (string | null)[];
  correctOption?: string | null;
  difficulty: string | null;
  subject?: string;
  marks?: number;
  explanation?: string | null;
  translationStatus?: string;
  autoTranslated?: boolean;
};

const TOPICS = ["Cell Structure", "Cell Division", "Cell Chemistry", "Microorganisms"];
const DIFFS = ["Easy", "Moderate", "Hard"];

const STATUS_DOT: Record<string, string> = {
  pending: "bg-amber-400",
  translating: "bg-sky-400 animate-pulse",
  completed: "bg-emerald-500",
  needs_update: "bg-orange-500",
  failed: "bg-red-500",
  manually_edited: "bg-violet-500",
};

export default function ExamSetAutoSync({
  exam,
  authHeaders,
  onClose,
}: {
  exam: { id: string; title: string };
  authHeaders: Record<string, string>;
  onClose: () => void;
}) {
  const [lang, setLang] = useState<Lang>("bn");
  const [set, setSet] = useState<SetLabel>("A");
  const [questions, setQuestions] = useState<Q[]>([]);
  const [validation, setValidation] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Q | null>(null);
  const [transEdit, setTransEdit] = useState<{ q: Q; text: string; opts: string[] } | null>(null);
  const [form, setForm] = useState({
    topic: TOPICS[0], question: "", options: ["", "", "", ""],
    correctOption: "A", difficulty: "Moderate", explanation: "", subject: "", marks: "1",
  });

  const load = useCallback(async () => {
    try {
      const r = await fetch(
        `/api/admin/exam-sets?examId=${encodeURIComponent(exam.id)}&set=${set}&lang=${lang}`,
        { cache: "no-store", headers: authHeaders },
      );
      const d = (await r.json()) as { questions?: Q[] };
      setQuestions(d.questions ?? []);
    } catch { setQuestions([]); }
  }, [exam.id, set, lang, authHeaders]);

  const loadValidation = useCallback(async () => {
    try {
      const r = await fetch(`/api/admin/exam-sets`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ examId: exam.id }),
      });
      setValidation((await r.json()) as Record<string, unknown>);
    } catch { setValidation(null); }
  }, [exam.id, authHeaders]);

  useEffect(() => { void Promise.resolve().then(load); }, [load]);
  useEffect(() => { void Promise.resolve().then(loadValidation); }, [loadValidation]);

  async function mutate(action: string, payload: Record<string, unknown>) {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/admin/exam-sets/questions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ action, examId: exam.id, set, ...payload }),
      });
      const d = (await r.json().catch(() => null)) as { error?: string } | null;
      if (!r.ok) { setError(d?.error ?? "Failed."); return false; }
      await load(); await loadValidation();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed.");
      return false;
    } finally { setBusy(false); }
  }

  async function saveMaster() {
    if (lang !== "bn") { setError("English version is automatically synchronized with Bangla."); return; }
    if (form.question.trim().length < 3) { setError("Question text required (≥3 chars)."); return; }
    if (form.options.some((o) => !o.trim())) { setError("Four non-empty options required."); return; }
    if (editing) {
      const saved = await mutate("update", {
        id: editing.id, topic: form.topic, question: form.question, options: form.options,
        correctOption: form.correctOption, difficulty: form.difficulty,
        explanation: form.explanation, subject: form.subject, marks: Number(form.marks) || 1,
      });
      if (!saved) return;
    } else {
      const saved = await mutate("create", {
        topic: form.topic, question: form.question, options: form.options,
        correctOption: form.correctOption, difficulty: form.difficulty,
        explanation: form.explanation, subject: form.subject, marks: Number(form.marks) || 1,
      });
      if (!saved) return;
    }
    setEditing(null);
    setForm({ topic: TOPICS[0], question: "", options: ["", "", "", ""], correctOption: "A", difficulty: "Moderate", explanation: "", subject: "", marks: "1" });
  }

  async function regenerate(qid: number) {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/admin/exam-sets/translations`, {
        method: "POST", headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ questionId: qid }),
      });
      const d = await r.json().catch(() => null) as { error?: string } | null;
      if (!r.ok) { setError(d?.error ?? "Regeneration failed."); return false; }
      await load(); await loadValidation();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Regeneration failed.");
      return false;
    } finally { setBusy(false); }
  }

  async function saveManualTranslation() {
    if (!transEdit) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/admin/exam-sets/translations`, {
        method: "PATCH", headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({
          questionId: transEdit.q.id, question_text: transEdit.text,
          option_a: transEdit.opts[0], option_b: transEdit.opts[1],
          option_c: transEdit.opts[2], option_d: transEdit.opts[3],
        }),
      });
      const d = await r.json().catch(() => null) as { error?: string } | null;
      if (!r.ok) { setError(d?.error ?? "Translation save failed."); return; }
      setTransEdit(null); await load(); await loadValidation();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Translation save failed.");
    } finally { setBusy(false); }
  }

  const v = validation as {
    validation?: { A?: { topicCounts?: Record<string, number>; difficulty?: Record<string, number>; blockers?: string[]; masterCount?: number };
      B?: { topicCounts?: Record<string, number>; difficulty?: Record<string, number>; blockers?: string[]; masterCount?: number } };
    disjoint?: { disjoint?: boolean; duplicates?: string[] };
    difficultyWarning?: string | null;
    englishPublishable?: boolean; message?: string;
  } | null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6" role="dialog" aria-modal="true">
      <div className={`${cardClass} max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-b-none p-5 sm:rounded-2xl sm:p-6`}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-extrabold">EXAM SET · {exam.title}</h3>
            <p className="mt-1 text-xs font-semibold text-slate-500">
              Bangla is the master. English is auto-translated — same IDs, order, topics, answers.
            </p>
          </div>
          <button type="button" onClick={onClose} className={buttonSecondaryClass}>Close</button>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <div className="flex overflow-hidden rounded-xl border border-neutral-200">
            {(["bn", "en"] as Lang[]).map((l) => (
              <button key={l} type="button" onClick={() => setLang(l)}
                className={`px-4 py-2 text-xs font-extrabold uppercase ${lang === l ? "bg-primary-600 text-white" : "text-slate-500"}`}>
                {l === "bn" ? "Bangla ▼" : "English"}
              </button>
            ))}
          </div>
          <div className="flex overflow-hidden rounded-xl border border-neutral-200">
            {(["A", "B"] as SetLabel[]).map((s) => (
              <button key={s} type="button" onClick={() => setSet(s)}
                className={`px-4 py-2 text-xs font-extrabold ${set === s ? "bg-zinc-900 text-white" : "text-slate-500"}`}>
                Set {s}
              </button>
            ))}
          </div>
          <span className="text-xs font-bold text-slate-400">{questions.length}/100 questions</span>
        </div>

        {lang === "en" && (
          <p className="mt-3 rounded-xl bg-sky-500/10 p-3 text-xs font-bold text-sky-700">
            Automatically translated from Bangla Master. English version is automatically synchronized with Bangla.
          </p>
        )}

        {v && (
          <div className="mt-3 rounded-xl border border-neutral-200 p-3 text-xs">
            <p className={`font-extrabold ${v.englishPublishable ? "text-emerald-600" : "text-red-500"}`}>{v.message}</p>
            {(["A", "B"] as SetLabel[]).map((s) => {
              const sv = v.validation?.[s];
              if (!sv) return null;
              return (
                <p key={s} className="mt-1 font-semibold text-slate-500">
                  Set {s} ({sv.masterCount ?? 0}/100):{" "}
                  {TOPICS.map((t) => `${t.split(" ")[1] ?? t}: ${sv.topicCounts?.[t] ?? 0}/25`).join(" · ")}
                  {sv.difficulty && ` — Easy ${sv.difficulty.Easy ?? 0} / Mod ${sv.difficulty.Moderate ?? 0} / Hard ${sv.difficulty.Hard ?? 0}`}
                </p>
              );
            })}
            {v.disjoint && !v.disjoint.disjoint && (
              <p className="mt-1 font-bold text-red-500">
                Duplicate Question Detected — already assigned to another set: {(v.disjoint.duplicates ?? []).join(", ")}
              </p>
            )}
            {v.difficultyWarning && <p className="mt-1 font-bold text-amber-600">{v.difficultyWarning}</p>}
            {v.validation?.[set]?.blockers?.map((b) => (
              <p key={b} className="font-semibold text-red-500">• {b}</p>
            ))}
          </div>
        )}

        {lang === "bn" ? (
          <div className="mt-4 rounded-xl border border-neutral-200 p-4">
            <h4 className="text-xs font-extrabold uppercase tracking-wider text-slate-400">
              {editing ? `Edit master ${editing.questionUid ?? `#${editing.id}`}` : "+ Add Question (Bangla master)"}
            </h4>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className={labelClass}>Topic</label>
                <select className={inputClass} value={form.topic} onChange={(e) => setForm({ ...form, topic: e.target.value })}>
                  {TOPICS.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className={labelClass}>Answer</label>
                  <select className={inputClass} value={form.correctOption} onChange={(e) => setForm({ ...form, correctOption: e.target.value })}>
                    <option value="">Select answer</option>
                    {["A", "B", "C", "D"].map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelClass}>Difficulty</label>
                  <select className={inputClass} value={form.difficulty} onChange={(e) => setForm({ ...form, difficulty: e.target.value })}>
                    {DIFFS.map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelClass}>Marks</label>
                  <input className={inputClass} value={form.marks} onChange={(e) => setForm({ ...form, marks: e.target.value })} />
                </div>
              </div>
            </div>
            <div className="mt-3">
              <label className={labelClass}>Question (Bangla)</label>
              <textarea rows={2} className={inputClass} value={form.question} onChange={(e) => setForm({ ...form, question: e.target.value })} />
            </div>
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {form.options.map((o, i) => (
                <div key={i}>
                  <label className={labelClass}>Option {String.fromCharCode(65 + i)} (Bangla)</label>
                  <input className={inputClass} value={o} onChange={(e) => setForm({ ...form, options: form.options.map((x, j) => (j === i ? e.target.value : x)) })} />
                </div>
              ))}
            </div>
            {error && <p className="mt-2 text-xs font-bold text-red-500">{error}</p>}
            <div className="mt-3 flex gap-2">
              <button type="button" disabled={busy} onClick={() => void saveMaster()} className={buttonPrimaryClass}>
                {busy ? "Saving…" : editing ? "Update Master" : "+ Add Question"}
              </button>
              {editing && (
                <button type="button" className={buttonSecondaryClass} onClick={() => { setEditing(null); setForm({ topic: TOPICS[0], question: "", options: ["", "", "", ""], correctOption: "A", difficulty: "Moderate", explanation: "", subject: "", marks: "1" }); }}>
                  Cancel
                </button>
              )}
            </div>
          </div>
        ) : null}

        <ul className="mt-4 space-y-3">
          {questions.map((q) => (
            <li key={q.id} className={`${cardClass} p-4`}>
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-semibold">
                  <span className="mr-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary-600/10 text-xs font-extrabold text-primary-600">{q.order}</span>
                  {q.question ?? <span className="text-slate-400">Translating…</span>}
                </p>
                {lang === "en" && (
                  <span className="shrink-0 rounded-full bg-violet-500/10 px-2 py-0.5 text-[10px] font-extrabold uppercase text-violet-600">
                    Auto translated
                  </span>
                )}
              </div>
              <p className="mt-1 text-[11px] font-bold uppercase tracking-wide text-slate-400">
                {q.questionUid ?? `#${q.id}`} · Set {set} · {q.topic ?? "—"} · Answer {q.correctOption ?? "—"} · {q.difficulty ?? "—"}
                {q.translationStatus && (
                  <span className="ml-2 inline-flex items-center gap-1 normal-case">
                    <span className={`inline-block h-2 w-2 rounded-full ${STATUS_DOT[q.translationStatus] ?? "bg-zinc-400"}`} />
                    {q.translationStatus.replace("_", " ")}
                  </span>
                )}
              </p>
              <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                {q.options.map((o, i) => (
                  <li key={i} className={q.correctOption === String.fromCharCode(65 + i) ? "font-bold text-emerald-600" : ""}>
                    {String.fromCharCode(65 + i)}. {o ?? "…"}
                    {q.correctOption === String.fromCharCode(65 + i) ? " ✓" : ""}
                  </li>
                ))}
              </ul>
              <div className="mt-2 flex flex-wrap gap-2">
                {lang === "bn" ? (
                  <>
                    <button type="button" className={buttonSecondaryClass} onClick={() => {
                      setEditing(q);
                      setForm({
                        topic: q.topic ?? TOPICS[0], question: q.question ?? "",
                        options: [0, 1, 2, 3].map((i) => q.options[i] ?? ""),
                        correctOption: q.correctOption ?? "", difficulty: q.difficulty ?? "Moderate",
                        explanation: q.explanation ?? "", subject: q.subject ?? "", marks: String(q.marks ?? 1),
                      });
                    }}>Edit</button>
                    <button type="button" className={buttonSecondaryClass} disabled={busy}
                      onClick={() => void mutate("delete", { id: q.id })}>Delete</button>
                    <button type="button" className={buttonSecondaryClass} disabled={busy}
                      onClick={() => {
                        const ids = questions.map((x) => x.id);
                        const idx = ids.indexOf(q.id);
                        if (idx > 0) { [ids[idx - 1], ids[idx]] = [ids[idx], ids[idx - 1]]; void mutate("reorder", { order: ids }); }
                      }}>↑</button>
                    <button type="button" className={buttonSecondaryClass} disabled={busy}
                      onClick={() => {
                        const ids = questions.map((x) => x.id);
                        const idx = ids.indexOf(q.id);
                        if (idx < ids.length - 1) { [ids[idx + 1], ids[idx]] = [ids[idx], ids[idx + 1]]; void mutate("reorder", { order: ids }); }
                      }}>↓</button>
                    <button type="button" className={buttonSecondaryClass} disabled={busy}
                      onClick={() => void mutate("move-set", { id: q.id, set: set === "A" ? "B" : "A" })}>
                      Move to Set {set === "A" ? "B" : "A"}
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" className={buttonSecondaryClass} disabled={busy}
                      onClick={() => setTransEdit({ q, text: q.question ?? "", opts: q.options.map((o) => o ?? "") })}>
                      Edit Translation
                    </button>
                    <button type="button" className={buttonSecondaryClass} disabled={busy}
                      onClick={() => void regenerate(q.id)}>Regenerate</button>
                    <button type="button" className={buttonDangerClass} disabled>Order / answer locked to master</button>
                  </>
                )}
              </div>
            </li>
          ))}
          {questions.length === 0 && (
            <li className="rounded-xl border border-dashed border-neutral-300 p-6 text-center text-xs font-semibold text-slate-500">
              {lang === "bn" ? "No master questions yet — add the first Bangla question above." : "No English translations yet — they generate automatically from the Bangla master."}
            </li>
          )}
        </ul>

        {transEdit && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
            <div className={`${cardClass} w-full max-w-lg p-5`}>
              <h4 className="text-sm font-extrabold">Edit Translation · {transEdit.q.questionUid}</h4>
              <p className="mt-1 text-[11px] font-bold text-amber-600">
                Manual wording only — Bangla master is never changed. Status becomes MANUALLY EDITED.
              </p>
              <label className={labelClass}>Question (English)</label>
              <textarea rows={2} className={inputClass} value={transEdit.text}
                onChange={(e) => setTransEdit({ ...transEdit, text: e.target.value })} />
              {transEdit.opts.map((o, i) => (
                <div key={i} className="mt-2">
                  <label className={labelClass}>Option {String.fromCharCode(65 + i)}</label>
                  <input className={inputClass} value={o}
                    onChange={(e) => setTransEdit({ ...transEdit, opts: transEdit.opts.map((x, j) => (j === i ? e.target.value : x)) })} />
                </div>
              ))}
              <div className="mt-3 flex gap-2">
                <button type="button" className={buttonPrimaryClass} disabled={busy} onClick={() => void saveManualTranslation()}>Save wording</button>
                <button type="button" className={buttonSecondaryClass} onClick={() => setTransEdit(null)}>Cancel</button>
                <button type="button" className={buttonSecondaryClass} disabled={busy} onClick={() => { void regenerate(transEdit.q.id).then((ok) => { if (ok) setTransEdit(null); }); }}>
                  Regenerate from master
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
