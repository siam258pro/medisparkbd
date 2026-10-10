import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/admin";
import {
  fetchAllFeaturedCourses,
  fetchActiveFeaturedSlugs,
  saveFeaturedCourses,
} from "@/lib/featured-courses";
import { cachedJson } from "@/lib/api-cache";

// Public content: edge-cached for fast loads (5min revalidation).
export const revalidate = 300;

export async function GET() {
  const slugs = await fetchActiveFeaturedSlugs();
  return cachedJson({ slugs }, "API_MEDIUM");
}

/** Replace the full featured list (select / toggle / reorder). */
export async function PUT(request: NextRequest) {
  if (!(await requirePermission(request, "manageCourses"))) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    courses?: unknown;
  } | null;

  if (!body || !Array.isArray(body.courses)) {
    return NextResponse.json(
      { error: "Invalid request body." },
      { status: 400 },
    );
  }

  try {
    const courses = await saveFeaturedCourses(
      body.courses as Array<Record<string, unknown>>,
    );
    return NextResponse.json({ courses });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to save the featured courses.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
