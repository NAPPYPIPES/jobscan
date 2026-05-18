// POST /api/onboarding/targets/remove
// Body: { kind: "supported" | "manual", identifier: string }
//
// "supported"  → delete from user_targets by (user_id, target_slug).
// "manual"     → delete from user_manual_companies by
//                (user_id, manual_company_name).
//
// The global `targets` / `manual_companies` rows are NOT deleted
// even if this user was the only subscriber. Phase 4's scan
// garbage-collect step prunes orphan target rows at scan time.

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getViewerUserId } from "@/lib/auth/viewer";
import { getDb } from "@/db/client";
import { userManualCompanies, userTargets } from "@/db/schema";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const userId = await getViewerUserId();
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  let body: { kind?: unknown; identifier?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const identifier = typeof body.identifier === "string" ? body.identifier : "";
  if (!identifier) return NextResponse.json({ error: "identifier required" }, { status: 400 });

  const db = getDb();

  if (body.kind === "supported") {
    await db
      .delete(userTargets)
      .where(
        and(eq(userTargets.userId, userId), eq(userTargets.targetSlug, identifier)),
      );
    return NextResponse.json({ ok: true });
  }
  if (body.kind === "manual") {
    await db
      .delete(userManualCompanies)
      .where(
        and(
          eq(userManualCompanies.userId, userId),
          eq(userManualCompanies.manualCompanyName, identifier),
        ),
      );
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown kind" }, { status: 400 });
}
