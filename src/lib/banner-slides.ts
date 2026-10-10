import { unstable_cache } from "next/cache";
import { fetchActiveFeaturedSlugs } from "@/lib/featured-courses";
import { getLiveCourse } from "@/lib/course-catalog";
import { getPayableFee, formatFee } from "@/lib/courses";
import { fetchFeaturedPublicExams } from "@/lib/exams-admin";
import { fetchFeaturedJerseys } from "@/lib/content-admin";

export type BannerSlide = {
  id: string;
  image: string;
  href?: string;
  alt?: string;
  title?: string;
  subtitle?: string;
};

async function fetchBannerSlidesRaw(): Promise<BannerSlide[]> {
  const slides: BannerSlide[] = [];

  try {
    const slugs = await fetchActiveFeaturedSlugs();
    const courses = (
      await Promise.all(slugs.map((slug) => getLiveCourse(slug)))
    ).filter((course) => course !== undefined);

    for (const course of courses) {
      const payable = getPayableFee(course);
      if (!course.image) continue;
      slides.push({
        id: `featured-${course.slug}`,
        image: course.image,
        href: `/courses/${course.slug}`,
        title: course.name,
        subtitle:
          course.fee > 0
            ? `${course.category} · ${formatFee(payable)}`
            : course.category,
      });
    }
  } catch {
    // Featured courses are optional
  }

  try {
    const featuredExams = await fetchFeaturedPublicExams();
    for (const exam of featuredExams) {
      slides.push({
        id: `public-exam-${exam.id}`,
        image: exam.bannerUrl || "/banners/public-exam.svg",
        href: `/exam/${exam.id}`,
        title: exam.title,
        subtitle: "Public Exam",
      });
    }
  } catch {
    // Featured exams are optional
  }

  try {
    const featuredJerseys = await fetchFeaturedJerseys();
    for (const jersey of featuredJerseys) {
      slides.push({
        id: `jersey-${jersey.id}`,
        image: jersey.image || "/banners/jersey-of-medispark.svg",
        href: jersey.link || "#jerseys",
        title: jersey.name,
        subtitle: jersey.price > 0 ? `৳${jersey.price}` : "Jersey",
      });
    }
  } catch {
    // Featured jerseys are optional
  }

  return slides;
}

export const fetchBannerSlides = unstable_cache(
  fetchBannerSlidesRaw,
  ["banner-slides"],
  { tags: ["banner-slides", "featured-courses", "exams", "jerseys"] },
);
