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

  // Courses Exams tab: no course filter pills — directly shows all currently
  // live course exams. This branch must run BEFORE the auth/enrollment gates
  // below: the embedded listing is intentionally public (its featured API is
  // unauthenticated; enrollment is still enforced at exam-start time), and the
  // standalone `load()` is a no-op when embedded, so `courses` would stay null
  // forever and the `!items` spinner below would park at 90% indefinitely.
  // Standalone /exam/enrolled keeps the original navigate-to-course flow
  // unchanged.
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
 * Embedded Courses Exams: no course filter pills — directly shows every
 * currently Live Course Content exam across all courses via the featured
 * endpoint, with no course selection step. Start Exam reuses the shared
 * ExamCard, so it opens the original exam through the unchanged exam-start
 * flow (rules page → attempt APIs), preserving enrollment requirements,
 * schedule, timer, attempt limits, questions and ranking. No exam, question,
 * attempt or result records are created or modified here.
 */
function EmbeddedCourseExams() {
  const [exams, setExams] = useState<CourseExamShortcut[] | null>(null);
  const [examsError, setExamsError] = useState<string | null>(null);
  // Client clock so an exam whose end time passes while the page is open is
  // concealed immediately, even before the next server refetch lands.
  const [now, setNow] = useState(() => Date.now());

  const loadLive = useCallback(async () => {
    // Bound the request so a hung connection surfaces the error + retry UI
    // instead of spinning forever.
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`/api/courses-exams/featured`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const data = (await response.json()) as { exams?: CourseExamShortcut[]; error?: string };
      if (!response.ok || !Array.isArray(data.exams)) {
        throw new Error(data.error ?? "Could not load course exams.");
      }
      setExams(data.exams);
      setExamsError(null);
    } catch (cause) {
      if (controller.signal.aborted) {
        setExamsError("Could not load course exams.");
      } else {
        setExamsError(cause instanceof Error ? cause.message : "Could not load course exams.");
      }
    } finally {
      window.clearTimeout(timeout);
    }
  }, []);

  useEffect(() => {
    setExams(null);
    setExamsError(null);
    setNow(Date.now());
    const initialLoad = window.setTimeout(() => void loadLive(), 0);
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
  }, [loadLive]);
  useVisibleInterval(loadLive, 60_000);

  // The fetch above already returns only currently Live exams; filter again
  // client-side so Upcoming / Practice / ended rows can never render here
  // even if an older cached payload arrives, and conceal any exam whose end
  // time has passed since the payload was computed (stale-data guard).
  const liveExams = (exams ?? []).filter((exam) => {
    if (exam.status !== "Live" || exam.examMode === "practice") return false;
    if (exam.endsAt && Number.isFinite(new Date(exam.endsAt).getTime()) && new Date(exam.endsAt).getTime() < now) return false;
    if (exam.scheduledAt && Number.isFinite(new Date(exam.scheduledAt).getTime()) && new Date(exam.scheduledAt).getTime() > now) return false;
    return true;
  });

  return (
    <section className="mx-auto max-w-6xl px-4 py-4 sm:px-6" aria-label="Courses Exams">
      <div className="mt-6">
        {exams === null && !examsError ? (
          <div className="flex flex-col items-center rounded-2xl border border-ink/10 bg-dark-900/60 p-10" role="status">
            <div className="h-10 w-10 animate-spin rounded-full border-2 border-primary-500 border-t-transparent" />
            <p className="mt-4 text-sm font-semibold text-neutral-400">
              Loading live courses exams…
            </p>
          </div>
        ) : examsError ? (
          <div role="alert" className="rounded-2xl border border-red-500/30 bg-red-500/10 p-8 text-center">
            <p className="font-bold text-red-300">{examsError}</p>
            <button type="button" onClick={() => void loadLive()} className="mt-4 rounded-xl bg-primary-600 px-6 py-3 font-semibold text-white">Try Again</button>
          </div>
        ) : liveExams.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-ink/15 bg-dark-900/60 p-10 text-center">
            <p className="font-semibold text-heading">No live exams right now</p>
            <p className="mt-1 text-sm text-neutral-400">
              There is no live exam right now. Please check back later.
            </p>
          </div>
        ) : (
          <div className="space-y-8">
            <section aria-label="Live Now">
              <h2 className="text-sm font-extrabold uppercase tracking-widest text-heading">Live Now</h2>
              <div className="mt-3 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                {liveExams.map((exam) => (
                  <ExamCard key={exam.id} exam={exam} />
                ))}
              </div>
            </section>
          </div>
        )}
      </div>
    </section>
  );
}
