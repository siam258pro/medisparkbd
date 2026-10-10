import Link from "next/link";
import Image from "next/image";
import type { Course } from "@/lib/courses";
import { getBatch, formatFee, getPayableFee, hasDiscount } from "@/lib/courses";
import EnrollButton from "@/components/auth/EnrollButton";

/** batchId "ssc-29" → "SSC Batch 2029" (dynamic, from course data). */
function batchLabelText(course: Course): string {
  const match = /^(ssc|hsc)-(\d{2})$/i.exec(course.batchId.trim());
  if (match) {
    return `${match[1].toUpperCase()} Batch ${2000 + Number(match[2])}`;
  }
  // Unknown id shape — fall back to the configured batch label.
  return getBatch(course.batchId)?.label ?? "";
}

export default function CourseCard({ course }: { course: Course }) {
  const payableFee = getPayableFee(course);
  const discounted = hasDiscount(course);
  const showCoupon = course.couponEnabled && discounted;
  const categoryLabel = course.category;
  const batchLabel = batchLabelText(course);
  // Admin-managed Course Features (stored with the course, in admin order).
  const features = Array.isArray(course.examFeatures)
    ? course.examFeatures.filter((f) => typeof f === "string" && f.trim().length > 0)
    : [];

  return (
    <article className="group flex flex-col overflow-hidden rounded-2xl border border-ink/10 bg-dark-900 shadow-lg shadow-black/20 transition duration-300 hover:-translate-y-1 hover:border-primary-600/60 hover:shadow-primary-900/30">
      {/* Image area with dynamic category (left) + batch (right) labels */}
      <div className="relative aspect-[16/10] overflow-hidden">
        {course.image ? (
          <Image
            src={course.image}
            alt={course.name}
            fill
            sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
            className="object-cover transition duration-500 group-hover:scale-105"
          />
        ) : null}
        <div className="absolute inset-0 bg-gradient-to-t from-dark-950/70 via-dark-950/10 to-dark-950/30" />
        {categoryLabel && (
          <span className="absolute left-3 top-3 max-w-[55%] truncate rounded-lg border border-primary-500/40 bg-dark-950/80 px-2.5 py-1 text-[11px] font-bold text-primary-400 backdrop-blur">
            {categoryLabel}
          </span>
        )}
        {batchLabel && (
          <span className="absolute right-3 top-3 rounded-lg border border-ink/15 bg-dark-950/80 px-2.5 py-1 text-[11px] font-bold text-neutral-300 backdrop-blur">
            {batchLabel}
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col p-5">
        {/* Course name — prominent */}
        <h3 className="line-clamp-2 text-lg font-extrabold leading-snug text-heading transition group-hover:text-primary-400">
          {course.name}
        </h3>

        {/* Course Features — dynamic floating pills (admin-managed order).
            One line per pill, content-sized width, ~2 per row on wide cards. */}
        {features.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {features.map((feature, index) => (
              <span
                key={`${index}-${feature}`}
                className="w-auto max-w-full whitespace-nowrap rounded-full border border-ink/10 bg-dark-800 px-3.5 py-2 text-xs font-extrabold text-heading shadow-lg shadow-black/30"
              >
                <span className="block overflow-hidden text-ellipsis whitespace-nowrap">
                  {feature}
                </span>
              </span>
            ))}
          </div>
        )}

        {/* Fee ··· Coupon */}
        <div className="mt-4 flex items-center gap-2.5">
          <div className="flex items-baseline gap-1.5">
            {discounted && (
              <span className="text-xs font-semibold text-neutral-500 line-through">
                {formatFee(course.fee)}
              </span>
            )}
            <p className="text-xl font-extrabold text-primary-500">
              {formatFee(payableFee)}
            </p>
          </div>
          <span
            aria-hidden="true"
            className="h-0 flex-1 border-t-2 border-dotted border-ink/15"
          />
          {showCoupon ? (
            <span className="shrink-0 rounded-lg border border-primary-500/40 bg-primary-600/10 px-2.5 py-1 text-[11px] font-extrabold uppercase tracking-wide text-primary-400">
              Coupon
            </span>
          ) : null}
        </div>

        {/* Actions — same row */}
        <div className="mt-auto flex gap-3 pt-5">
          <Link
            href={`/courses/${course.slug}`}
            className="flex-1 rounded-xl border border-ink/15 bg-ink/5 px-4 py-2.5 text-center text-sm font-semibold text-heading transition hover:border-primary-500/60 hover:bg-ink/10 active:scale-[0.98]"
          >
            Course Details
          </Link>
          <EnrollButton course={course} />
        </div>
      </div>
    </article>
  );
}
