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
import type { EnrolledCourseSummary } from "@/lib/my-learning";

type CourseResponse = { enrolled_courses?: EnrolledExamCourse[]; error?: string };

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
    if (!user || embedded) return;
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
  }, [user, fetchCourses, embedded]);

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

  // Courses Exams tab: the enrolled-course filter listing below. This branch
  // must run BEFORE the auth/enrollment gates below: the standalone `load()`
  // is a no-op when embedded, so `courses` would stay null forever and the
  // `!items` spinner below would park at 90% indefinitely. Standalone
  // /exam/enrolled keeps the original navigate-to-course flow unchanged.
  // The embedded component below enforces login itself: its filter options
  // are the logged-in student's own enrollments.
  if (embedded) {
    return (
      <EmbeddedCourseExams />
    );
  }

  if (authLoading) return <AccessLoading label="Loading enrolled courses…" />;
  if (!user) return <AccessMessage title="Login Required" message="Sign in to access exams in your enrolled courses." actionLabel="Login" actionHref="/login?next=%2Fexam%2Fenrolled" />;
  const items = courses?.uid === user.uid ? courses.items : null;
  if (!items && !error) return <AccessLoading label="Loading enrolled courses…" />;

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
 * Embedded Courses Exams: a dynamic enrolled-course filter at the top,
 * followed by the eligible currently-Live Course Content exams.
 *
 * Filter source of truth: the logged-in student's Dashboard → My Enrolled
 * Course section — the same `/api/my/enrolled-courses` endpoint (active
 * enrollments only; pending/confirmed-awaiting rows unlock no exams). Each
 * option shows the enrolled course's actual name, plus an
 * "All Enrolled Courses" option. Nothing is hardcoded and no unenrolled
 * course can appear: the list is rebuilt from the server on every load, so
 * it follows enrollment changes.
 *
 * Exam matching is by course ID, not by name: each course's exams come from
 * the enrollment-enforced `/api/my/course-exams?course=<id>&live=1`
 * endpoint (403 unless actively enrolled; server links exams via
 * exam_courses / the chapter chain). "All" merges every enrolled course's
 * live exams, deduplicated by exam id.
 *
 * Cards reuse the shared ExamCard, so Start Exam opens the original Course
 * Content exam through the unchanged exam-start flow (rules page → attempt
 * APIs), preserving enrollment requirements, schedule, timer, attempt
 * limits, questions and ranking. No exam, question, attempt or result
 * records are created or modified here. Free Exams and the course-specific
 * Course Content interfaces are untouched.
 */
