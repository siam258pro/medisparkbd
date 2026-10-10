import { getCurrentYear } from "@/lib/student-categories";

export type Batch = {
  id: string;
  label: string;
};

export type CourseType =
  | "SSC Academic"
  | "HSC Academic"
  | "Medical Admission"
  | "Varsity Admission";

export type CourseCategory = CourseType;

export type CourseStatus = "published" | "unpublished";

export type CourseAvailability = "available" | "hidden";

export type CourseTeacher = {
  name: string;
  designation: string;
  photoUrl?: string;
};

export type CourseDetails = {
  duration?: string;
  description?: string;
  teachers?: CourseTeacher[];
  topics?: string[];
  chapterOverview?: string[];
};

export type Course = {
  slug: string;
  name: string;
  category: CourseCategory;
  batchId: string;
  image: string;
  shortDescription: string;
  description: string;
  teacherName: string;
  teacherPhoto: string;
  designation: string;
  duration: string;
  fee: number;
  discountFee: number | null;
  features: string[];
  examFeatures?: string[];
  overviewTitle: string;
  overview: string[];
  status: CourseStatus;
  availability: CourseAvailability;
  couponEnabled: boolean;
  /** Course-level Q&A access: ON (true) / OFF (false). */
  qaAccess?: boolean;
  /** Admin-entered totals (card display). */
  totalClasses?: number;
  totalExams?: number;
  /** Extended course details (Course Details section). */
  courseDetails?: CourseDetails;
  /** Course routine files (PDF / images) — per-course. */
  routineUrls?: string[];
};

export const batches: Batch[] = [
  { id: "hsc-28", label: "HSC 28" },
  { id: "hsc-27", label: "HSC 27" },
  { id: "hsc-26", label: "HSC 26" },
  { id: "ssc-28", label: "SSC 28" },
  { id: "ssc-27", label: "SSC 27" },
  { id: "ssc-26", label: "SSC 26" },
];

/** One batch-filter chip on a course category page. */
export type BatchFilterOption = { id: string; label: string };

export type BatchFilterScope = "ssc" | "hsc";

/** Running-year-relative years shown in course batch filters. */
export const BATCH_FILTER_YEAR_OFFSETS = [-1, 0, 1, 2, 3] as const;

/** Generate the built-in batch filters without changing catalog batch data. */
export function getBatchFilterOptions(
  scope: BatchFilterScope,
  currentYear = getCurrentYear(),
): BatchFilterOption[] {
  const labelPrefix = scope === "ssc" ? "SSC" : "HSC";
  return [
    { id: "all", label: "All Batch" },
    ...BATCH_FILTER_YEAR_OFFSETS.map((offset) => {
      const year = currentYear + offset;
      return {
        id: `${scope}-${String(year).slice(-2)}`,
        label: `${labelPrefix} ${year}`,
      };
    }),
  ];
}

/** Built-in defaults for callers that need both course filter scopes. */
export function getDefaultBatchFilterOptions(
  currentYear = getCurrentYear(),
): Record<BatchFilterScope, BatchFilterOption[]> {
  return {
    ssc: getBatchFilterOptions("ssc", currentYear),
    hsc: getBatchFilterOptions("hsc", currentYear),
  };
}

/** Backward-compatible snapshot for existing consumers. */
export const batchFilterOptions = getDefaultBatchFilterOptions();

export const courseTypes: CourseType[] = [
  "SSC Academic",
  "HSC Academic",
  "Medical Admission",
  "Varsity Admission",
];

export function getBatch(batchId: string): Batch | undefined {
  return batches.find((batch) => batch.id === batchId);
}

export function getPayableFee(course: Course): number {
  return course.discountFee != null ? course.discountFee : course.fee;
}

export function hasDiscount(course: Course): boolean {
  return course.discountFee != null && course.discountFee < course.fee;
}

export function formatFee(fee: number): string {
  return `৳ ${fee.toLocaleString("en-IN")}`;
}