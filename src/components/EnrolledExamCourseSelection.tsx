"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { useVisibleInterval } from "@/lib/use-visible-interval";
import { AccessLoading, AccessMessage } from "@/components/auth/AccessGuard";
import type { EnrolledExamCourse } from "@/lib/enrolled-exams";

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

  return (
    <section className={`mx-auto max-w-6xl px-4 sm:px-6 ${embedded ? "py-4" : "py-8 sm:py-12"}`}>
      {embedded ? null : (
        <Link href="/exam" className="text-sm font-semibold text-primary-400 hover:text-primary-300">← Explore Public Exams</Link>
      )}
      <h1 className={`${embedded ? "mt-0" : "mt-5"} text-2xl font-extrabold text-heading sm:text-3xl`}>My Enrolled Exams</h1>
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