function EmbeddedCourseExams() {
  const { user, authLoading } = useAuth();
  const currentUser = useRef(user);
  useEffect(() => { currentUser.current = user; }, [user]);
  // null = not loaded yet; [] = loaded, student has no active enrollment.
  const [filterCourses, setFilterCourses] = useState<{ id: string; name: string }[] | null>(null);
  const [examsByCourse, setExamsByCourse] = useState<Record<string, CourseExamShortcut[]>>({});
  const [selected, setSelected] = useState<string>("all");
  const [loadError, setLoadError] = useState<string | null>(null);
  // Client clock so an exam whose end time passes while the page is open is
  // concealed immediately, even before the next server refetch lands.
  const [now, setNow] = useState(() => Date.now());

  const loadLive = useCallback(async () => {
    const current = currentUser.current;
    if (!current) return;
    // Bound the request so a hung connection surfaces the error + retry UI
    // instead of spinning forever.
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20_000);
    try {
      const token = await current.getIdToken();
      const authHeaders = token ? { Authorization: `Bearer ${token}` } : undefined;
      const coursesResponse = await fetch("/api/my/enrolled-courses", {
        cache: "no-store",
        headers: authHeaders,
        signal: controller.signal,
      });
      const coursesData = (await coursesResponse.json()) as {
        courses?: EnrolledCourseSummary[];
        error?: string;
      };
      if (!coursesResponse.ok || !Array.isArray(coursesData.courses)) {
        throw new Error(coursesData.error ?? "Could not load your enrolled courses.");
      }
      // Only ACTIVE enrollments unlock exams — the same gate the content
      // and exam-start APIs enforce server-side.
      const active = coursesData.courses.filter(
        (course) => course.enrollmentStatus === "active",
      );
      if (currentUser.current?.uid !== current.uid) return;
      setFilterCourses(active.map((course) => ({ id: course.slug, name: course.name })));
      const settled = await Promise.allSettled(
        active.map(async (course) => {
          const response = await fetch(
            `/api/my/course-exams?course=${encodeURIComponent(course.slug)}&live=1`,
            { cache: "no-store", headers: authHeaders, signal: controller.signal },
          );
          const data = (await response.json()) as {
            exams?: CourseExamShortcut[];
            error?: string;
          };
          if (!response.ok || !Array.isArray(data.exams)) {
            throw new Error(data.error ?? "Could not load course exams.");
          }
          return { id: course.slug, exams: data.exams };
        }),
      );
      if (currentUser.current?.uid !== current.uid) return;
      const next: Record<string, CourseExamShortcut[]> = {};
      let failures = 0;
      for (const result of settled) {
        if (result.status === "fulfilled") next[result.value.id] = result.value.exams;
        else failures += 1;
      }
      setExamsByCourse(next);
      // An enrollment change that removes the selected course falls back to All.
      setSelected((prev) =>
        prev !== "all" && !active.some((course) => course.slug === prev) ? "all" : prev,
      );
      // Partial results still render; the alert below offers a retry.
      setLoadError(
        failures > 0
          ? "Could not load all course exams."
          : null,
      );
    } catch (cause) {
      if (currentUser.current?.uid !== current.uid) return;
      if (controller.signal.aborted) {
        setLoadError("Could not load course exams.");
      } else {
        setLoadError(cause instanceof Error ? cause.message : "Could not load course exams.");
      }
    } finally {
      window.clearTimeout(timeout);
    }
  }, []);

  useEffect(() => {
    if (authLoading || !user) return;
    const initialLoad = window.setTimeout(() => {
      // Fresh account (or enrollment refresh): reset, then reload. These run
      // in an async callback, after the previous student's rows are dropped.
      setFilterCourses(null);
      setExamsByCourse({});
      setSelected("all");
      setLoadError(null);
      setNow(Date.now());
      void loadLive();
    }, 0);
    const onVisible = () => { if (document.visibilityState === "visible") { setNow(Date.now()); void loadLive(); } };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    // Tick the client clock so locally-expired exams are concealed even if
    // a refetch is delayed; the visible-interval refetch below still pulls
    // fresh server-computed Live state at the same cadence.
    const clock = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(clock);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [authLoading, user, loadLive]);
  useVisibleInterval(loadLive, 60_000);

  if (authLoading) {
    return (
      <section className="mx-auto max-w-6xl px-4 py-4 sm:px-6" aria-label="Courses Exams">
        <div className="mt-6 flex flex-col items-center rounded-2xl border border-ink/10 bg-dark-900/60 p-10" role="status">
          <div className="h-10 w-10 animate-spin rounded-full border-2 border-primary-500 border-t-transparent" />
          <p className="mt-4 text-sm font-semibold text-neutral-400">
            Loading live courses exams…
          </p>
        </div>
      </section>
    );
  }
  if (!user) {
    return (
      <section className="mx-auto max-w-6xl px-4 py-4 sm:px-6" aria-label="Courses Exams">
        <div className="mt-6">
          <AccessMessage
            title="Login Required"
            message="Sign in to see live exams from your enrolled courses."
            actionLabel="Login"
            actionHref="/login?next=%2Fexam%3Ftab%3Denrolled"
          />
        </div>
      </section>
    );
  }

  // The fetch above already returns only currently Live exams; filter again
  // client-side so Upcoming / Practice / ended rows can never render here
  // even if an older cached payload arrives, and conceal any exam whose end
  // time has passed since the payload was computed (stale-data guard).
  const isLive = (exam: CourseExamShortcut) => {
    if (exam.status !== "Live" || exam.examMode === "practice") return false;
    if (exam.endsAt && Number.isFinite(new Date(exam.endsAt).getTime()) && new Date(exam.endsAt).getTime() < now) return false;
    if (exam.scheduledAt && Number.isFinite(new Date(exam.scheduledAt).getTime()) && new Date(exam.scheduledAt).getTime() > now) return false;
    return true;
  };
  const selectedExams = (() => {
    if (!filterCourses) return null;
    if (selected === "all") {
      // Merge every enrolled course's live exams, deduplicated by exam id
      // (one exam may be assigned to several enrolled courses).
      const seen = new Map<string, CourseExamShortcut>();
      for (const course of filterCourses) {
        for (const exam of examsByCourse[course.id] ?? []) {
          if (!seen.has(exam.id)) seen.set(exam.id, exam);
        }
      }
      return [...seen.values()].filter(isLive);
    }
    return (examsByCourse[selected] ?? []).filter(isLive);
  })();
  const selectedName =
    selected === "all"
      ? null
      : (filterCourses ?? []).find((course) => course.id === selected)?.name ?? null;

  return (
    <section className="mx-auto max-w-6xl px-4 py-4 sm:px-6" aria-label="Courses Exams">
      <div className="mt-6">
        {filterCourses === null && !loadError ? (
          <div className="flex flex-col items-center rounded-2xl border border-ink/10 bg-dark-900/60 p-10" role="status">
            <div className="h-10 w-10 animate-spin rounded-full border-2 border-primary-500 border-t-transparent" />
            <p className="mt-4 text-sm font-semibold text-neutral-400">
              Loading live courses exams…
            </p>
          </div>
        ) : filterCourses === null && loadError ? (
          <div role="alert" className="rounded-2xl border border-red-500/30 bg-red-500/10 p-8 text-center">
            <p className="font-bold text-red-300">{loadError}</p>
            <button type="button" onClick={() => void loadLive()} className="mt-4 rounded-xl bg-primary-600 px-6 py-3 font-semibold text-white">Try Again</button>
          </div>
        ) : (filterCourses ?? []).length === 0 ? (
          <div className="rounded-2xl border border-dashed border-ink/15 bg-dark-900/60 p-10 text-center">
            <p className="font-semibold text-heading">No enrolled courses yet</p>
            <p className="mt-1 text-sm text-neutral-400">
              Enroll in a course to see its live exams here.
            </p>
            <Link href="/courses?kind=paid" className="mt-6 inline-flex rounded-xl bg-primary-600 px-6 py-3 text-sm font-bold text-white hover:bg-primary-700">Explore Premium Courses</Link>
          </div>
        ) : (
          <div className="space-y-8">
            <div
              role="group"
              aria-label="Filter live exams by enrolled course"
              className="flex gap-2 overflow-x-auto pb-1"
            >
              <button
                key="all"
                type="button"
                aria-pressed={selected === "all"}
                onClick={() => setSelected("all")}
                className={`shrink-0 rounded-xl px-4 py-2.5 text-xs font-extrabold uppercase tracking-wide touch-manipulation select-none transition-colors duration-75 ease-out active:scale-[0.97] sm:text-sm ${
                  selected === "all"
                    ? "bg-ink text-dark-950 shadow"
                    : "text-neutral-300 hover:bg-ink/5 hover:text-heading"
                }`}
              >
                All Enrolled Courses
              </button>
              {(filterCourses ?? []).map((course) => (
                <button
                  key={course.id}
                  type="button"
                  aria-pressed={selected === course.id}
                  onClick={() => setSelected(course.id)}
                  className={`shrink-0 rounded-xl px-4 py-2.5 text-xs font-extrabold uppercase tracking-wide touch-manipulation select-none transition-colors duration-75 ease-out active:scale-[0.97] sm:text-sm ${
                    selected === course.id
                      ? "bg-ink text-dark-950 shadow"
                      : "text-neutral-300 hover:bg-ink/5 hover:text-heading"
                  }`}
                >
                  {course.name}
                </button>
              ))}
            </div>
            {loadError && (
              <div role="alert" className="rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-center">
                <p className="text-sm font-bold text-red-300">{loadError}</p>
                <button type="button" onClick={() => void loadLive()} className="mt-2 text-sm font-bold text-red-200 underline">Try Again</button>
              </div>
            )}
            {(selectedExams ?? []).length === 0 ? (
              <div className="rounded-2xl border border-dashed border-ink/15 bg-dark-900/60 p-10 text-center">
                <p className="font-semibold text-heading">No live exams right now</p>
                <p className="mt-1 text-sm text-neutral-400">
                  {selectedName
                    ? `There is no live exam in ${selectedName} right now. Please check back later.`
                    : "There is no live exam right now. Please check back later."}
                </p>
              </div>
            ) : (
              <section aria-label="Live Now">
                <h2 className="text-sm font-extrabold uppercase tracking-widest text-heading">Live Now</h2>
                <div className="mt-3 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                  {(selectedExams ?? []).map((exam) => (
                    <ExamCard key={exam.id} exam={exam} />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
