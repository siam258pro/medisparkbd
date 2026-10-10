import type { Metadata } from "next";
import { Suspense } from "react";
import Image from "next/image";
import { notFound } from "next/navigation";
import {
  getBatch,
  getPayableFee,
  hasDiscount,
  formatFee,
} from "@/lib/courses";
import { getLiveCourse } from "@/lib/course-catalog";
import { fetchCourseMentorIds } from "@/lib/courses-admin";
import { fetchMentors, type Mentor } from "@/lib/mentors";
import CourseEnrollFlow from "@/components/auth/CourseEnrollFlow";
import CourseRoutineViewer from "@/components/CourseRoutineViewer";

// Cached at the edge; admin changes appear within 60s.
export const revalidate = 300;

type CourseDetailsParams = { params: Promise<{ slug: string }> };

export async function generateMetadata({
  params,
}: CourseDetailsParams): Promise<Metadata> {
  const { slug } = await params;
  const course = await getLiveCourse(slug);
  return {
    title: course ? course.name : "Course",
    description: course?.shortDescription,
  };
}

/** batchId "ssc-29" → "SSC Batch 2029" */
function batchLabelText(batchId: string): string {
  const match = /^(ssc|hsc)-(\d{2})$/i.exec(batchId.trim());
  if (match) return `${match[1].toUpperCase()} Batch ${2000 + Number(match[2])}`;
  return getBatch(batchId)?.label ?? "";
}

