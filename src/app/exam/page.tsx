import type { Metadata } from "next";
import ExamLandingTabs from "@/components/ExamLandingTabs";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Public Exam",
  description:
    "MediSpark public exams — model tests and mock exams for HSC academic and medical admission students.",
};

/**
 * Dedicated Public Exam landing page — opens from the Navbar / Hamburger
 * Menu and the bottom navigation Exams item. Two segments at the top:
 * "Free Exams" (default, dynamic active-category cards) and
 * "Courses Exams" (enrolled-course exam flow).
 * Public exam lists live inside each category page (/exam/category/<key>).
 */
export default async function ExamPage({
  searchParams,
}: {
  searchParams?: Promise<{ tab?: string }>;
}) {
  // Free Exams cards are temporarily hidden (display-only). No Public Exam
  // records are modified — the category-cards API, category pages, and
  // Admin Panel keep reading the same database. To restore, re-fetch
  // fetchPublicExamCategoryCards() and pass it as initialCategories.
  const tab = (await searchParams)?.tab === "enrolled" ? "enrolled" : "free";
  return (
    <main className="flex-1 bg-dark-950">
      <ExamLandingTabs
        initialTab={tab}
      />
    </main>
  );
}
