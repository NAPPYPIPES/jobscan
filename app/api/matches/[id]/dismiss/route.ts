import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { matches } from "@/db/schema";
import type { DismissReason } from "@/db/schema";
import { requireOwner } from "@/lib/auth/viewer";

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

  const db = getDb();
  const updated = await db
    .update(matches)
    .set({
      status: "dismissed",
      dismissedAt: sql`now()`,
      dismissReason: reasons,
      updatedAt: sql`now()`,
    })
    .where(eq(matches.id, id))
    .returning({ id: matches.id });

  if (updated.length === 0) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ success: true });
}
