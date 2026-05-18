import { NextResponse } from "next/server";
import { dismissMatch } from "@/db/matches";
import type { DismissReason } from "@/db/schema";
import { getViewerUserId, requireOwner } from "@/lib/auth/viewer";

// PATCH /api/matches/{id}/dismiss
// body: { reasons?: DismissReason[] }
//
// Sets status='dismissed' (drives main-view visibility),
// dismissed_at=now() (analysis), and dismiss_reason (text[] — array
// of selected picker tags). One update keeps the main-view query
// (ne(status, 'dismissed')) working unchanged.
//
// reasons is multi-select (e.g. ['wrong_location', 'wrong_function']).
// Empty array or omitted body = null in DB.
const VALID_REASONS: DismissReason[] = [
  "wrong_function",
  "wrong_level",
  "wrong_company",
  "wrong_location",
  "not_interested",
];

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await requireOwner();
  if (denied) return denied;

  const { id } = await params;

  let body: unknown = {};
  try {
    const text = await req.text();
    if (text) body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const reasonsRaw = (body as { reasons?: unknown }).reasons;
  let reasons: DismissReason[] | null = null;
  if (reasonsRaw !== undefined && reasonsRaw !== null) {
    if (!Array.isArray(reasonsRaw)) {
      return NextResponse.json(
        { error: "reasons must be an array" },
        { status: 400 },
      );
    }
    for (const r of reasonsRaw) {
      if (typeof r !== "string" || !VALID_REASONS.includes(r as DismissReason)) {
        return NextResponse.json(
          { error: `each reason must be one of ${VALID_REASONS.join(", ")}` },
          { status: 400 },
        );
      }
    }
    const deduped = Array.from(new Set(reasonsRaw as DismissReason[]));
    reasons = deduped.length > 0 ? deduped : null;
  }

  const userId = await getViewerUserId();
  if (!userId) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const ok = await dismissMatch(userId, id, reasons);
  if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ success: true });
}
