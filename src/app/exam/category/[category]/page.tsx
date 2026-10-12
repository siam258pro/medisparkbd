import type { Metadata } from "next";
import { notFound } from "next/navigation";
import PublicExamCategoryView from "@/components/PublicExamCategoryView";
import {
  fetchPublicExams,
  resolveExamCategoryRow,
} from "@/lib/public-exams-server";

export const dynamic = "force-dynamic";

type CategoryPageProps = {
  params: Promise<{ category: string }>;
};

export async function generateMetadata({
  params,
}: CategoryPageProps): Promise<Metadata> {
  const { category } = await params;
  const row = await resolveExamCategoryRow(category);
  if (!row) return { title: "Exam Category Not Found" };
  return { title: row.label, description: `${row.label} — live, upcoming and previous exams in one place.` };
}

export default async function ExamCategoryPage({ params }: CategoryPageProps) {
  const { category } = await params;
  // Legacy keys (ssc-academic …) and raw active-category slugs (including
  // custom categories) both resolve to the real Course Control category id.
  // Disabled/missing categories 404. Exams are fetched ONLY for that
  // category (SQL WHERE category_id = ?).
  const row = await resolveExamCategoryRow(category);
  if (!row) {
    notFound();
  }
  const exams = await fetchPublicExams({ categoryId: row.id });

  return (
    <main className="flex-1 bg-dark-950">
      {/* Category → Live Exam | Practice Exam (default: Live). */}
      <PublicExamCategoryView
        key={row.id}
        exams={exams}
        batches={["HSC 26", "HSC 27", "HSC 28"]}
        categoryKey={category}
        categorySlug={row.slug}
        serverNowMs={Date.now()}
      />
    </main>
  );
}
