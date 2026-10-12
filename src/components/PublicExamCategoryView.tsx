"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import ExamCard from "@/components/ExamCard";
import AutoUpdateBar from "@/components/AutoUpdateBar";
import {
  distinctSubjects,
  getPublicLivePhase,
  isPracticeMode,
  matchMedicalPracticeSubject,
  MEDICAL_PRACTICE_SUBJECTS,
  medicalPracticeSubjectTitle,
  OTHER_PRACTICE_SUBJECT_KEY,
  practiceUsesSubjectCards,
  type PublicLivePhase,
} from "@/lib/public-exam-structure";
import type { ExamCategory, PublicExam } from "@/lib/public-exams";
import { getCachedCompletedExamIds, cacheCompletedExamIds } from "@/lib/offline-exam-cache";

type ModeTab = "live" | "practice";

const LIVE_SECTIONS: {
  phase: Exclude<PublicLivePhase, "practice" | "hidden">;
  heading: string;
  dot: string;
  text: string;
}[] = [
  {
    phase: "upcoming",
    heading: "Upcoming Exam",
    dot: "bg-primary-400",
    text: "text-primary-300",
  },
  {
    phase: "live",
    heading: "Exam is Live Now",
    dot: "bg-emerald-500",
    text: "text-emerald-400",
  },
  {
    phase: "closed",
    heading: "Exam is Closed",
    dot: "bg-red-500",
    text: "text-red-400",
  },
];

function SubjectBookIcon({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
    >
      <path d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
    </svg>
  );
}

/**
 * One Public Exam category — SAME information architecture as the Admin
 * Panel: Category → [ Live Exam | Practice Exam ] (default: Live).
 * Student-facing cards and styling only; no admin controls here.
 */
