import type { Metadata } from "next";
import ExamLandingTabs from "@/components/ExamLandingTabs";
import { fetchPublicExamCounts } from "@/lib/public-exams-server";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Public Exam",
  description:
    "MediSpark public exams — model tests and mock exams for HSC academic and medical admission students.",
};

/**
 * Dedicated Public Exam landing page — opens from the Navbar / Hamburger
 * Menu and the bottom navigation Exams item. Two segments at the top:
 * "Free Public Exams" (default, public category cards) and
 * "Enrolled Courses Exams" (enrolled-course exam flow).
 * Public exam lists live inside each category page (/exam/category/<key>).
 */
export default async function ExamPage({
  searchParams,
}: {
  searchParams?: Promise<{ tab?: string }>;
}) {
  // A database outage must not render a misleading zero inventory or make
  // the landing page unavailable; the client retries the fresh count API.
  const initial = await fetchPublicExamCounts().catch((error: unknown) => {
    console.error("[exam] could not load category counts:", error);
    return null;
  });
  const tab = (await searchParams)?.tab === "enrolled" ? "enrolled" : "free";
  return (
    <main className="flex-1 bg-dark-950">
      <ExamLandingTabs
        initialCounts={initial?.counts}
        initialPracticeCounts={initial?.practiceCounts}
        initialTab={tab}
      />
    </main>
  );
}