export default async function CourseDetailsPage({
  params,
}: CourseDetailsParams) {
  const { slug } = await params;
  const course = await getLiveCourse(slug);

  if (!course) {
    notFound();
  }

  const payableFee = getPayableFee(course);
  const discounted = hasDiscount(course);
  const details = course.courseDetails;
  const batchLabel = batchLabelText(course.batchId);

  // Mentors assigned specifically to THIS course (course_mentors bridge),
  // resolved against the existing Mentor records — assignment order kept.
  const mentorIds = await fetchCourseMentorIds(slug);
  const allMentors = await fetchMentors();
  const mentorOrder = new Map(mentorIds.map((id, index) => [id, index]));
  const assignedMentors: Mentor[] = allMentors
    .filter((mentor) => mentorOrder.has(mentor.id))
    .sort((a, b) => (mentorOrder.get(a.id) ?? 0) - (mentorOrder.get(b.id) ?? 0));
  // Legacy fallback: per-course teachers stored in course_details JSON.
  const legacyTeachers =
    assignedMentors.length === 0 ? (details?.teachers ?? []) : [];

  return (
    <main className="flex-1 bg-dark-950">
      <section className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        {/* ── Course Card (student-facing card view) ── */}
        <div className="mt-6 overflow-hidden rounded-2xl border border-ink/10 bg-dark-900 shadow-lg shadow-black/20">
          {/* Banner with category (top-left) + batch (top-right) overlays */}
          <div className="relative aspect-[16/10] overflow-hidden">
            {course.image ? (
              <Image
                src={course.image}
                alt={course.name}
                fill
                priority
                sizes="(min-width: 1024px) 55vw, 100vw"
                className="object-cover"
              />
            ) : null}
            <div className="absolute inset-0 bg-gradient-to-t from-dark-950/70 via-dark-950/10 to-dark-950/30" />
            {course.category && (
              <span className="absolute left-4 top-4 max-w-[55%] truncate rounded-lg border border-primary-500/40 bg-dark-950/80 px-3 py-1.5 text-xs font-bold text-primary-400 backdrop-blur">
                {course.category}
              </span>
            )}
            {batchLabel && (
              <span className="absolute right-4 top-4 rounded-lg border border-ink/15 bg-dark-950/80 px-3 py-1.5 text-xs font-bold text-neutral-300 backdrop-blur">
                {batchLabel}
              </span>
            )}
          </div>

          <div className="p-6 sm:p-8">
            {/* Course Name */}
            <h1 className="text-2xl font-extrabold text-heading">
              {course.name}
            </h1>

            {/* Total Classes | Total Exams */}
            {(course.totalClasses !== undefined || course.totalExams !== undefined) && (
              <div className="mt-4 grid grid-cols-2 gap-3 sm:w-1/2">
                <div className="rounded-xl border border-ink/10 bg-ink/5 px-4 py-3 text-center">
                  <p className="text-lg font-extrabold text-heading">
                    {course.totalClasses ?? "—"}
                  </p>
                  <p className="text-xs font-bold uppercase tracking-wide text-neutral-500">
                    Total Class
                  </p>
                </div>
                <div className="rounded-xl border border-ink/10 bg-ink/5 px-4 py-3 text-center">
                  <p className="text-lg font-extrabold text-heading">
                    {course.totalExams ?? "—"}
                  </p>
                  <p className="text-xs font-bold uppercase tracking-wide text-neutral-500">
                    Total Exam
                  </p>
                </div>
              </div>
            )}

            {/* Duration — details card only (never on listing/home cards) */}
            {(details?.duration || course.duration) && (
              <p className="mt-4 text-sm font-semibold text-neutral-400">
                Duration:{" "}
                <span className="font-bold text-heading">
                  {details?.duration || course.duration}
                </span>
              </p>
            )}

            {/* Fee */}
            <div className="mt-4 flex items-center gap-3">
              <p className="text-3xl font-extrabold text-primary-500">
                {formatFee(payableFee)}
              </p>
              {discounted && (
                <>
                  <span className="text-sm font-semibold text-neutral-500 line-through">
                    {formatFee(course.fee)}
                  </span>
                  <span className="rounded-lg bg-emerald-500/10 px-2.5 py-1 text-xs font-bold text-emerald-400">
                    Save {formatFee(course.fee - payableFee)}
                  </span>
                </>
              )}
            </div>

            {/* Actions */}
            <div className="mt-6 flex flex-col gap-3 sm:flex-row">
              <Suspense
                fallback={
                  <div className="h-[52px] w-full animate-pulse rounded-xl bg-ink/10" />
                }
              >
                <CourseEnrollFlow course={course} />
              </Suspense>
            </div>
          </div>
        </div>

        {/* ── Course Routine ── */}
        <CourseRoutineViewer routineUrls={course.routineUrls} courseName={course.name} />

        {/* ── Course Features ── */}
        {course.features.length > 0 && (
          <div className="mt-12">
            <p className="text-xs font-bold uppercase tracking-widest text-primary-500">
              Course Features
            </p>
            <h2 className="mt-2 text-2xl font-extrabold text-heading">
              What&apos;s Included
            </h2>
            <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {course.features.map((feature) => (
                <div
                  key={feature}
                  className="flex items-start gap-3 rounded-2xl border border-ink/10 bg-dark-900 p-4 shadow-lg shadow-black/20"
                >
                  <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary-600/15 text-primary-500">
                    <svg
                      className="h-3.5 w-3.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      viewBox="0 0 24 24"
                    >
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  </span>
                  <p className="text-sm font-semibold text-heading">
                    {feature}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Course Description ── */}
        {(details?.description || course.description) && (
          <div className="mt-12">
            <p className="text-xs font-bold uppercase tracking-widest text-primary-500">
              Course Description
            </p>
            <h2 className="mt-2 text-2xl font-extrabold text-heading">
              About This Course
            </h2>
            <p className="mt-4 max-w-3xl text-sm leading-relaxed text-neutral-400">
              {details?.description || course.description}
            </p>
          </div>
        )}

        {/* ── Course Mentors (only mentors assigned to this course) ── */}
        {(assignedMentors.length > 0 || legacyTeachers.length > 0) && (
          <div className="mt-12">
            <p className="text-xs font-bold uppercase tracking-widest text-primary-500">
              Course Mentors
            </p>
            <h2 className="mt-2 text-2xl font-extrabold text-heading">
              Meet Your Mentors
            </h2>
            <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {assignedMentors.map((mentor) => (
                <div
                  key={mentor.id}
                  className="flex items-start gap-4 rounded-2xl border border-ink/10 bg-dark-900 p-5 shadow-lg shadow-black/20"
                >
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-ink/10 bg-dark-800">
                    {mentor.photoUrl ? (
                      <Image
                        src={mentor.photoUrl}
                        alt={mentor.name}
                        width={56}
                        height={56}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <span className="text-sm font-extrabold text-neutral-400">
                        {mentor.initials}
                      </span>
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-heading">
                      {mentor.name}
                    </p>
                    {(mentor.qualification || mentor.subject) && (
                      <p className="mt-0.5 text-xs font-semibold text-primary-400">
                        {mentor.qualification || mentor.subject}
                      </p>
                    )}
                    {(mentor.note || mentor.bio) && (
                      <p className="mt-1.5 line-clamp-3 text-xs leading-relaxed text-neutral-400">
                        {mentor.note || mentor.bio}
                      </p>
                    )}
                  </div>
                </div>
              ))}
              {legacyTeachers.map((teacher, idx) => (
                <div
                  key={`${teacher.name}-${idx}`}
                  className="flex items-start gap-4 rounded-2xl border border-ink/10 bg-dark-900 p-5 shadow-lg shadow-black/20"
                >
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-ink/10 bg-dark-800">
                    {teacher.photoUrl ? (
                      <Image
                        src={teacher.photoUrl}
                        alt={teacher.name}
                        width={56}
                        height={56}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <span className="text-sm font-extrabold text-neutral-400">
                        {teacher.name.charAt(0)}
                      </span>
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-heading">
                      {teacher.name}
                    </p>
                    {teacher.designation && (
                      <p className="mt-0.5 text-xs font-semibold text-primary-400">
                        {teacher.designation}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </main>
  );
}