export default function PublicExamCategoryView({
  exams,
  batches,
  categoryKey,
  categorySlug,
  serverNowMs = Date.now(),
}: {
  exams: PublicExam[];
  batches: string[];
  categoryKey: string;
  categorySlug?: string;
  serverNowMs?: number;
}) {
  const [tab, setTab] = useState<ModeTab>("live");
  const [batch, setBatch] = useState("All Batches");
  const [subject, setSubject] = useState<string | null>(null);
  // Server snapshot, replaced by DB-fresh data on manual/auto refresh.
  const [freshExams, setFreshExams] = useState<PublicExam[] | null>(null);
  const liveExams = freshExams ?? exams;
  const refreshExams = useCallback(async () => {
    const res = await fetch(
      `/api/public-exams/list?category=${encodeURIComponent(categoryKey)}`,
      { cache: "no-store" },
    );
    if (!res.ok) throw new Error("refresh failed");
    const data = (await res.json()) as { exams?: PublicExam[] };
    if (Array.isArray(data.exams)) {
      setFreshExams(data.exams);
      setNowMs(Date.now());
    }
  }, [categoryKey]);
  // Frozen at mount (+1m refresh) so the Upcoming → Live → Practice grouping
  // stays stable across re-renders. Remounted per category via `key`.
  const [nowMs, setNowMs] = useState(serverNowMs);
  const { user } = useAuth();
  const [completedSet, setCompletedSet] = useState<Set<string>>(new Set());

  useEffect(() => {
    // Immediately sync to true client time after hydration to avoid mismatch
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  // Strict one-attempt: fetch completed public exam IDs for current student.
  useEffect(() => {
    if (!user) {
      // No user: clear completed set (no View Result shown)
      setCompletedSet(new Set());
      return;
    }
    let cancelled = false;
    (async () => {
      // First, try to load from cache for instant UI
      const cached = getCachedCompletedExamIds(user.uid);
      if (!cancelled && Array.isArray(cached)) {
        setCompletedSet(new Set(cached));
      }
      // Then fetch from network to get fresh data
      try {
        const token = await user.getIdToken();
        const res = await fetch("/api/exams/completed-public", {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          cache: "no-store",
        });
        if (!res.ok) {
          // If network fails, we keep the cached data (if any) already set above.
          return;
        }
        const data = (await res.json().catch(() => null)) as {
          completed?: string[];
        } | null;
        if (!cancelled && Array.isArray(data?.completed)) {
          // Cache the fresh result for offline use
          cacheCompletedExamIds(user.uid, data.completed);
          setCompletedSet(new Set(data.completed));
        }
      } catch {
        // Network error: keep cached data (if any) already set above.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const batchFiltered = useMemo(
    () =>
      liveExams.filter(
        (exam) =>
          exam.published &&
          (batch === "All Batches" || exam.batch === batch),
      ),
    [liveExams, batch],
  );

  // Live Exam tab: ONLY static live-mode exams (examMode === "live";
  // legacy `kind = "practice"` rows count as practice) that are still in
  // their Upcoming → Live → Closed lifecycle. A live-mode exam whose End
  // Time has passed is in its automatic post-live Practice phase — its card
  // carries the "Practice Exam" badge, so it belongs to the Practice Exam
  // tab, NEVER to the Live Exam section.
  const liveGroups = useMemo(() => {
    const groups: Record<"upcoming" | "live" | "closed", PublicExam[]> = {
      upcoming: [],
      live: [],
      closed: [],
    };
    for (const exam of batchFiltered) {
      if (isPracticeMode(exam)) continue;
      const phase = getPublicLivePhase(exam, nowMs);
      // Post-live Practice (and hidden) live-mode exams are NOT Live Exams
      // anymore — they render in the Practice Exam tab (see practiceExams).
      if (phase === "practice" || phase === "hidden") continue;
      groups[phase].push(exam);
    }
    return groups;
  }, [batchFiltered, nowMs]);

  const liveTotal =
    liveGroups.upcoming.length +
    liveGroups.live.length +
    liveGroups.closed.length;

  // Practice Exam tab: ONLY exams in their Practice phase —
  // 1) static practice-mode exams (examMode === "practice", incl. legacy
  //    `kind = "practice"` rows normalized server-side), plus
  // 2) live-mode exams past their End Time (automatic post-live Practice
  //    phase; attempts are unranked). A static practice-mode exam NEVER
  //    appears in the Live Exam tab, and no Upcoming/Live/Closed live-mode
  //    exam EVER appears here.
  const practiceExams = useMemo(
    () =>
      batchFiltered.filter(
        (exam) =>
          isPracticeMode(exam) ||
          (!isPracticeMode(exam) &&
            getPublicLivePhase(exam, nowMs) === "practice"),
      ),
    [batchFiltered, nowMs],
  );

  const useSubjectCards = practiceUsesSubjectCards(categoryKey as ExamCategory, practiceExams);
  const slugToken = `${categorySlug ?? ""} ${categoryKey}`.toLowerCase();
  const isMedical = categoryKey === "medical-admission" || /medical/.test(slugToken);

  const practiceSubjects = useMemo(() => {
    if (!useSubjectCards) return [];
    if (isMedical) {
      const counts = new Map<string, number>();
      let other = 0;
      for (const exam of practiceExams) {
        const key = matchMedicalPracticeSubject(exam.subject);
        if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
        else other += 1;
      }
      const cards: { key: string; title: string; count: number }[] =
        MEDICAL_PRACTICE_SUBJECTS.map((item) => ({
        key: item.key,
        title: item.title,
        count: counts.get(item.key) ?? 0,
      }));
      if (other > 0) {
        cards.push({
          key: OTHER_PRACTICE_SUBJECT_KEY,
          title: medicalPracticeSubjectTitle(OTHER_PRACTICE_SUBJECT_KEY),
          count: other,
        });
      }
      return cards;
    }
    return distinctSubjects(practiceExams).map((title) => ({
      key: title,
      title,
      count: practiceExams.filter((exam) => exam.subject === title).length,
    }));
  }, [useSubjectCards, isMedical, practiceExams]);

  const visiblePractice = useMemo(() => {
    if (!useSubjectCards || !subject) return practiceExams;
    if (isMedical) {
      if (subject === OTHER_PRACTICE_SUBJECT_KEY) {
        return practiceExams.filter(
          (exam) => !matchMedicalPracticeSubject(exam.subject),
        );
      }
      return practiceExams.filter(
        (exam) => matchMedicalPracticeSubject(exam.subject) === subject,
      );
    }
    return practiceExams.filter((exam) => exam.subject === subject);
  }, [useSubjectCards, subject, isMedical, practiceExams]);

  function selectTab(next: ModeTab) {
    setTab(next);
    setSubject(null);
  }

  const selectClass =
    "rounded-lg border border-ink/10 bg-dark-850 px-3.5 py-2.5 text-sm font-semibold text-heading transition-colors duration-75 ease-out focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/30 touch-manipulation";

  const tabButtonClass = (active: boolean) =>
    `rounded-xl px-4 py-2.5 text-xs font-extrabold uppercase tracking-wide touch-manipulation select-none transform-gpu transition-colors duration-75 ease-out active:scale-[0.97] sm:text-sm ${
      active
        ? "bg-ink text-dark-950 shadow"
        : "text-neutral-300 hover:bg-ink/5 hover:text-heading"
    }`;

  return (
    <section className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12">

      {/* Live Exam | Practice Exam — one segmented filter row (default: Live) */}
      <div
        role="tablist"
        aria-label="Exam type"
        className="mt-6 grid grid-cols-2 gap-1 rounded-2xl border border-ink/10 bg-dark-900 p-1.5 shadow-lg shadow-black/20 sm:mx-auto sm:max-w-xl"
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === "live"}
          onClick={() => selectTab("live")}
          className={tabButtonClass(tab === "live")}
        >
          Live Exam
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "practice"}
          onClick={() => selectTab("practice")}
          className={tabButtonClass(tab === "practice")}
        >
          Practice Exam
        </button>
      </div>

      <div className="mb-6 mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {/* Batch filter + auto-update pill — side-by-side, wraps on mobile */}
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <select
            aria-label="Filter by batch"
            value={batch}
            onChange={(event) => setBatch(event.target.value)}
            className={selectClass}
          >
            <option value="All Batches">All Batches</option>
            {batches.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
          <AutoUpdateBar onRefresh={refreshExams} />
        </div>
        <p className="text-sm font-medium text-neutral-400">
          {tab === "live" ? (
            <>
              {liveTotal} live exam{liveTotal === 1 ? "" : "s"} found
            </>
          ) : (
            <>
              {practiceExams.length} practice exam
              {practiceExams.length === 1 ? "" : "s"} found
            </>
          )}
        </p>
      </div>

      {tab === "live" ? (
        <div className="space-y-10">
          {liveTotal === 0 && (
            <div className="rounded-2xl border border-dashed border-ink/15 bg-dark-900/60 p-10 text-center">
              <p className="font-semibold text-heading">No live exams right now</p>
              <p className="mt-1 text-sm text-neutral-400">
                Upcoming exams will appear here. Check the Practice Exam tab to keep preparing.
              </p>
            </div>
          )}
          {LIVE_SECTIONS.map((section) => {
            const list = liveGroups[section.phase];
            if (list.length === 0) return null;
            return (
              <div key={section.phase}>
                <h2
                  className={`mb-4 flex items-center gap-2 text-base font-bold sm:text-lg ${section.text}`}
                >
                  <span
                    className={`relative flex h-2.5 w-2.5 shrink-0 ${section.phase === "live" ? "animate-pulse" : ""}`}
                  >
                    <span
                      className={`relative inline-flex h-2.5 w-2.5 rounded-full ${section.dot}`}
                    />
                  </span>
                  {section.heading}
                  <span className="rounded-full bg-dark-850 px-2 py-0.5 text-xs font-semibold text-neutral-400">
                    {list.length}
                  </span>
                </h2>
                <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                  {list.map((exam) => (
                    <ExamCard
                      key={exam.id}
                      exam={exam}
                      hasCompleted={completedSet.has(exam.id)}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div>
          {/* Medical Admission Practice: always show the fixed 8 subject
              cards first (even with 0 exams) — no custom Back navigation;
              subject selection only filters the existing Practice list.
              Returning to cards: re-select the Practice Exam tab. */}
          {useSubjectCards && !subject && (isMedical || practiceExams.length > 0) ? (
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {practiceSubjects.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setSubject(item.key)}
                  className="group relative flex flex-col overflow-hidden rounded-2xl border border-ink/10 bg-dark-900 p-6 text-left shadow-lg shadow-black/20 transform-gpu transition duration-150 ease-out hover:-translate-y-1 hover:border-primary-600/60 hover:shadow-primary-900/30 active:scale-[0.99] touch-manipulation"
                >
                  <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-primary-600/10 blur-3xl transition duration-150 ease-out group-hover:bg-primary-600/20" />
                  <div className="pointer-events-none absolute inset-0 bg-medical-dots opacity-30" />
                  <div className="relative flex items-center gap-4">
                    <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-primary-600/15 text-primary-500 transition duration-150 ease-out group-hover:bg-primary-600 group-hover:text-heading">
                      <SubjectBookIcon />
                    </span>
                    <h3 className="text-lg font-extrabold leading-snug text-heading transition duration-150 ease-out group-hover:text-primary-400">
                      {item.title}
                    </h3>
                  </div>
                  <p className="relative mt-3 text-sm font-semibold text-neutral-400">
                    {item.count} practice exam{item.count === 1 ? "" : "s"}
                  </p>
                  <div className="relative mt-auto pt-6">
                    <span className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary-600 px-6 py-3 text-sm font-bold text-white shadow-lg shadow-primary-900/40 transition duration-150 ease-out group-hover:bg-primary-700">
                      Explore Exams
                      <span aria-hidden="true">→</span>
                    </span>
                  </div>
                </button>
              ))}
            </div>
          ) : practiceExams.length === 0 && !isMedical ? (
            <div className="rounded-2xl border border-dashed border-ink/15 bg-dark-900/60 p-10 text-center">
              <p className="font-semibold text-heading">No practice exams yet</p>
              <p className="mt-1 text-sm text-neutral-400">
                New practice exams will appear here automatically.
              </p>
            </div>
          ) : (
            <div>
              {visiblePractice.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-ink/15 bg-dark-900/60 p-10 text-center">
                  <p className="font-semibold text-heading">
                    No practice exams in this subject yet
                  </p>
                  <p className="mt-1 text-sm text-neutral-400">
                    Try another subject.
                  </p>
                </div>
              ) : (
                <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                  {visiblePractice.map((exam) => (
                    <ExamCard
                      key={exam.id}
                      exam={exam}
                      hasCompleted={completedSet.has(exam.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
