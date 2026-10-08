import { NextRequest, NextResponse } from "next/server";
import { requireAnyPermission } from "@/lib/admin";
import { logAdminAction } from "@/lib/administration";
import {
  fetchPdfMaterials,
  fetchPdfMaterialById,
  savePdfMaterial,
  deletePdfMaterial,
} from "@/lib/pdf-materials";

export const dynamic = "force-dynamic";

// Drafts for the MCQ PDF Generator (separate from course chapter materials).
const PERMS = ["manageExams", "managePublicExam", "manageContent"] as const;

/** GET — ?id= loads one full draft (payload included); otherwise a light draft list. */
export async function GET(request: NextRequest) {
  const admin = await requireAnyPermission(request, [...PERMS]);
  if (!admin) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const idParam = request.nextUrl.searchParams.get("id");
  try {
    if (idParam) {
      const id = Number(idParam);
      if (!Number.isSafeInteger(id) || id <= 0) {
        return NextResponse.json({ error: "Invalid draft id." }, { status: 400 });
      }
      const material = await fetchPdfMaterialById(id);
      if (!material || !material.isActive) {
        return NextResponse.json({ error: "Draft not found." }, { status: 404 });
      }
      return NextResponse.json({ draft: material }, { headers: { "Cache-Control": "no-store" } });
    }
    const materials = await fetchPdfMaterials();
    return NextResponse.json(
      {
        drafts: materials.map((m) => ({
          id: m.id,
          title: m.title,
          subject: m.subject,
          questionCount: m.payload?.questions?.length ?? 0,
          updatedAt: m.updatedAt,
        })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load drafts.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** POST — create or update a draft from the generator (Generate PDF saves). */
export async function POST(request: NextRequest) {
  const admin = await requireAnyPermission(request, [...PERMS]);
  if (!admin) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || !Array.isArray(body.questions)) {
    return NextResponse.json({ error: "Missing draft questions." }, { status: 400 });
  }
  if (body.questions.length === 0) {
    return NextResponse.json({ error: "Nothing to save — add questions first." }, { status: 400 });
  }
  if (body.questions.length > 500) {
    return NextResponse.json({ error: "Too many questions in one draft (max 500)." }, { status: 400 });
  }
  try {
    const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 255) : "Untitled Material";
    const subtitle = typeof body.subtitle === "string" ? body.subtitle.trim().slice(0, 500) : "";
    const lineSpacing = body.lineSpacing;
    const saved = await savePdfMaterial(
      {
        id: body.id ?? null,
        title,
        subject: subtitle,
        payload: {
          header: {
            title,
            subject: subtitle,
            chapter: "",
            batch: "",
            institution: "",
            headerEnabled: true,
            showPageNumbers: true,
          },
          questions: body.questions,
          // Extra editor settings travel inside the payload (restored on Load).
          ...(typeof lineSpacing !== "undefined" ? { lineSpacing } : {}),
        },
      },
      (admin as unknown as { uid?: string })?.uid ?? null,
    );
    await logAdminAction(admin, "material.draft_save", `id=${saved.id} title=${saved.title}`, request);
    return NextResponse.json({ ok: true, id: saved.id, updatedAt: saved.updatedAt });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save draft.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/** DELETE — remove a draft (used automatically after a successful download). */
export async function DELETE(request: NextRequest) {
  const admin = await requireAnyPermission(request, [...PERMS]);
  if (!admin) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as { id?: unknown } | null;
  const idParam = request.nextUrl.searchParams.get("id");
  const id = Number(body?.id ?? idParam);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Missing draft id." }, { status: 400 });
  }
  try {
    await deletePdfMaterial(id);
    await logAdminAction(admin, "material.draft_delete", `id=${id}`, request);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to delete draft.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
