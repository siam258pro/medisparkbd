"use client";

import { useState } from "react";
import ExamCategoryCards, { type CategoryCardItem } from "@/components/ExamCategoryCards";
import EnrolledExamCourseSelection from "@/components/EnrolledExamCourseSelection";

type LandingTab = "free" | "enrolled";

const tabButtonClass = (active: boolean) =>
  `rounded-xl px-4 py-2.5 text-xs font-extrabold uppercase tracking-wide touch-manipulation select-none transform-gpu transition-colors duration-75 ease-out active:scale-[0.97] sm:text-sm ${
    active
      ? "bg-ink text-dark-950 shadow"
      : "text-neutral-300 hover:bg-ink/5 hover:text-heading"
  }`;

/**
 * Main Website Exams navigation — two-segment structure:
 * "Free Exams" (default) keeps the existing public category cards;
 * "Courses Exams" hosts the existing enrolled-course exam flow.
 * Structural reorganization only — both systems are reused unchanged.
 */
export default function ExamLandingTabs({
  initialCategories,
  initialTab = "free",
}: {
  initialCategories?: CategoryCardItem[] | null;
  initialCounts?: Record<string, number> | null;
  initialPracticeCounts?: Record<string, number> | null;
  initialTab?: LandingTab;
}) {
  const [tab, setTab] = useState<LandingTab>(initialTab);

  return (
    <>
      <section className="mx-auto max-w-6xl px-4 pt-4 sm:px-6">
        {/* Two full-width segments — same premium segmented-control design as
            the Live Exam / Practice Exam filter. */}
        <div
          role="tablist"
          aria-label="Exam navigation"
          className="grid grid-cols-2 gap-1 rounded-2xl border border-ink/10 bg-dark-900 p-1.5 shadow-lg shadow-black/20"
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === "free"}
            onClick={() => setTab("free")}
            className={tabButtonClass(tab === "free")}
          >
            Free Exams
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "enrolled"}
            onClick={() => setTab("enrolled")}
            className={tabButtonClass(tab === "enrolled")}
          >
            Courses Exams
          </button>
        </div>
      </section>

      {tab === "free" ? (
        <div role="tabpanel" aria-label="Free Exams">
          <ExamCategoryCards initialCategories={initialCategories} />
        </div>
      ) : (
        <div role="tabpanel" aria-label="Courses Exams">
          <EnrolledExamCourseSelection embedded />
        </div>
      )}
    </>
  );
}
