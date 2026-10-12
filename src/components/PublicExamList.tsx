"use client";

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import ExamCard from "@/components/ExamCard";
import {
  categorizeExam,
  examCategories,
  type ExamCategory,
  type PublicExam,
} from "@/lib/public-exams";
import { getCachedCompletedExamIds, cacheCompletedExamIds } from "@/lib/offline-exam-cache";

const examSections: { key: PublicExam["status"]; label: string }[] = [
  { key: "Live", label: "Live Exams" },
  { key: "Available", label: "Available Exams" },
  { key: "Upcoming", label: "Upcoming Exams" },
  { key: "Practice", label: "Practice Exams" },
  { key: "Completed", label: "Previous Exams" },
  { key: "Expired", label: "Expired Exams" },
];

type CategoryGroups = Record<PublicExam["status"], PublicExam[]>;

function emptyGroups(): CategoryGroups {
  return {
    Live: [],
    Available: [],
    Upcoming: [],
    Completed: [],
    Expired: [],
    Practice: [],
    Archived: [],
    Inactive: [],
    Unpublished: [],
  };
}

export default function PublicExamList({
  exams,
  batches,
  categoryId,
  /** Admin Panel extras — the layout stays identical to the website. */
  detailsBase,
  showDrafts = false,
  renderManage,
}: {
  exams: PublicExam[];
  batches: string[];
  /** Real category id — exams arrive pre-filtered; skip the legacy heuristic. */
  categoryId?: string | null;
  /** Base href for the exam-details page (admin mirror pages). */
  detailsBase?: string;
  /** Include draft exams (Admin Panel only). */
  showDrafts?: boolean;
  /** Per-card management controls (Admin Panel only). */
  renderManage?: (exam: PublicExam) => React.ReactNode;
}) {
  const [batch, setBatch] = useState("All Batches");
  const [mode, setMode] = useState<"all" | "live" | "practice">("all");
  const { user } = useAuth();
  const [completedSet, setCompletedSet] = useState<Set<string>>(new Set());

  // Strict one-attempt: fetch completed public exam IDs for current student, with offline cache
  useEffect(() => {
    if (!user || detailsBase) {
      // Admin mirror pages or no user: clear completed set (no View Result shown)
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
        const data = (await res.json().catch(() => null)) as { completed?: string[] } | null;
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
  }, [user, detailsBase]);

  const filtered = exams.filter(
    (exam) =>
      (showDrafts || exam.published) &&
      (batch === "All Batches" || exam.batch === batch) &&
      (mode === "all" || (exam.examMode ?? "live") === mode) &&
      // Strict separation: this is a public/free-exam list component — a
      // course (enrolled) exam must never render here even if a caller passes
      // unfiltered rows. Ownership is the module relationship (kind/scope),
      // never the title or display grouping below.
      (exam as unknown as { kind?: string }).kind !== "enrolled",
  );

  const grouped = useMemo(() => {
    const map = new Map<ExamCategory, CategoryGroups>();
    for (const category of examCategories) {
      map.set(category.key, emptyGroups());
    }
    for (const exam of filtered) {
      // Pre-filtered by real category id → keep every exam in view.
      const key = categoryId
        ? undefined
        : categorizeExam(exam);
      if (!key) continue;
      map.get(key)?.[exam.status].push(exam);
    }
    return map;
  }, [filtered, categoryId]);

  // Public category page: Live Exam (Upcoming + Live + post-live Practice)
  // and Practice Exam sections. Admin-closed exams map to Expired
  // ("Exam is Closed").
  const visibleSections = detailsBase
    ? examSections
    : examSections.filter((s) => s.key === "Live" || s.key === "Upcoming" || s.key === "Practice");

  const selectClass =
    "rounded-lg border border-ink/10 bg-dark-850 px-3.5 py-2.5 text-sm font-semibold text-heading transition-colors duration-75 ease-out focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/30 touch-manipulation";

  const modeButtonClass = (active: boolean) =>
    `shrink-0 select-none touch-manipulation rounded-full px-4 py-2 text-xs font-extrabold uppercase tracking-wide transform-gpu will-change-transform transition-colors duration-75 ease-out active:scale-[0.97] ${
      active
        ? "bg-ink text-dark-950 shadow"
        : "bg-dark-800 text-neutral-300 ring-1 ring-ink/10 hover:bg-dark-700 hover:text-heading"
    }`;

  return (
    <section className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2 overflow-x-auto pb-1 sm:pb-0">
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
          <button
            type="button"
            aria-pressed={mode === "live"}
            onClick={() => setMode((prev) => (prev === "live" ? "all" : "live"))}
            className={modeButtonClass(mode === "live")}
          >
            Live Exam
          </button>
          <button
            type="button"
            aria-pressed={mode === "practice"}
            onClick={() => setMode((prev) => (prev === "practice" ? "all" : "practice"))}
            className={modeButtonClass(mode === "practice")}
          >
            Practice Exam
          </button>
        </div>

        <p className="text-sm font-medium text-neutral-400">
          {filtered.length} exam{filtered.length === 1 ? "" : "s"} found
        </p>
      </div>

      {filtered.length === 0 && (
        <div className="mb-6 rounded-2xl border border-dashed border-ink/15 bg-dark-900/60 p-10 text-center">
          <p className="font-semibold text-heading">No exams found</p>
          <p className="mt-1 text-sm text-neutral-400">
            Try changing the batch or exam mode filter.
          </p>
        </div>
      )}

      <div className="space-y-14">
        {categoryId ? (
          /* Single pre-filtered category — status sections only. Public: only Live, admin: all */
          <div className="space-y-8">
            {visibleSections.map((section) => (
              <div key={section.key}>
                {filtered.some((exam) => exam.status === section.key) ? (
                  <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                    {filtered
                      .filter((exam) => exam.status === section.key)
                      .map((exam) => (
                        <ExamCard
                          key={exam.id}
                          exam={exam}
                          detailsHref={
                            detailsBase
                              ? `${detailsBase}/${exam.id}`
                              : undefined
                          }
                          manage={renderManage?.(exam)}
                          hasCompleted={completedSet.has(exam.id)}
                        />
                      ))}
                  </div>
                ) : (
                  <p className="text-sm text-neutral-500">
                    No {section.label.toLowerCase()} right now.
                  </p>
                )}
              </div>
            ))}
          </div>
        ) : (
        <>
        {examCategories.map((category) => {
          const groups = grouped.get(category.key) ?? emptyGroups();
          const categoryTotal =
            groups.Live.length + groups.Upcoming.length + groups.Practice.length;

          return (
            <div key={category.key}>
              <div className="mb-6 flex items-center justify-between gap-4">
                <h2 className="text-xl font-bold text-heading sm:text-2xl">
                  {category.label}
                </h2>
                <span className="text-sm font-medium text-neutral-400">
                  {categoryTotal} exam{categoryTotal === 1 ? "" : "s"}
                </span>
              </div>

              <div className="space-y-8">
                {visibleSections.map((section) => (
                  <div key={section.key}>
                    <h3 className="mb-4 flex items-center gap-2 text-base font-semibold text-heading">
                      {section.label}
                      <span className="rounded-full bg-dark-850 px-2 py-0.5 text-xs font-semibold text-neutral-400">
                        {groups[section.key].length}
                      </span>
                    </h3>

                    {groups[section.key].length > 0 ? (
                      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                        {groups[section.key].map((exam) => (
                          <ExamCard
                            key={exam.id}
                            exam={exam}
                            detailsHref={
                              detailsBase
                                ? `${detailsBase}/${exam.id}`
                                : undefined
                            }
                            manage={renderManage?.(exam)}
                            hasCompleted={completedSet.has(exam.id)}
                          />
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-neutral-500">
                        No {section.label.toLowerCase()} right now.
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
        </>
        )}
      </div>
    </section>
  );
}
