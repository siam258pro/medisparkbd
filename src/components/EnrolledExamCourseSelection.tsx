"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { useVisibleInterval } from "@/lib/use-visible-interval";
import { AccessLoading, AccessMessage } from "@/components/auth/AccessGuard";
import ExamCard from "@/components/ExamCard";
import type { EnrolledExamCourse } from "@/lib/enrolled-exams";
import type { CourseExamShortcut } from "@/lib/enrolled-exams-course-server";

type CourseResponse = { enrolled_courses?: EnrolledExamCourse[]; error?: string };

const filterPillClass = (active: boolean) =>
  `shrink-0 rounded-xl px-4 py-2.5 text-xs font-extrabold uppercase tracking-wide touch-manipulation select-none transform-gpu transition-colors duration-75 ease-out active:scale-[0.97] sm:text-sm ${
    active
      ? "bg-ink text-dark-950 shadow"
      : "text-neutral-300 hover:bg-ink/5 hover:text-heading"
  }`;

export default function EnrolledExamCourseSelection({ embedded = false }: { embedded?: boolean } = {}) {
  const { user, authLoading } = useAuth();
  const router = useRouter();
  const currentUser = useRef(user);
  useEffect(() => { currentUser.current = user; }, [user]);
  const [courses, setCourses] = useState<{ uid: string; items: EnrolledExamCourse[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  const fetchCourses = useCallback(async () => {
    if (!user) return null;
    const token = await user.getIdToken();
    const response = await fetch("/api/my/enrolled-exams", {
      cache: "no-store",
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json() as CourseResponse;
    if (!response.ok || !Array.isArray(data.enrolled_courses)) {
      throw new Error(data.error ?? "Could not load your enrolled courses.");
    }
    return data.enrolled_courses;
  }, [user]);

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const items = await fetchCourses();
      if (currentUser.current?.uid !== user.uid || !items) return;
      setCourses({ uid: user.uid, items });
      setError(null);
    } catch (cause) {
      if (currentUser.current?.uid === user.uid) {
        setError(cause instanceof Error ? cause.message : "Could not load your enrolled courses.");
      }
    }
  }, [user, fetchCourses]);

  useEffect(() => {
    if (authLoading || !user) return;
    const initialLoad = window.setTimeout(() => void load(), 0);
    const onVisible = () => { if (document.visibilityState === "visible") void load(); };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(initialLoad);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [authLoading, user, load]);
  useVisibleInterval(load, 60_000);

  async function openCourse(courseId: string) {
    if (!user || opening) return;
    setOpening(courseId);
    setError(null);
    try {
      // Recheck both entitlement and admin-configured module at click time.
      const items = await fetchCourses();
      if (currentUser.current?.uid !== user.uid || !items) return;
      setCourses({ uid: user.uid, items });
      const course = items.find((item) => item.course_id === courseId);
      if (!course) throw new Error("This course is no longer available in your active enrollments.");
      router.push(course.direct_exam_route_url);
    } catch (cause) {
      if (currentUser.current?.uid === user.uid) {
        setError(cause instanceof Error ? cause.message : "Could not open the course exams.");
      }
    } finally {
      setOpening(null);
    }
  }

  if (authLoading) return <AccessLoading label="Loading enrolled courses…" />;
  if (!user) return <AccessMessage title="Login Required" message="Sign in to access exams in your enrolled courses." actionLabel="Login" actionHref="/login?next=%2Fexam%2Fenrolled" />;
  const items = courses?.uid === user.uid ? courses.items : null;
  if (!items && !error) return <AccessLoading label="Loading enrolled courses…" />;

  // Courses Exams tab: enrollment-based course filters + the selected
  // course's genuinely Live exams only. Standalone /exam/enrolled keeps
  // the original navigate-to-course flow unchanged.
  if (embedded) {
    return (
      <EmbeddedCourseLiveExams
        items={items ?? []}
        error={error}
        onRetry={() => void load()}
      />
    );
  }

  return (
    <section className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
      <Link href="/exam" className="text-sm font-semibold text-primary-400 hover:text-primary-300">← Explore Free Exams</Link>
      <h1 className="mt-5 text-2xl font-extrabold text-heading sm:text-3xl">My Enrolled Exams</h1>
      <p className="mt-2 text-sm text-neutral-400">Choose a course to go directly to its exams.</p>
      {error && <div role="alert" className="mt-6 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
        <p>{error}</p>
        <button type="button" onClick={() => void load()} className="mt-2 font-bold underline">Try Again</button>
      </div>}
      {items?.length === 0 && !error ? (
        <div className="mt-8 rounded-2xl border border-dashed border-ink/15 bg-dark-900 p-10 text-center">
          <h2 className="text-lg font-bold text-heading">No enrolled courses found</h2>
          <p className="mt-2 text-sm text-neutral-400">Explore our premium courses to get started.</p>
          <Link href="/courses?kind=paid" className="mt-6 inline-flex rounded-xl bg-primary-600 px-6 py-3 text-sm font-bold text-white hover:bg-primary-700">Explore Premium Courses</Link>
        </div>
      ) : (
        <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {items?.map((course) => (
            <button key={course.course_id} type="button" disabled={opening !== null} onClick={() => void openCourse(course.course_id)} className="group overflow-hidden rounded-2xl border border-ink/10 bg-dark-900 text-left shadow-lg shadow-black/20 transition hover:-translate-y-1 hover:border-primary-600/60 disabled:cursor-wait disabled:opacity-70">
              {course.banner_image_url ? (
                // Course banners use the same arbitrary admin-upload URLs as the catalog.
                // eslint-disable-next-line @next/next/no-img-element
                <img src={course.banner_image_url} alt={course.course_name} loading="lazy" className="aspect-video w-full object-cover" />
              ) : (
                <div className="flex aspect-video items-center justify-center bg-primary-600/10 px-6 text-center font-bold text-primary-400">{course.course_name}</div>
              )}
              <div className="p-5">
                <h2 className="text-lg font-extrabold text-heading group-hover:text-primary-400">{course.course_name}</h2>
                <p className="mt-2 text-sm font-semibold text-primary-400">{opening === course.course_id ? "Opening exams…" : "Open Course Exams →"}</p>
              </div>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * Embedded Courses Exams: one filter pill per actually-enrolled course
 * (dynamic names, never non-enrolled courses), with the selected course's
 * currently-running Live exams below. Live status comes from the existing
 * course-exam schedule/status logic (server-derived `status === "Live"`);
 * Upcoming, Practice/Archived and expired exams never render here. Start
 * Exam reuses ExamCard, preserving rules, timers, attempts, results and
 * ranking.
 */
function EmbeddedCourseLiveExams({
  items,
  error,
  onRetry,
}: {
  items: EnrolledExamCourse[];
  error: string | null;
  onRetry: () => void;
}) {
  const { user } = useAuth();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [exams, setExams] = useState<CourseExamShortcut[] | null>(null);
  const [examsError, setExamsError] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);

  const activeId = selectedId && items.some((course) => course.course_id === selectedId)
    ? selectedId
    : (items[0]?.course_id ?? null);

  useEffect(() => {
    selectedRef.current = activeId;
  }, [activeId]);

  const loadLive = useCallback(async () => {
    const courseId = selectedRef.current;
    const current = user;
    if (!current || !courseId) {
      setExams(null);
      return;
    }
    try {
      const token = await current.getIdToken();
      const response = await fetch(`/api/my/course-exams?course=${encodeURIComponent(courseId)}`, {
        cache: "no-store",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await response.json()) as { exams?: CourseExamShortcut[]; error?: string };
      if (!response.ok || !Array.isArray(data.exams)) {
        throw new Error(data.error ?? "Could not load live exams.");
      }
      if (selectedRef.current !== courseId) return;
      setExams(data.exams);
      setExamsError(null);
    } catch (cause) {
      if (selectedRef.current === courseId) {
        setExamsError(cause instanceof Error ? cause.message : "Could not load live exams.");
      }
    }
  }, [user]);

  useEffect(() => {
    setExams(null);
    setExamsError(null);
    if (!activeId || !user) return;
    const initialLoad = window.setTimeout(() => void loadLive(), 0);
    const onVisible = () => { if (document.visibilityState === "visible") void loadLive(); };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(initialLoad);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [activeId, user, loadLive]);
  useVisibleInterval(loadLive, 60_000);

  // Only genuinely Live exams per the existing schedule/status logic.
  const liveExams = (exams ?? []).filter((exam) => exam.status === "Live");
  const selectedCourse = items.find((course) => course.course_id === activeId) ?? null;

  return (
    <section className="mx-auto max-w-6xl px-4 py-4 sm:px-6" aria-label="Courses Exams">
      {error && (
        <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
          <p>{error}</p>
          <button type="button" onClick={onRetry} className="mt-2 font-bold underline">Try Again</button>
        </div>
      )}
      {items.length === 0 && !error ? (
        <div className="rounded-2xl border border-dashed border-ink/15 bg-dark-900 p-10 text-center">
          <h2 className="text-lg font-bold text-heading">No enrolled courses found</h2>
          <p className="mt-2 text-sm text-neutral-400">Explore our premium courses to get started.</p>
          <Link href="/courses?kind=paid" className="mt-6 inline-flex rounded-xl bg-primary-600 px-6 py-3 text-sm font-bold text-white hover:bg-primary-700">Explore Premium Courses</Link>
        </div>
      ) : (
        <>
          <div
            role="tablist"
            aria-label="Your enrolled courses"
            className="flex gap-1 overflow-x-auto rounded-2xl border border-ink/10 bg-dark-900 p-1.5 shadow-lg shadow-black/20"
          >
            {items.map((course) => (
              <button
                key={course.course_id}
                type="button"
                role="tab"
                aria-selected={activeId === course.course_id}
                onClick={() => setSelectedId(course.course_id)}
                className={`${filterPillClass(activeId === course.course_id)} min-w-0 flex-1 whitespace-nowrap`}
                title={course.course_name}
              >
                <span className="block truncate">{course.course_name}</span>
              </button>
            ))}
          </div>

          <div className="mt-6">
            {exams === null && !examsError ? (
              <div className="flex flex-col items-center rounded-2xl border border-ink/10 bg-dark-900/60 p-10" role="status">
                <div className="h-10 w-10 animate-spin rounded-full border-2 border-primary-500 border-t-transparent" />
                <p className="mt-4 text-sm font-semibold text-neutral-400">
                  Loading live exams for {selectedCourse?.course_name ?? "your course"}…
                </p>
              </div>
            ) : examsError ? (
              <div role="alert" className="rounded-2xl border border-red-500/30 bg-red-500/10 p-8 text-center">
                <p className="font-bold text-red-300">{examsError}</p>
                <button type="button" onClick={() => void loadLive()} className="mt-4 rounded-xl bg-primary-600 px-6 py-3 font-semibold text-white">Try Again</button>
              </div>
            ) : liveExams.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-ink/15 bg-dark-900/60 p-10 text-center">
                <p className="font-semibold text-heading">No live exam right now</p>
                <p className="mt-1 text-sm text-neutral-400">
                  {selectedCourse ? `There is no currently running live exam in ${selectedCourse.course_name}.` : "There is no currently running live exam."} Please check back later.
                </p>
              </div>
            ) : (
              <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                {liveExams.map((exam) => (
                  <ExamCard key={exam.id} exam={exam} />
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
